/**
 * Double Ratchet (Signal-style) for forward-secure, post-compromise-secure
 * 1:1 sessions over the mesh. Pure TypeScript on top of the core CryptoProvider
 * so it runs identically in tests, the simulator, and on-device.
 *
 * SECURITY PROPERTIES
 * - Forward secrecy: each message key is derived by a one-way KDF chain step, so
 *   compromising current state does not reveal past message keys.
 * - Post-compromise security ("self-healing"): every time the peers exchange a
 *   new DH ratchet public key, a fresh DH shared secret is folded into the root
 *   key, so a transient key compromise heals after one round trip.
 * - Out-of-order / lossy delivery: skipped message keys are derived and cached
 *   (bounded by MAX_SKIP) so messages can arrive late or out of order — exactly
 *   what a multi-hop, partition-prone mesh produces.
 *
 * KDF CONSTRUCTION (all via HKDF-SHA256 in the provider; no bespoke crypto)
 * - root step:  HKDF(ikm = DH_out, salt = RK,  info = "...root",  64) -> RK' || CK
 * - chain step: HKDF(ikm = CK,     salt = 0^32, info = "...chain", 64) -> MK  || CK'
 * - msg keys:   HKDF(ikm = MK,     salt = 0^32, info = "...msg",   44) -> encKey(32) || nonce(12)
 *
 * The message header (sender DH public key, previous-chain length PN, message
 * number N) is authenticated as AEAD associated data, so headers cannot be
 * altered without failing decryption.
 */
import { concat, toHex } from "../bytes.ts";
import type { CryptoProvider } from "../crypto/provider.ts";

const ZERO_SALT = new Uint8Array(32);
const INFO_ROOT = new TextEncoder().encode("adaptivemesh/v1/ratchet/root");
const INFO_CHAIN = new TextEncoder().encode("adaptivemesh/v1/ratchet/chain");
const INFO_MSG = new TextEncoder().encode("adaptivemesh/v1/ratchet/msg");

/** Safety bound on how many skipped keys we will derive for one received
 * message, to stop a malicious peer from forcing unbounded work/memory. */
export const MAX_SKIP = 1000;

export interface RatchetMessage {
	/** Sender's current ratchet (DH) public key. */
	readonly dh: Uint8Array;
	/** Number of messages in the sender's previous sending chain. */
	readonly pn: number;
	/** Message number within the current sending chain. */
	readonly n: number;
	/** AEAD ciphertext (tag appended by the provider). */
	readonly ct: Uint8Array;
}

interface KeyPair {
	pub: Uint8Array;
	priv: Uint8Array;
}

function headerBytes(dh: Uint8Array, pn: number, n: number): Uint8Array {
	const out = new Uint8Array(dh.length + 8);
	out.set(dh, 0);
	const view = new DataView(out.buffer, out.byteOffset + dh.length, 8);
	view.setUint32(0, pn, false);
	view.setUint32(4, n, false);
	return out;
}

function skipKey(dh: Uint8Array, n: number): string {
	return `${toHex(dh)}:${n}`;
}

/**
 * One end of a Double Ratchet session. Construct via the static `initSender` /
 * `initReceiver` factories after both peers share an initial secret `sk`
 * (e.g. the X25519 shared secret established during the handshake) and the
 * receiver's initial ratchet public key.
 */
export class DoubleRatchet {
	private constructor(
		private readonly crypto: CryptoProvider,
		private dhs: KeyPair,
		private dhr: Uint8Array | undefined,
		private rk: Uint8Array,
		private cks: Uint8Array | undefined,
		private ckr: Uint8Array | undefined,
		private ns: number,
		private nr: number,
		private pn: number,
		private readonly skipped: Map<string, Uint8Array>,
	) {}

	/** Alice: knows the shared secret and Bob's initial ratchet public key. */
	static async initSender(crypto: CryptoProvider, sk: Uint8Array, theirRatchetPub: Uint8Array): Promise<DoubleRatchet> {
		const dhsPair = await crypto.x25519Generate();
		const dhs: KeyPair = { pub: dhsPair.publicKey, priv: dhsPair.privateKey };
		const dhOut = await crypto.x25519SharedSecret(dhs.priv, theirRatchetPub);
		const [rk, cks] = await rootStep(crypto, sk, dhOut);
		return new DoubleRatchet(crypto, dhs, theirRatchetPub, rk, cks, undefined, 0, 0, 0, new Map());
	}

	/** Bob: knows the shared secret and owns the initial ratchet key pair whose
	 * public half he advertised to Alice out-of-band / during the handshake. */
	static async initReceiver(
		crypto: CryptoProvider,
		sk: Uint8Array,
		ourRatchetKeyPair: { publicKey: Uint8Array; privateKey: Uint8Array },
	): Promise<DoubleRatchet> {
		const dhs: KeyPair = { pub: ourRatchetKeyPair.publicKey, priv: ourRatchetKeyPair.privateKey };
		return new DoubleRatchet(crypto, dhs, undefined, sk, undefined, undefined, 0, 0, 0, new Map());
	}

	async encrypt(plaintext: Uint8Array, associatedData?: Uint8Array): Promise<RatchetMessage> {
		if (!this.cks) throw new Error("ratchet: sending chain not initialized");
		const [mk, nextCk] = await chainStep(this.crypto, this.cks);
		this.cks = nextCk;
		const header = headerBytes(this.dhs.pub, this.pn, this.ns);
		const aad = associatedData ? concat(associatedData, header) : header;
		const { enc, nonce } = await msgKeys(this.crypto, mk);
		const ct = await this.crypto.aeadSeal(enc, nonce, plaintext, aad);
		const msg: RatchetMessage = { dh: this.dhs.pub, pn: this.pn, n: this.ns, ct };
		this.ns += 1;
		return msg;
	}

	async decrypt(msg: RatchetMessage, associatedData?: Uint8Array): Promise<Uint8Array> {
		const fromSkipped = await this.trySkipped(msg, associatedData);
		if (fromSkipped) return fromSkipped;

		if (!this.dhr || toHex(msg.dh) !== toHex(this.dhr)) {
			await this.skipMessageKeys(msg.pn);
			await this.dhRatchet(msg.dh);
		}
		await this.skipMessageKeys(msg.n);
		if (!this.ckr) throw new Error("ratchet: receiving chain not initialized");
		const [mk, nextCk] = await chainStep(this.crypto, this.ckr);
		this.ckr = nextCk;
		this.nr += 1;
		const pt = await this.open(mk, msg, associatedData);
		if (!pt) throw new Error("ratchet: authentication failed");
		return pt;
	}

	private async open(mk: Uint8Array, msg: RatchetMessage, ad?: Uint8Array): Promise<Uint8Array | null> {
		const header = headerBytes(msg.dh, msg.pn, msg.n);
		const aad = ad ? concat(ad, header) : header;
		const { enc, nonce } = await msgKeys(this.crypto, mk);
		return this.crypto.aeadOpen(enc, nonce, msg.ct, aad);
	}

	private async trySkipped(msg: RatchetMessage, ad?: Uint8Array): Promise<Uint8Array | null> {
		const key = skipKey(msg.dh, msg.n);
		const mk = this.skipped.get(key);
		if (!mk) return null;
		const pt = await this.open(mk, msg, ad);
		if (!pt) throw new Error("ratchet: authentication failed (skipped key)");
		this.skipped.delete(key);
		return pt;
	}

	private async skipMessageKeys(until: number): Promise<void> {
		if (this.ckr === undefined) return;
		if (until - this.nr > MAX_SKIP) throw new Error("ratchet: too many skipped messages");
		while (this.nr < until) {
			const [mk, nextCk] = await chainStep(this.crypto, this.ckr);
			this.ckr = nextCk;
			this.skipped.set(skipKey(this.dhr as Uint8Array, this.nr), mk);
			this.nr += 1;
		}
	}

	private async dhRatchet(theirDh: Uint8Array): Promise<void> {
		this.pn = this.ns;
		this.ns = 0;
		this.nr = 0;
		this.dhr = theirDh;
		const recvOut = await this.crypto.x25519SharedSecret(this.dhs.priv, theirDh);
		[this.rk, this.ckr] = await rootStep(this.crypto, this.rk, recvOut);
		const fresh = await this.crypto.x25519Generate();
		this.dhs = { pub: fresh.publicKey, priv: fresh.privateKey };
		const sendOut = await this.crypto.x25519SharedSecret(this.dhs.priv, theirDh);
		[this.rk, this.cks] = await rootStep(this.crypto, this.rk, sendOut);
	}

	/** Diagnostics only; never exposes private keys. */
	stats(): { ns: number; nr: number; pn: number; skipped: number } {
		return { ns: this.ns, nr: this.nr, pn: this.pn, skipped: this.skipped.size };
	}
}

async function rootStep(crypto: CryptoProvider, rk: Uint8Array, dhOut: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
	const out = await crypto.hkdfSha256(dhOut, rk, INFO_ROOT, 64);
	return [out.slice(0, 32), out.slice(32, 64)];
}

async function chainStep(crypto: CryptoProvider, ck: Uint8Array): Promise<[Uint8Array, Uint8Array]> {
	const out = await crypto.hkdfSha256(ck, ZERO_SALT, INFO_CHAIN, 64);
	return [out.slice(0, 32), out.slice(32, 64)];
}

async function msgKeys(crypto: CryptoProvider, mk: Uint8Array): Promise<{ enc: Uint8Array; nonce: Uint8Array }> {
	const out = await crypto.hkdfSha256(mk, ZERO_SALT, INFO_MSG, 44);
	return { enc: out.slice(0, 32), nonce: out.slice(32, 44) };
}
