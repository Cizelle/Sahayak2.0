/**
 * Relay tests — authentication, abuse control, idempotency, SOS retention,
 * TTL expiry, zero-knowledge property, and an end-to-end HTTP round-trip.
 * All deterministic via an injected clock; no wall-clock, no network mocks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AddressInfo } from "node:net";
import { generateIdentity, utf8, type CryptoProvider, type SecretIdentity } from "../../../packages/core/src/index.ts";
import { NodeCryptoProvider } from "../../../packages/core/src/crypto/nodeProvider.ts";
import {
	MemoryRelayStore,
	RelayCore,
	DEFAULT_RELAY_CONFIG,
	bodyHashSubmit,
	bodyHashPull,
	bodyHashAck,
	signAuth,
	createRelayHttpServer,
	type RelayConfig,
	type RelayPriority,
	type SubmitResult,
} from "../src/index.ts";

// Deterministic, movable clock.
function makeClock(start = 1_700_000_000_000) {
	let t = start;
	return { now: () => t, advance: (ms: number) => (t += ms), set: (v: number) => (t = v) };
}

let nonceSeq = 0;
const nextNonce = () => `nonce-${nonceSeq++}`;

async function freshNode(crypto: CryptoProvider, core: RelayCore): Promise<SecretIdentity> {
	const id = await generateIdentity(crypto);
	const r = await core.register({ nodeId: id.nodeId, signPub: id.signPub });
	assert.equal(r.ok, true);
	return id;
}

async function submit(
	crypto: CryptoProvider,
	core: RelayCore,
	sender: SecretIdentity,
	dst: string,
	text: string,
	id: string,
	prio: RelayPriority,
	now: number,
	opts: { nonce?: string; tamper?: boolean } = {},
): Promise<SubmitResult> {
	const blob = utf8(text); // stand-in for an opaque AEAD ciphertext envelope
	const bh = await bodyHashSubmit(crypto, dst, id, prio, blob);
	const auth = await signAuth(crypto, sender.signSeed, "submit", sender.nodeId, now, opts.nonce ?? nextNonce(), bh);
	if (opts.tamper) auth.sig[0] = (auth.sig[0] ?? 0) ^ 0xff;
	return core.submit({ auth, dst, id, blob, prio });
}

test("register: node ids are self-certifying; mismatched id is rejected", async () => {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const core = new RelayCore(crypto, new MemoryRelayStore(), makeClock());
	const a = await generateIdentity(crypto);
	const b = await generateIdentity(crypto);

	assert.deepEqual(await core.register({ nodeId: a.nodeId, signPub: a.signPub }), { ok: true });
	// Idempotent re-register with the same key is fine.
	assert.deepEqual(await core.register({ nodeId: a.nodeId, signPub: a.signPub }), { ok: true });
	// A node id IS hash(signPub), so claiming an id that does not match the key
	// is rejected outright (key-substitution is caught at the contact/TOFU layer
	// on the nodes themselves, see engine signPin).
	const spoof = await core.register({ nodeId: b.nodeId, signPub: a.signPub });
	assert.equal(spoof.ok === false && spoof.error, "bad-node-id");
});

test("submit + pull + ack round-trip; idempotent re-submit", async () => {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const clock = makeClock();
	const core = new RelayCore(crypto, new MemoryRelayStore(), clock);
	const alice = await freshNode(crypto, core);
	const bob = await freshNode(crypto, core);

	const r1 = await submit(crypto, core, alice, bob.nodeId, "hi bob", "m1", "normal", clock.now());
	assert.deepEqual(r1, { ok: true, duplicate: false });
	// Same id again => idempotent duplicate, not a second copy.
	const r2 = await submit(crypto, core, alice, bob.nodeId, "hi bob", "m1", "normal", clock.now());
	assert.deepEqual(r2, { ok: true, duplicate: true });

	// Bob pulls.
	const bhp = await bodyHashPull(crypto, 64);
	const pullAuth = await signAuth(crypto, bob.signSeed, "pull", bob.nodeId, clock.now(), nextNonce(), bhp);
	const pull = await core.pull({ auth: pullAuth, limit: 64 });
	assert.equal(pull.ok, true);
	assert.equal(pull.ok === true && pull.messages.length, 1);
	assert.equal(pull.ok === true && pull.messages[0]!.id, "m1");

	// Bob acks => mailbox drains.
	const bha = await bodyHashAck(crypto, ["m1"]);
	const ackAuth = await signAuth(crypto, bob.signSeed, "ack", bob.nodeId, clock.now(), nextNonce(), bha);
	const ack = await core.ack({ auth: ackAuth, ids: ["m1"] });
	assert.deepEqual(ack, { ok: true, deleted: 1 });
	assert.equal(core.stats().stored, 0);
});

test("auth: tampered signature, stale timestamp, and nonce replay are rejected", async () => {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const clock = makeClock();
	const core = new RelayCore(crypto, new MemoryRelayStore(), clock);
	const alice = await freshNode(crypto, core);
	const bob = await freshNode(crypto, core);

	// Tampered signature.
	const bad = await submit(crypto, core, alice, bob.nodeId, "x", "t1", "normal", clock.now(), { tamper: true });
	assert.equal(bad.ok === false && bad.error, "bad-signature");

	// Stale timestamp (beyond skew window).
	const stale = await submit(
		crypto,
		core,
		alice,
		bob.nodeId,
		"x",
		"t2",
		"normal",
		clock.now() - DEFAULT_RELAY_CONFIG.skewWindowMs - 1,
	);
	assert.equal(stale.ok === false && stale.error, "stale-request");

	// Nonce replay: reuse the same nonce twice.
	const n = nextNonce();
	const first = await submit(crypto, core, alice, bob.nodeId, "x", "t3", "normal", clock.now(), { nonce: n });
	assert.equal(first.ok, true);
	const replay = await submit(crypto, core, alice, bob.nodeId, "y", "t4", "normal", clock.now(), { nonce: n });
	assert.equal(replay.ok === false && replay.error, "replayed-nonce");
});

test("abuse: payload size, mailbox quota, and rate limiting", async () => {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const clock = makeClock();
	const cfg: RelayConfig = {
		...DEFAULT_RELAY_CONFIG,
		maxBlobBytes: 32,
		maxPerDst: 2,
		rateCapacity: 100,
		rateRefillPerSec: 1,
	};
	const core = new RelayCore(crypto, new MemoryRelayStore(), clock, cfg);
	const alice = await freshNode(crypto, core);
	const bob = await freshNode(crypto, core);

	// Oversized payload.
	const big = await submit(crypto, core, alice, bob.nodeId, "x".repeat(64), "b1", "normal", clock.now());
	assert.equal(big.ok === false && big.error, "payload-too-large");

	// Fill the mailbox (maxPerDst = 2), third normal msg rejected, but SOS bypasses.
	assert.equal((await submit(crypto, core, alice, bob.nodeId, "a", "q1", "normal", clock.now())).ok, true);
	assert.equal((await submit(crypto, core, alice, bob.nodeId, "b", "q2", "normal", clock.now())).ok, true);
	const full = await submit(crypto, core, alice, bob.nodeId, "c", "q3", "normal", clock.now());
	assert.equal(full.ok === false && full.error, "mailbox-full");
	const sos = await submit(crypto, core, alice, bob.nodeId, "SOS", "q4", "sos", clock.now());
	assert.equal(sos.ok, true);

	// Rate limiting: a fresh sender with capacity 2 and no refill (clock frozen).
	const cfg2: RelayConfig = { ...DEFAULT_RELAY_CONFIG, rateCapacity: 2, rateRefillPerSec: 0, maxPerDst: 1000 };
	const core2 = new RelayCore(crypto, new MemoryRelayStore(), clock, cfg2);
	const carol = await freshNode(crypto, core2);
	const dave = await freshNode(crypto, core2);
	assert.equal((await submit(crypto, core2, carol, dave.nodeId, "1", "r1", "normal", clock.now())).ok, true);
	assert.equal((await submit(crypto, core2, carol, dave.nodeId, "2", "r2", "normal", clock.now())).ok, true);
	const limited = await submit(crypto, core2, carol, dave.nodeId, "3", "r3", "normal", clock.now());
	assert.equal(limited.ok === false && limited.error, "rate-limited");
});

test("SOS sorts ahead of normal on pull, and TTL expiry removes messages", async () => {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const clock = makeClock();
	const core = new RelayCore(crypto, new MemoryRelayStore(), clock);
	const alice = await freshNode(crypto, core);
	const bob = await freshNode(crypto, core);

	await submit(crypto, core, alice, bob.nodeId, "normal-1", "n1", "normal", clock.now());
	await submit(crypto, core, alice, bob.nodeId, "sos-1", "s1", "sos", clock.now());

	const bhp = await bodyHashPull(crypto, 64);
	const pullAuth = await signAuth(crypto, bob.signSeed, "pull", bob.nodeId, clock.now(), nextNonce(), bhp);
	const pull = await core.pull({ auth: pullAuth, limit: 64 });
	assert.equal(pull.ok === true && pull.messages[0]!.prio, "sos"); // SOS first

	// Advance past the normal retention but within SOS retention.
	clock.advance(DEFAULT_RELAY_CONFIG.retentionMs + 1);
	const bhp2 = await bodyHashPull(crypto, 64);
	const pullAuth2 = await signAuth(crypto, bob.signSeed, "pull", bob.nodeId, clock.now(), nextNonce(), bhp2);
	const pull2 = await core.pull({ auth: pullAuth2, limit: 64 });
	assert.equal(pull2.ok === true && pull2.messages.length, 1); // only SOS survives
	assert.equal(pull2.ok === true && pull2.messages[0]!.id, "s1");
});

test("zero-knowledge: relay stores the exact opaque blob and never a key", async () => {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const clock = makeClock();
	const core = new RelayCore(crypto, new MemoryRelayStore(), clock);
	const alice = await freshNode(crypto, core);
	const bob = await freshNode(crypto, core);

	const secret = utf8("ciphertext-bytes-the-relay-cannot-read");
	const bh = await bodyHashSubmit(crypto, bob.nodeId, "z1", "normal", secret);
	const auth = await signAuth(crypto, alice.signSeed, "submit", alice.nodeId, clock.now(), nextNonce(), bh);
	await core.submit({ auth, dst: bob.nodeId, id: "z1", blob: secret, prio: "normal" });

	const bhp = await bodyHashPull(crypto, 64);
	const pullAuth = await signAuth(crypto, bob.signSeed, "pull", bob.nodeId, clock.now(), nextNonce(), bhp);
	const pull = await core.pull({ auth: pullAuth, limit: 64 });
	assert.equal(pull.ok, true);
	// The relay round-trips the blob byte-for-byte; it had no kex key to decrypt.
	assert.deepEqual(pull.ok === true && [...pull.messages[0]!.blob], [...secret]);
	// Serialized core state contains no "kexScalar"/private material.
	assert.equal(JSON.stringify(core).includes("kexScalar"), false);
});

test("http: end-to-end submit/pull over the node:http reference server", async () => {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const clock = makeClock();
	const core = new RelayCore(crypto, new MemoryRelayStore(), clock);
	const alice = await generateIdentity(crypto);
	const bob = await generateIdentity(crypto);

	const server = createRelayHttpServer(core);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	const base = `http://127.0.0.1:${port}`;
	const post = async (path: string, body: unknown) => {
		const res = await fetch(base + path, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return res.json() as Promise<any>;
	};
	const toB64 = (u: Uint8Array) => Buffer.from(u).toString("base64");

	try {
		assert.equal((await post("/register", { nodeId: alice.nodeId, signPub: toB64(alice.signPub) })).ok, true);
		assert.equal((await post("/register", { nodeId: bob.nodeId, signPub: toB64(bob.signPub) })).ok, true);

		const blob = utf8("hello-over-http");
		const bh = await bodyHashSubmit(crypto, bob.nodeId, "h1", "normal", blob);
		const sAuth = await signAuth(crypto, alice.signSeed, "submit", alice.nodeId, clock.now(), nextNonce(), bh);
		const sub = await post("/submit", {
			auth: { nodeId: sAuth.nodeId, ts: sAuth.ts, nonce: sAuth.nonce, sig: toB64(sAuth.sig) },
			dst: bob.nodeId,
			id: "h1",
			blob: toB64(blob),
		});
		assert.deepEqual(sub, { ok: true, duplicate: false });

		const bhp = await bodyHashPull(crypto, 64);
		const pAuth = await signAuth(crypto, bob.signSeed, "pull", bob.nodeId, clock.now(), nextNonce(), bhp);
		const pulled = await post("/pull", {
			auth: { nodeId: pAuth.nodeId, ts: pAuth.ts, nonce: pAuth.nonce, sig: toB64(pAuth.sig) },
			limit: 64,
		});
		assert.equal(pulled.ok, true);
		assert.equal(pulled.messages.length, 1);
		assert.equal(Buffer.from(pulled.messages[0].blob, "base64").toString("utf8"), "hello-over-http");
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
