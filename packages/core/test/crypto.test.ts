import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeCryptoProvider } from "../src/crypto/nodeProvider.ts";
import { generateIdentity, toPublic, TrustStore } from "../src/identity.ts";
import { sealEnvelope, openEnvelope, splitPlaintext, Reassembler } from "../src/envelope.ts";
import { encodeEnvelope, decodeEnvelope } from "../src/codec.ts";
import { PROTOCOL_VERSION } from "../src/types.ts";
import type { Header } from "../src/types.ts";
import { utf8, fromUtf8 } from "../src/bytes.ts";

async function makeHeader(
	crypto: NodeCryptoProvider,
	src: string,
	dst: string,
	plaintext: Uint8Array,
): Promise<Header> {
	return {
		v: PROTOCOL_VERSION,
		id: "01HZZZZZZZZZZZZZZZZZZZZZZZZ",
		traceId: "trace-1",
		src,
		dst,
		ts: 1_000,
		ttlMs: 60_000,
		hopLimit: 3,
		hop: 0,
		prio: "normal",
		mode: "flood",
		payloadHash: await crypto.sha256(plaintext),
		chunkIndex: 0,
		chunkCount: 1,
	};
}

for (const algo of ["AES-256-GCM", "CHACHA20-POLY1305"] as const) {
	test(`crypto roundtrip [${algo}]`, async () => {
		const crypto = new NodeCryptoProvider(algo);
		const alice = await generateIdentity(crypto);
		const bob = await generateIdentity(crypto);
		const msg = utf8("meet at the north bridge at dawn");
		const header = await makeHeader(crypto, alice.nodeId, bob.nodeId, msg);
		const env = await sealEnvelope(crypto, header, msg, bob, alice);
		const res = await openEnvelope(crypto, env, bob, alice);
		assert.ok(res.ok, "recipient should decrypt");
		if (res.ok) assert.equal(fromUtf8(res.plaintext), "meet at the north bridge at dawn");
	});
}

test("wire encode/decode is lossless", async () => {
	const crypto = new NodeCryptoProvider();
	const alice = await generateIdentity(crypto);
	const bob = await generateIdentity(crypto);
	const msg = utf8("hello mesh");
	const header = await makeHeader(crypto, alice.nodeId, bob.nodeId, msg);
	const env = await sealEnvelope(crypto, header, msg, bob, alice);
	const decoded = decodeEnvelope(encodeEnvelope(env));
	const res = await openEnvelope(crypto, decoded, bob, alice);
	assert.ok(res.ok);
});

test("wrong recipient cannot decrypt", async () => {
	const crypto = new NodeCryptoProvider();
	const alice = await generateIdentity(crypto);
	const bob = await generateIdentity(crypto);
	const mallory = await generateIdentity(crypto);
	const msg = utf8("secret");
	const header = await makeHeader(crypto, alice.nodeId, bob.nodeId, msg);
	const env = await sealEnvelope(crypto, header, msg, bob, alice);
	const res = await openEnvelope(crypto, env, mallory, alice);
	assert.equal(res.ok, false);
	if (!res.ok) assert.equal(res.reason, "decrypt-failed");
});

test("tampering with ciphertext is rejected", async () => {
	const crypto = new NodeCryptoProvider();
	const alice = await generateIdentity(crypto);
	const bob = await generateIdentity(crypto);
	const msg = utf8("do not modify");
	const header = await makeHeader(crypto, alice.nodeId, bob.nodeId, msg);
	const env = await sealEnvelope(crypto, header, msg, bob, alice);
	env.cipher[0] = env.cipher[0]! ^ 0xff;
	const res = await openEnvelope(crypto, env, bob, alice);
	assert.equal(res.ok, false);
});

test("tampering with a signed header field is detected (bad signature)", async () => {
	const crypto = new NodeCryptoProvider();
	const alice = await generateIdentity(crypto);
	const bob = await generateIdentity(crypto);
	const msg = utf8("route me honestly");
	const header = await makeHeader(crypto, alice.nodeId, bob.nodeId, msg);
	const env = await sealEnvelope(crypto, header, msg, bob, alice);
	// Attacker raises the hop limit to amplify flooding.
	const forged = decodeEnvelope(encodeEnvelope(env));
	forged.header.hopLimit = 7;
	const res = await openEnvelope(crypto, forged, bob, alice);
	assert.equal(res.ok, false);
	if (!res.ok) assert.equal(res.reason, "bad-signature");
});

test("impersonation (wrong signing key) is rejected", async () => {
	const crypto = new NodeCryptoProvider();
	const alice = await generateIdentity(crypto);
	const bob = await generateIdentity(crypto);
	const mallory = await generateIdentity(crypto);
	const msg = utf8("i am alice (not)");
	const header = await makeHeader(crypto, alice.nodeId, bob.nodeId, msg);
	// Mallory seals but claims to be Alice; Bob verifies against Alice's key.
	const env = await sealEnvelope(crypto, header, msg, bob, mallory);
	const res = await openEnvelope(crypto, env, bob, alice);
	assert.equal(res.ok, false);
	if (!res.ok) assert.equal(res.reason, "bad-signature");
});

test("node id is the hash of the signing key, not random", async () => {
	const crypto = new NodeCryptoProvider();
	const a = await generateIdentity(crypto);
	const a2 = await generateIdentity(crypto, { signSeed: a.signSeed, kexScalar: a.kexScalar });
	assert.equal(a.nodeId, a2.nodeId, "same seed -> same node id (deterministic)");
	assert.equal(a.nodeId.length, 64);
});

test("TOFU trust store flags key changes loudly", async () => {
	const crypto = new NodeCryptoProvider();
	const alice = await generateIdentity(crypto);
	const store = new TrustStore();
	assert.equal(store.observe(toPublic(alice)).kind, "new");
	assert.equal(store.observe(toPublic(alice)).kind, "known");
	// Same node id, different keys (attempted substitution).
	const impostor = { nodeId: alice.nodeId, signPub: (await generateIdentity(crypto)).signPub, kexPub: alice.kexPub };
	assert.equal(store.observe(impostor).kind, "key-change");
});

test("chunk split + hash-verified reassembly", async () => {
	const data = utf8("x".repeat(50));
	const chunks = splitPlaintext(data, 20);
	assert.equal(chunks.length, 3);
	const re = new Reassembler(chunks.length);
	// add out of order
	re.add(2, chunks[2]!);
	re.add(0, chunks[0]!);
	assert.equal(re.complete, false);
	re.add(1, chunks[1]!);
	assert.ok(re.complete);
	assert.equal(fromUtf8(re.assemble()), "x".repeat(50));
});
