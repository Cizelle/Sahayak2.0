/**
 * Benchmark runner. Produces the real, reproducible numbers quoted in
 * EVALUATION.md. Run with: `node --import tsx tools/sim/src/bench.ts`.
 * Writes a machine-readable summary to tools/sim/results.json as well.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { utf8 } from "../../../packages/core/src/index.ts";
import { buildNetwork, fullyConnected, lineTopology, mean, percentile, randomGraph, type Network } from "./harness.ts";

interface ScenarioResult {
	scenario: string;
	nodes: number;
	sent: number;
	delivered: number;
	deliveryRatio: number;
	airTransmissions: number;
	txPerDelivered: number;
	latencyMeanMs: number;
	latencyP95Ms: number;
}

function summarize(scenario: string, net: Network, sent: number): ScenarioResult {
	const lat = net.metrics.latencies();
	const delivered = net.metrics.delivered;
	return {
		scenario,
		nodes: net.nodes.length,
		sent,
		delivered,
		deliveryRatio: sent ? +(delivered / sent).toFixed(3) : 0,
		airTransmissions: net.medium.stats.transmissions,
		txPerDelivered: delivered ? +(net.medium.stats.transmissions / delivered).toFixed(2) : 0,
		latencyMeanMs: +mean(lat).toFixed(1),
		latencyP95Ms: +percentile(lat, 95).toFixed(1),
	};
}

async function multiHopLine(): Promise<ScenarioResult> {
	const net = await buildNetwork({ n: 8, seed: 11, medium: { lossRate: 0, minDelayMs: 5, maxDelayMs: 20 } });
	lineTopology(net);
	await net.clock.run();
	let sent = 0;
	for (let i = 0; i < 8; i++) {
		const src = net.nodes[0]!;
		const dst = net.nodes[7]!;
		// 7-hop path along the line; raise TTL above the default (3) up to MAX_HOP_LIMIT (7).
		const tr = await src.engine.send(dst.id, utf8(`msg-${i}`), { hopLimit: 7 });
		net.metrics.recordSend(tr, net.clock.now());
		sent++;
		await net.clock.run();
	}
	return summarize("8-node line / 7 hops (0% loss)", net, sent);
}

async function denseStorm(): Promise<ScenarioResult> {
	const net = await buildNetwork({ n: 16, seed: 13 });
	fullyConnected(net);
	await net.clock.run();
	const src = net.nodes[0]!;
	const dst = net.nodes[15]!;
	const before = net.medium.stats.transmissions;
	const tr = await src.engine.send(dst.id, utf8("broadcast once"));
	net.metrics.recordSend(tr, net.clock.now());
	await net.clock.run();
	const r = summarize("16-node dense cluster (single msg)", net, 1);
	r.airTransmissions = net.medium.stats.transmissions - before; // exclude HELLO setup
	r.txPerDelivered = +(r.airTransmissions / Math.max(1, net.metrics.delivered)).toFixed(2);
	return r;
}

async function lossyRandom(): Promise<ScenarioResult> {
	const net = await buildNetwork({ n: 20, seed: 17, medium: { lossRate: 0.15, minDelayMs: 5, maxDelayMs: 30 } });
	randomGraph(net, 0.35, 101);
	await net.clock.run();
	let sent = 0;
	for (let i = 0; i < 20; i++) {
		const src = net.nodes[i % net.nodes.length]!;
		const dst = net.nodes[(i * 7 + 3) % net.nodes.length]!;
		if (src.id === dst.id) continue;
		const tr = await src.engine.send(dst.id, utf8(`r-${i}`));
		net.metrics.recordSend(tr, net.clock.now());
		sent++;
	}
	await net.clock.run();
	return summarize("20-node random graph (15% link loss)", net, sent);
}

async function partitionRecovery(): Promise<ScenarioResult> {
	const net = await buildNetwork({ n: 6, seed: 19 });
	net.medium.linkUp(net.nodes[0]!.id, net.nodes[1]!.id);
	net.medium.linkUp(net.nodes[1]!.id, net.nodes[2]!.id);
	net.medium.linkUp(net.nodes[3]!.id, net.nodes[4]!.id);
	net.medium.linkUp(net.nodes[4]!.id, net.nodes[5]!.id);
	await net.clock.run();
	let sent = 0;
	for (let i = 0; i < 3; i++) {
		// 5-hop end-to-end once bridged; raise TTL above the default (3).
		const tr = await net.nodes[0]!.engine.send(net.nodes[5]!.id, utf8(`part-${i}`), { hopLimit: 7 });
		net.metrics.recordSend(tr, net.clock.now());
		sent++;
	}
	await net.clock.run();
	// Heal: node 2 meets node 3.
	net.medium.linkUp(net.nodes[2]!.id, net.nodes[3]!.id);
	await net.clock.run();
	return summarize("partition heal (2 islands -> bridged)", net, sent);
}

async function main(): Promise<void> {
	const results = [await multiHopLine(), await denseStorm(), await lossyRandom(), await partitionRecovery()];
	const header = ["scenario", "nodes", "sent", "delivered", "ratio", "airTx", "tx/deliv", "latMean", "latP95"];
	console.log(header.join("\t"));
	for (const r of results) {
		console.log(
			[
				r.scenario,
				r.nodes,
				r.sent,
				r.delivered,
				r.deliveryRatio,
				r.airTransmissions,
				r.txPerDelivered,
				r.latencyMeanMs,
				r.latencyP95Ms,
			].join("\t"),
		);
	}
	const outPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "results.json");
	writeFileSync(outPath, JSON.stringify({ generatedBy: "adaptivemesh sim bench", results }, null, 2));
	console.log(`\nWrote ${outPath}`);
}

void main();
