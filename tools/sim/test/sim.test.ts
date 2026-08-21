/**
 * Simulation property tests. These assert the PROTOCOL's emergent behaviour
 * (not just unit pieces): multi-hop delivery, controlled-flood storm bounds,
 * partition healing via epidemic store-and-forward, SOS priority under
 * congestion, and chunk reassembly across multiple hops — all in deterministic
 * virtual time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fromUtf8, utf8 } from "../../../packages/core/src/index.ts";
import { buildNetwork, fullyConnected, lineTopology } from "../src/harness.ts";

test("line topology: message traverses every hop and is delivered once", async () => {
	const net = await buildNetwork({ n: 6, seed: 1 });
	lineTopology(net);
	await net.clock.run();
	const src = net.nodes[0]!;
	const dst = net.nodes[5]!;
	// 5-hop path: needs a TTL above the default hop limit (3). MAX_HOP_LIMIT is 7.
	const traceId = await src.engine.send(dst.id, utf8("hello across the mesh"), { hopLimit: 7 });
	net.metrics.recordSend(traceId, net.clock.now());
	await net.clock.run();
	assert.equal(dst.received.length, 1);
	assert.equal(fromUtf8(dst.received[0]!.plaintext), "hello across the mesh");
	assert.equal(dst.received[0]!.from, src.id);
});

test("controlled flooding bounds transmissions in a dense cluster", async () => {
	const net = await buildNetwork({ n: 10, seed: 7 });
	fullyConnected(net);
	await net.clock.run(); // settle HELLO exchange
	const before = net.medium.stats.transmissions;
	const src = net.nodes[0]!;
	const dst = net.nodes[9]!;
	await src.engine.send(dst.id, utf8("flood me"));
	await net.clock.run();
	const used = net.medium.stats.transmissions - before;
	assert.equal(dst.received.length, 1);
	// Naive flooding would be O(n^2); managed flooding + dedup keeps it ~O(n).
	assert.ok(used <= 2 * net.nodes.length, `expected <= ${2 * net.nodes.length} transmissions, got ${used}`);
});

test("epidemic store-and-forward recovers across a healed partition", async () => {
	const net = await buildNetwork({ n: 4, seed: 3 });
	// Two islands: {0,1} and {2,3}; no bridge yet.
	net.medium.linkUp(net.nodes[0]!.id, net.nodes[1]!.id);
	net.medium.linkUp(net.nodes[2]!.id, net.nodes[3]!.id);
	await net.clock.run();
	const src = net.nodes[0]!;
	const dst = net.nodes[3]!;
	const traceId = await src.engine.send(dst.id, utf8("reach the other island"));
	net.metrics.recordSend(traceId, net.clock.now());
	await net.clock.run();
	assert.equal(dst.received.length, 0, "must not be delivered while partitioned");
	// Mobility heals the partition: node 1 meets node 2.
	net.medium.linkUp(net.nodes[1]!.id, net.nodes[2]!.id);
	await net.clock.run();
	assert.equal(dst.received.length, 1, "delivered after partition heals");
	assert.equal(fromUtf8(dst.received[0]!.plaintext), "reach the other island");
});

test("SOS is delivered under RED congestion while bulk is suppressed", async () => {
	const net = await buildNetwork({ n: 2, seed: 5, queueCapacity: 3 });
	net.medium.linkUp(net.nodes[0]!.id, net.nodes[1]!.id);
	await net.clock.run();
	const src = net.nodes[0]!;
	const dst = net.nodes[1]!;
	// Saturate the local queue with bulk traffic to drive congestion to RED.
	for (let i = 0; i < 8; i++) await src.engine.send(dst.id, utf8(`bulk-${i}`), { prio: "bulk" });
	await net.clock.run();
	assert.ok(net.metrics.suppressed > 0, "some bulk traffic should be congestion-suppressed");
	const sosTrace = await src.engine.sendSos(dst.id, "SOS need help");
	net.metrics.recordSend(sosTrace, net.clock.now());
	await net.clock.run();
	const gotSos = dst.received.some((m) => m.prio === "sos" && fromUtf8(m.plaintext) === "SOS need help");
	assert.ok(gotSos, "SOS must punch through congestion");
});

test("chunked payload reassembles correctly across multiple hops", async () => {
	const net = await buildNetwork({ n: 5, seed: 9, maxChunkBytes: 16 });
	lineTopology(net);
	await net.clock.run();
	const src = net.nodes[0]!;
	const dst = net.nodes[4]!;
	const payload = "X".repeat(100) + "-END";
	await src.engine.send(dst.id, utf8(payload));
	await net.clock.run();
	assert.equal(dst.received.length, 1);
	assert.equal(fromUtf8(dst.received[0]!.plaintext), payload);
});
