/**
 * Double Ratchet tests: in-order exchange, DH-ratchet self-healing across
 * replies, out-of-order delivery via skipped message keys, associated-data
 * binding, tamper rejection, and the MAX_SKIP abuse bound.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { NodeCryptoProvider } from "../crypto/nodeProvider.ts";
import { utf8, fromUtf8 } from "../bytes.ts";
import { DoubleRatchet, MAX_SKIP, type RatchetMessage } from "./doubleRatchet.ts";

async function session() {
	const crypto = new NodeCryptoProvider("CHACHA20-POLY1305");
	const sk = crypto.randomBytes(32);
	const bobRatchet = await crypto.x25519Generate();
	const alice = await DoubleRatchet.initSender(crypto, sk, bobRatchet.publicKey);
	const bob = await DoubleRatchet.initReceiver(crypto, sk, bobRatchet);
	return { crypto, alice, bob };
}

test("in-order exchange both directions", async () => {
	const { alice, bob } = await session();
	const m1 = await alice.encrypt(utf8("hello bob"));
	assert.equal(fromUtf8(await bob.decrypt(m1)), "hello bob");

	const r1 = await bob.encrypt(utf8("hi alice"));
	assert.equal(fromUtf8(await alice.decrypt(r1)), "hi alice");

	// A second round trip exercises a full DH ratchet on both sides.
	const m2 = await alice.encrypt(utf8("how are you"));
	assert.equal(fromUtf8(await bob.decrypt(m2)), "how are you");
	const r2 = await bob.encrypt(utf8("all good"));
	assert.equal(fromUtf8(await alice.decrypt(r2)), "all good");
});

test("out-of-order delivery within a chain via skipped keys", async () => {
	const { alice, bob } = await session();
	const m1 = await alice.encrypt(utf8("one"));
	const m2 = await alice.encrypt(utf8("two"));
	const m3 = await alice.encrypt(utf8("three"));

	// Deliver 3, then 1, then 2 — 1 and 2's keys are cached when 3 arrives.
	assert.equal(fromUtf8(await bob.decrypt(m3)), "three");
	assert.equal(bob.stats().skipped, 2);
	assert.equal(fromUtf8(await bob.decrypt(m1)), "one");
	assert.equal(fromUtf8(await bob.decrypt(m2)), "two");
	assert.equal(bob.stats().skipped, 0);
});

test("out-of-order delivery across a DH ratchet step", async () => {
	const { alice, bob } = await session();
	// Alice sends a1 (chain A). Bob replies (forces Alice's DH ratchet on receipt).
	const a1 = await alice.encrypt(utf8("a1"));
	assert.equal(fromUtf8(await bob.decrypt(a1)), "a1");
	const b1 = await bob.encrypt(utf8("b1"));
	assert.equal(fromUtf8(await alice.decrypt(b1)), "b1");
	// Alice now sends a2,a3 on a NEW chain; deliver a3 before a2.
	const a2 = await alice.encrypt(utf8("a2"));
	const a3 = await alice.encrypt(utf8("a3"));
	assert.equal(fromUtf8(await bob.decrypt(a3)), "a3");
	assert.equal(fromUtf8(await bob.decrypt(a2)), "a2");
});

test("associated data is bound; mismatch fails", async () => {
	const { alice, bob } = await session();
	const m = await alice.encrypt(utf8("secret"), utf8("ctx-A"));
	await assert.rejects(() => bob.decrypt(m, utf8("ctx-B")), /authentication failed/);
	// Correct AD still works (fresh message; AD mismatch above did not advance recv chain irrecoverably for this one).
	const m2 = await alice.encrypt(utf8("secret2"), utf8("ctx-A"));
	assert.equal(fromUtf8(await bob.decrypt(m2, utf8("ctx-A"))), "secret2");
});

test("tampered ciphertext is rejected", async () => {
	const { alice, bob } = await session();
	const m = await alice.encrypt(utf8("do not tamper"));
	const tampered: RatchetMessage = { ...m, ct: Uint8Array.from(m.ct) };
	tampered.ct[0] = (tampered.ct[0] ?? 0) ^ 0xff;
	await assert.rejects(() => bob.decrypt(tampered), /authentication failed/);
});

test("MAX_SKIP bounds attacker-forced work", async () => {
	const { alice, bob } = await session();
	// Forge a message claiming an enormous message number on the first chain.
	const real = await alice.encrypt(utf8("x"));
	const evil: RatchetMessage = { ...real, n: MAX_SKIP + 5 };
	await assert.rejects(() => bob.decrypt(evil), /too many skipped messages/);
});
