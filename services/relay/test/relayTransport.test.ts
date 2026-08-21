/**
 * RelayTransport integration test — the honest proof that the Internet tier
 * REALLY discovers peers and delivers frames. It stands up a genuine RelayCore
 * behind the zero-dependency node:http server and runs two RelayTransports
 * against it over real loopback HTTP (Node's global fetch). No mocks, no stubs.
 *
 * Lives in the relay package because it wires the relay server to the core
 * transport; both are real, exercising the exact request-signing contract the
 * phone uses.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
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
import { MemoryRelayStore, RelayCore, createRelayHttpServer } from "../src/index.ts";

async function listen(): Promise<{ url: string; close: () => Promise<void> }> {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const core = new RelayCore(crypto, new MemoryRelayStore(), { now: () => Date.now() });
	const server = createRelayHttpServer(core);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return {
		url: `http://127.0.0.1:${port}`,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

test("two RelayTransports discover each other and exchange a frame over real HTTP", async () => {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const { url, close } = await listen();
	try {
		const alice = await generateIdentity(crypto);
		const bob = await generateIdentity(crypto);

		const aliceSaw: string[] = [];
		const bobSaw: string[] = [];
		const bobFrames: IncomingFrame[] = [];

		const at = new RelayTransport({ relayUrl: url, identity: alice, crypto, pollIntervalMs: 0 });
		const bt = new RelayTransport({ relayUrl: url, identity: bob, crypto, pollIntervalMs: 0 });
		at.onNeighbor((p, up) => {
			if (up) aliceSaw.push(p);
		});
		bt.onNeighbor((p, up) => {
			if (up) bobSaw.push(p);
		});
		bt.onFrame((m) => {
			bobFrames.push(m);
		});

		await at.start(); // registers + first roster (sees nobody yet)
		await bt.start(); // registers + roster (now sees alice)
		await at.poll(); // alice re-polls, now sees bob

		assert.ok(aliceSaw.includes(bob.nodeId), "alice discovered bob via roster");
		assert.ok(bobSaw.includes(alice.nodeId), "bob discovered alice via roster");
		assert.equal(at.neighbors().length, 1);

		const frame: Frame = { type: FrameType.MSG, payload: utf8("hello over the internet tier") };
		await at.send(frame, bob.nodeId);
		await bt.poll();

		assert.equal(bobFrames.length, 1, "bob received exactly one frame");
		assert.equal(bobFrames[0]!.from, alice.nodeId, "frame attributed to alice's node id");
		assert.equal(bobFrames[0]!.frame.type, FrameType.MSG);
		assert.equal(fromUtf8(bobFrames[0]!.frame.payload), "hello over the internet tier");

		at.stop();
		bt.stop();
	} finally {
		await close();
	}
});

test("broadcast send reaches every rostered peer", async () => {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const { url, close } = await listen();
	try {
		const hub = await generateIdentity(crypto);
		const p1 = await generateIdentity(crypto);
		const p2 = await generateIdentity(crypto);
		const f1: IncomingFrame[] = [];
		const f2: IncomingFrame[] = [];

		const hubT = new RelayTransport({ relayUrl: url, identity: hub, crypto, pollIntervalMs: 0 });
		const t1 = new RelayTransport({ relayUrl: url, identity: p1, crypto, pollIntervalMs: 0 });
		const t2 = new RelayTransport({ relayUrl: url, identity: p2, crypto, pollIntervalMs: 0 });
		t1.onFrame((m) => {
			f1.push(m);
		});
		t2.onFrame((m) => {
			f2.push(m);
		});

		await t1.start();
		await t2.start();
		await hubT.start(); // hub now rosters both p1 and p2
		assert.equal(hubT.neighbors().length, 2);

		await hubT.send({ type: FrameType.MSG, payload: utf8("broadcast") }); // no peer => all
		await t1.poll();
		await t2.poll();

		assert.equal(f1.length, 1);
		assert.equal(f2.length, 1);
		assert.equal(fromUtf8(f1[0]!.frame.payload), "broadcast");
		assert.equal(fromUtf8(f2[0]!.frame.payload), "broadcast");

		hubT.stop();
		t1.stop();
		t2.stop();
	} finally {
		await close();
	}
});
