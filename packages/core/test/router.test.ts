import { test } from "node:test";
import assert from "node:assert/strict";
import { Router } from "../src/router.ts";
import { DedupCache } from "../src/dedup.ts";
import type { Envelope, Header } from "../src/types.ts";
import { PROTOCOL_VERSION } from "../src/types.ts";

function env(src: string, dst: string, id: string, hop: number, hopLimit = 3): Envelope {
	const header: Header = {
		v: PROTOCOL_VERSION,
		id,
		traceId: "t",
		src,
		dst,
		ts: 0,
		ttlMs: 60_000,
		hopLimit,
		hop,
		prio: "normal",
		mode: "flood",
		payloadHash: new Uint8Array(32),
		chunkIndex: 0,
		chunkCount: 1,
	};
	return {
		header,
		srcSignPub: new Uint8Array(32),
		ephPub: new Uint8Array(32),
		nonce: new Uint8Array(12),
		cipher: new Uint8Array(0),
		sig: new Uint8Array(64),
	};
}

function mkRouter(selfId: string, suppression = 2) {
	const dedup = new DedupCache({ maxEntries: 1000, ttlMs: 60_000 });
	const r = new Router(
		{ selfId, contentionMinMs: 10, contentionMaxMs: 10, suppressionThreshold: suppression, rand: () => 0 },
		dedup,
	);
	return r;
}

test("delivers to destination, marks later copies duplicate", () => {
	const r = mkRouter("me");
	const d1 = r.onReceive(env("alice", "me", "m1", 1), 0);
	assert.equal(d1.type, "deliver");
	if (d1.type === "deliver") assert.equal(d1.duplicate, false);
	const d2 = r.onReceive(env("alice", "me", "m1", 1), 1);
	assert.equal(d2.type, "deliver");
	if (d2.type === "deliver") assert.equal(d2.duplicate, true);
});

test("first relay copy schedules a single rebroadcast", () => {
	const r = mkRouter("me");
	const d = r.onReceive(env("alice", "bob", "m2", 1), 0);
	assert.equal(d.type, "rebroadcast");
	if (d.type === "rebroadcast") {
		assert.ok(d.delayMs >= 10);
		assert.equal(r.onRebroadcastDue(d.key), true); // heard 0 duplicates -> send
	}
});

test("suppresses rebroadcast after hearing enough duplicates", () => {
	const r = mkRouter("me", 2);
	const d = r.onReceive(env("alice", "bob", "m3", 1), 0);
	assert.equal(d.type, "rebroadcast");
	if (d.type !== "rebroadcast") return;
	// Two neighbors relay the same packet during our contention window.
	r.onReceive(env("alice", "bob", "m3", 2), 1);
	r.onReceive(env("alice", "bob", "m3", 2), 2);
	assert.equal(r.onRebroadcastDue(d.key), false); // storm avoided
});

test("drops at hop limit (depth bound even if hop is reset by attacker)", () => {
	const r = mkRouter("me");
	const d = r.onReceive(env("alice", "bob", "m4", 3, 3), 0);
	assert.equal(d.type, "drop");
	if (d.type === "drop") assert.equal(d.reason, "hop-limit");
});
