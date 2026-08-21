/**
 * Envelope sealing/opening — the end-to-end security boundary.
 *
 * Scheme (ECIES-style, authenticated):
 *   1. Origin generates an EPHEMERAL X25519 keypair (forward secrecy per message).
 *   2. shared = X25519(eph_priv, recipient_kex_pub)
 *   3. key    = HKDF-SHA256(shared, salt = eph_pub, info = "adaptivemesh/v1/aead/<algo>")
 *   4. cipher = AEAD_Seal(key, nonce, plaintext, aad = canonical signed header)
 *   5. sig    = Ed25519_Sign(origin_sign_seed, aad)
 *
 * Guarantees:
 *   - Confidentiality + integrity of payload: AEAD, with the header bound as AAD.
 *   - Authenticity: Ed25519 signature over the canonical header (which contains
 *     payloadHash = sha256(plaintext)). A relay cannot forge or mutate it.
 *   - Sender authenticity across multiple hops: srcSignPub is carried in-band
 *     and bound to the node id via sha256, so an intermediate relay can neither
 *     impersonate the origin nor swap the key.
 *   - Wrong recipient cannot derive `key` (different ECDH result) -> AEAD fails.
 *   - Per-message forward secrecy via ephemeral keys; long-lived sessions add
 *     the Double Ratchet (see session/doubleRatchet).
 */
import { equalBytes, concat, utf8 } from "./bytes.ts";
import { encodeSignedHeader } from "./codec.ts";
import type { CryptoProvider } from "./crypto/provider.ts";
import { NONCE_BYTES } from "./crypto/provider.ts";
import type { PublicIdentity, SecretIdentity } from "./identity.ts";
import type { Envelope, Header } from "./types.ts";

function hkdfInfo(crypto: CryptoProvider): Uint8Array {
	return utf8("adaptivemesh/v1/aead/" + crypto.aead);
}

export async function sealEnvelope(
	crypto: CryptoProvider,
	header: Header,
	plaintext: Uint8Array,
	recipient: Pick<PublicIdentity, "kexPub">,
	origin: Pick<SecretIdentity, "signSeed" | "signPub">,
): Promise<Envelope> {
	const eph = await crypto.x25519Generate();
	const shared = await crypto.x25519SharedSecret(eph.privateKey, recipient.kexPub);
	const key = await crypto.hkdfSha256(shared, eph.publicKey, hkdfInfo(crypto), 32);
	const nonce = crypto.randomBytes(NONCE_BYTES);
	const aad = encodeSignedHeader(header);
	const cipher = await crypto.aeadSeal(key, nonce, plaintext, aad);
	const sig = await crypto.ed25519Sign(origin.signSeed, aad);
	return { header, srcSignPub: origin.signPub, ephPub: eph.publicKey, nonce, cipher, sig };
}

export type OpenResult =
	| { ok: true; plaintext: Uint8Array }
	| { ok: false; reason: "bad-signature" | "decrypt-failed" | "hash-mismatch" | "id-mismatch" };

/**
 * Verify that the in-band sender key actually hashes to the claimed node id.
 * This is the binding that makes srcSignPub safe to trust on first use.
 */
export async function verifySenderBinding(crypto: CryptoProvider, env: Envelope): Promise<boolean> {
	const { toHex } = await import("./bytes.ts");
	const h = toHex(await crypto.sha256(env.srcSignPub));
	return h === env.header.src;
}

export async function openEnvelope(
	crypto: CryptoProvider,
	env: Envelope,
	recipient: Pick<SecretIdentity, "kexScalar">,
	origin?: Pick<PublicIdentity, "signPub">,
): Promise<OpenResult> {
	// Determine the signing key: prefer an explicitly trusted one; otherwise use
	// the in-band key after verifying its hash binds to the claimed node id.
	let signPub: Uint8Array;
	if (origin) {
		signPub = origin.signPub;
	} else {
		if (!(await verifySenderBinding(crypto, env))) return { ok: false, reason: "id-mismatch" };
		signPub = env.srcSignPub;
	}

	const aad = encodeSignedHeader(env.header);
	const sigOk = await crypto.ed25519Verify(signPub, aad, env.sig);
	if (!sigOk) return { ok: false, reason: "bad-signature" };

	const shared = await crypto.x25519SharedSecret(recipient.kexScalar, env.ephPub);
	const key = await crypto.hkdfSha256(shared, env.ephPub, hkdfInfo(crypto), 32);
	const plaintext = await crypto.aeadOpen(key, env.nonce, env.cipher, aad);
	if (!plaintext) return { ok: false, reason: "decrypt-failed" };

	const h = await crypto.sha256(plaintext);
	if (!equalBytes(h, env.header.payloadHash)) return { ok: false, reason: "hash-mismatch" };
	return { ok: true, plaintext };
}

// --- Application-level chunking (large plaintext -> N envelopes) ------------
export function splitPlaintext(plaintext: Uint8Array, maxChunk: number): Uint8Array[] {
	if (maxChunk <= 0) throw new Error("maxChunk must be > 0");
	if (plaintext.length === 0) return [new Uint8Array(0)];
	const chunks: Uint8Array[] = [];
	for (let off = 0; off < plaintext.length; off += maxChunk) {
		chunks.push(plaintext.subarray(off, Math.min(off + maxChunk, plaintext.length)).slice());
	}
	return chunks;
}

/** Collects chunks of one message id and yields the reassembled plaintext. */
export class Reassembler {
	private readonly parts = new Map<number, Uint8Array>();
	constructor(public readonly count: number) {}

	add(index: number, data: Uint8Array): void {
		if (index < 0 || index >= this.count) throw new Error("chunk index out of range");
		this.parts.set(index, data);
	}

	get complete(): boolean {
		return this.parts.size === this.count;
	}

	assemble(): Uint8Array {
		if (!this.complete) throw new Error("Reassembler: missing chunks");
		const ordered: Uint8Array[] = [];
		for (let i = 0; i < this.count; i++) ordered.push(this.parts.get(i)!);
		return concat(...ordered);
	}
}
