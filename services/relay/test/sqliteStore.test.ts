/**
 * Durability tests for SqliteRelayStore — the honest proof that the relay no
 * longer loses queued store-and-forward traffic on restart (the production gap
 * MemoryRelayStore had). No mocks: a real on-disk SQLite file is written,
 * closed, reopened, and — in the integration test — a real node:http relay is
 * rebooted with two real RelayTransports exchanging a frame across the restart.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	generateIdentity,
	RelayTransport,
	FrameType,
	utf8,
	fromUtf8,
	type Frame,
	type IncomingFrame,
} from "../../../packages/core/src/index.ts";
import { NodeCryptoProvider } from "../../../packages/core/src/crypto/nodeProvider.ts";
import { SqliteRelayStore } from "../src/sqliteStore.ts";
import type { StoredMessage } from "../src/index.ts";
import { startRelayServer } from "../src/serverMain.ts";

function msg(over: Partial<StoredMessage> & { id: string; dst: string }): StoredMessage {
	return {
		prio: "normal",
		receivedAt: 1000,
		expiresAt: 9_999_999_999,
		blob: utf8(`blob-${over.id}`),
		...over,
	};
}

test("SqliteRelayStore persists queued messages across reopen", () => {
	const dir = mkdtempSync(join(tmpdir(), "relay-db-"));
	const path = join(dir, "relay.db");
	try {
		const s1 = new SqliteRelayStore(path);
		s1.put(msg({ id: "a", dst: "bob", receivedAt: 200 }));
		s1.put(msg({ id: "b", dst: "bob", receivedAt: 100, prio: "sos" }));
		s1.put(msg({ id: "c", dst: "carol" }));
		assert.equal(s1.total(), 3);
		s1.close(); // flush WAL to disk

		// Reopen a brand-new handle on the same file: data must still be there.
		const s2 = new SqliteRelayStore(path);
		assert.equal(s2.total(), 3, "all rows survived restart");
		assert.ok(s2.has("a"));
		assert.equal(s2.countFor("bob", 0), 2);

		const forBob = s2.listFor("bob", 10, 0);
		assert.equal(forBob.length, 2);
		assert.equal(forBob[0]!.id, "b", "SOS ordered first");
		assert.equal(forBob[1]!.id, "a");
		assert.equal(fromUtf8(forBob[0]!.blob), "blob-b", "blob bytes round-tripped");

		assert.equal(s2.deleteByIds("bob", ["a"]), 1);
		assert.equal(s2.countFor("bob", 0), 1);
		assert.equal(s2.pruneExpired(5000), 0, "nothing expired yet");
		s2.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("expired messages are filtered and pruned", () => {
	const store = new SqliteRelayStore(":memory:");
	store.put(msg({ id: "live", dst: "x", expiresAt: 5000 }));
	store.put(msg({ id: "dead", dst: "x", expiresAt: 1000 }));
	assert.equal(store.countFor("x", 3000), 1, "expired excluded from count");
	assert.equal(store.listFor("x", 10, 3000).length, 1);
	assert.equal(store.pruneExpired(3000), 1, "one expired row pruned");
	assert.equal(store.total(), 1);
	store.close();
});

test("a real relay reboot does not drop a queued frame", async () => {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const dir = mkdtempSync(join(tmpdir(), "relay-srv-"));
	const dbPath = join(dir, "mailbox.db");
	try {
		const alice = await generateIdentity(crypto);
		const bob = await generateIdentity(crypto);

		// --- boot #1: alice queues a frame for bob, then the relay goes down ---
		const s1 = await startRelayServer({ dbPath, port: 0, sweepMs: 3_600_000 });
		const url1 = `http://127.0.0.1:${s1.port}`;
		const aliceT = new RelayTransport({ relayUrl: url1, identity: alice, crypto, pollIntervalMs: 0 });
		const bobT1 = new RelayTransport({ relayUrl: url1, identity: bob, crypto, pollIntervalMs: 0 });
		await bobT1.start(); // bob registers so alice can roster him
		await aliceT.start();
		await aliceT.poll(); // alice now sees bob in the roster
		const frame: Frame = { type: FrameType.MSG, payload: utf8("survive the reboot") };
		await aliceT.send(frame, bob.nodeId); // stored on the relay; bob never pulled it
		aliceT.stop();
		bobT1.stop();
		await s1.close(); // <-- relay process "crashes"/restarts here

		// --- boot #2: same db file, brand-new server + core (in-memory roster lost) ---
		const s2 = await startRelayServer({ dbPath, port: 0, sweepMs: 3_600_000 });
		const url2 = `http://127.0.0.1:${s2.port}`;
		const received: IncomingFrame[] = [];
		const bobT2 = new RelayTransport({ relayUrl: url2, identity: bob, crypto, pollIntervalMs: 0 });
		bobT2.onFrame((m) => {
			received.push(m);
		});
		await bobT2.start(); // bob re-registers on the rebooted relay
		await bobT2.poll(); // pulls the durable mailbox

		assert.equal(received.length, 1, "queued frame survived the relay restart");
		assert.equal(received[0]!.from, alice.nodeId);
		assert.equal(fromUtf8(received[0]!.frame.payload), "survive the reboot");
		bobT2.stop();
		await s2.close();
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
