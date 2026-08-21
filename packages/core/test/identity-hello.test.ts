import { test } from "node:test";
import assert from "node:assert/strict";
import { NodeCryptoProvider } from "../src/crypto/nodeProvider.ts";
import { generateIdentity, exportIdentitySeeds, importIdentitySeeds } from "../src/identity.ts";
import { encodeHello, decodeHello, type Hello } from "../src/hello.ts";
import { ByteWriter } from "../src/bytes.ts";

const crypto = new NodeCryptoProvider();

test("HELLO round-trips with an optional device name", () => {
	const hello: Hello = {
		nodeId: "a".repeat(64),
		signPub: new Uint8Array(32).fill(1),
		kexPub: new Uint8Array(32).fill(2),
		name: "Ravi's phone",
	};
	const decoded = decodeHello(encodeHello(hello));
	assert.equal(decoded.nodeId, hello.nodeId);
	assert.equal(decoded.name, "Ravi's phone");
	assert.deepEqual([...decoded.signPub], [...hello.signPub]);
	assert.deepEqual([...decoded.kexPub], [...hello.kexPub]);
});

test("HELLO without a name decodes with name undefined", () => {
	const hello: Hello = {
		nodeId: "b".repeat(64),
		signPub: new Uint8Array(32).fill(3),
		kexPub: new Uint8Array(32).fill(4),
	};
	const decoded = decodeHello(encodeHello(hello));
	assert.equal(decoded.name, undefined);
});

test("HELLO decoder tolerates legacy frames that stop after smsHint", () => {
	// Simulate an older peer that encoded only the original four fields
	// (no trailing name length-prefix at all).
	const legacy = new ByteWriter()
		.lpStr("c".repeat(64))
		.lpBytes(new Uint8Array(32).fill(5))
		.lpBytes(new Uint8Array(32).fill(6))
		.lpStr("") // smsHint
		.finish();
	const decoded = decodeHello(legacy);
	assert.equal(decoded.nodeId, "c".repeat(64));
	assert.equal(decoded.name, undefined);
	assert.equal(decoded.smsHint, undefined);
});

test("identity seeds persist and re-derive the same permanent hash (nodeId)", async () => {
	const id = await generateIdentity(crypto);
	const seeds = exportIdentitySeeds(id);
	const restored = await importIdentitySeeds(crypto, seeds);
	assert.equal(restored.nodeId, id.nodeId, "nodeId must be stable across reload");
	assert.deepEqual([...restored.signPub], [...id.signPub]);
	assert.deepEqual([...restored.kexPub], [...id.kexPub]);
	assert.deepEqual([...restored.signSeed], [...id.signSeed]);
	assert.deepEqual([...restored.kexScalar], [...id.kexScalar]);
});

test("importIdentitySeeds rejects unknown versions", async () => {
	await assert.rejects(
		() => importIdentitySeeds(crypto, { v: 2 as 1, signSeed: "00", kexScalar: "00" }),
		/unsupported version/,
	);
});
