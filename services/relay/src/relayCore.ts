/**
 * Zero-knowledge relay core — pure, transport-agnostic, fully unit-testable.
 *
 * WHAT IT IS
 * A relay is an OPTIONAL internet rendezvous box for nodes that are not
 * currently within radio range of each other. When Alice is online but Bob is
 * offline, Alice can hand Bob's (already end-to-end-encrypted) envelope to a
 * relay; when Bob reconnects he pulls it. The relay is store-and-forward only.
 *
 * WHY "ZERO-KNOWLEDGE"
 * The relay never holds any X25519 private key, so it CANNOT decrypt payloads.
 * It stores opaque AEAD ciphertext blobs keyed by destination node id. The only
 * metadata it must see is the destination (to route the pull) and a client-
 * chosen message id (for idempotency). It authenticates API callers with
 * Ed25519 signed requests purely for ABUSE CONTROL (rate limits, quotas) — not
 * to read content. See THREAT-MODEL.md for the metadata trade-offs and the
 * sealed-sender direction (Phase 4).
 *
 * DESIGN
 * - Pure logic, no I/O. `RelayStore` is an interface so the in-memory store
 *   used by tests can be swapped for Postgres/SQLite in production.
 * - Deterministic given an injected clock; no wall-clock or RNG inside.
 * - All crypto goes through the core `CryptoProvider`, so the relay shares the
 *   exact Ed25519 implementation the nodes use.
 */
import {
	concat,
	deriveNodeId,
	toHex,
	utf8,
	type CryptoProvider,
	type NodeId,
} from "../../../packages/core/src/index.ts";

export type RelayPriority = "sos" | "normal";

/** Minimal clock seam so the relay is deterministic under test. */
export interface RelayClock {
	now(): number;
}

export interface StoredMessage {
	readonly id: string;
	readonly dst: NodeId;
	readonly blob: Uint8Array; // opaque AEAD ciphertext envelope
	readonly prio: RelayPriority;
	readonly receivedAt: number;
	readonly expiresAt: number;
}

/**
 * Pluggable persistence. The in-memory implementation below is used by tests
 * and small deployments; a Postgres/SQLite implementation satisfies the same
 * contract for production (see services/relay/src/server.ts).
 */
export interface RelayStore {
	put(msg: StoredMessage): void;
	has(id: string): boolean;
	listFor(dst: NodeId, limit: number, now: number): StoredMessage[];
	deleteByIds(dst: NodeId, ids: readonly string[]): number;
	countFor(dst: NodeId, now: number): number;
	pruneExpired(now: number): number;
	total(): number;
}

export class MemoryRelayStore implements RelayStore {
	private readonly byDst = new Map<NodeId, Map<string, StoredMessage>>();
	private readonly ids = new Set<string>();

	put(msg: StoredMessage): void {
		let bucket = this.byDst.get(msg.dst);
		if (!bucket) {
			bucket = new Map();
			this.byDst.set(msg.dst, bucket);
		}
		bucket.set(msg.id, msg);
		this.ids.add(msg.id);
	}

	has(id: string): boolean {
		return this.ids.has(id);
	}

	listFor(dst: NodeId, limit: number, now: number): StoredMessage[] {
		const bucket = this.byDst.get(dst);
		if (!bucket) return [];
		const live = [...bucket.values()].filter((m) => m.expiresAt > now);
		// SOS first, then oldest-first, with id as a deterministic tiebreaker.
		live.sort((a, b) => {
			if (a.prio !== b.prio) return a.prio === "sos" ? -1 : 1;
			if (a.receivedAt !== b.receivedAt) return a.receivedAt - b.receivedAt;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
		return live.slice(0, limit);
	}

	deleteByIds(dst: NodeId, ids: readonly string[]): number {
		const bucket = this.byDst.get(dst);
		if (!bucket) return 0;
		let n = 0;
		for (const id of ids) {
			if (bucket.delete(id)) {
				this.ids.delete(id);
				n++;
			}
		}
		if (bucket.size === 0) this.byDst.delete(dst);
		return n;
	}

	countFor(dst: NodeId, now: number): number {
		const bucket = this.byDst.get(dst);
		if (!bucket) return 0;
		let n = 0;
		for (const m of bucket.values()) if (m.expiresAt > now) n++;
		return n;
	}

	pruneExpired(now: number): number {
		let n = 0;
		for (const [dst, bucket] of this.byDst) {
			for (const [id, m] of bucket) {
				if (m.expiresAt <= now) {
					bucket.delete(id);
					this.ids.delete(id);
					n++;
				}
			}
			if (bucket.size === 0) this.byDst.delete(dst);
		}
		return n;
	}

	total(): number {
		return this.ids.size;
	}
}

export interface RelayConfig {
	maxBlobBytes: number; // reject larger ciphertext payloads
	maxPerDst: number; // mailbox quota per destination (SOS bypasses)
	retentionMs: number; // normal-priority TTL
	sosRetentionMs: number; // SOS TTL (kept longer)
	skewWindowMs: number; // allowed |now - request.ts|
	rateCapacity: number; // token-bucket size per node
	rateRefillPerSec: number; // tokens regained per second
	nonceTtlMs: number; // replay-cache retention window
	presenceTtlMs: number; // how long a node is considered "online" after a roster ping
}

export const DEFAULT_RELAY_CONFIG: RelayConfig = {
	maxBlobBytes: 64 * 1024,
	maxPerDst: 256,
	retentionMs: 24 * 60 * 60 * 1000,
	sosRetentionMs: 72 * 60 * 60 * 1000,
	skewWindowMs: 5 * 60 * 1000,
	rateCapacity: 60,
	rateRefillPerSec: 1,
	nonceTtlMs: 10 * 60 * 1000,
	presenceTtlMs: 45 * 1000,
};

export type RelayError =
	| "bad-node-id"
	| "key-changed"
	| "not-registered"
	| "bad-signature"
	| "stale-request"
	| "replayed-nonce"
	| "rate-limited"
	| "payload-too-large"
	| "mailbox-full"
	| "invalid";

/** Authenticated-request envelope. The signature binds the operation, caller,
 * timestamp, a single-use nonce, and a hash of the operation body. */
export interface SignedAuth {
	nodeId: NodeId;
	ts: number;
	nonce: string;
	sig: Uint8Array;
}

export interface RegisterRequest {
	nodeId: NodeId;
	signPub: Uint8Array;
}
export interface SubmitRequest {
	auth: SignedAuth;
	dst: NodeId;
	blob: Uint8Array;
	id: string;
	prio?: RelayPriority;
}
export interface PullRequest {
	auth: SignedAuth;
	limit?: number;
}
export interface AckRequest {
	auth: SignedAuth;
	ids: string[];
}
/**
 * Presence/roster request. Calling roster both (a) refreshes the caller's own
 * "online" timestamp and (b) returns the set of other nodes currently online.
 * This is what lets two internet-connected nodes DISCOVER each other through
 * the relay even when they are not in radio range — the Internet tier's
 * equivalent of a BLE/Wi-Fi neighbor event. The relay still learns only node
 * ids (which it already sees for routing); message contents stay opaque.
 */
export interface RosterRequest {
	auth: SignedAuth;
}

export type RegisterResult = { ok: true } | { ok: false; error: RelayError };
export type SubmitResult = { ok: true; duplicate: boolean } | { ok: false; error: RelayError };
export type PullResult = { ok: true; messages: StoredMessage[] } | { ok: false; error: RelayError };
export type AckResult = { ok: true; deleted: number } | { ok: false; error: RelayError };
export type RosterResult = { ok: true; peers: NodeId[] } | { ok: false; error: RelayError };

/** Canonical, unambiguous byte string the client signs and the relay verifies. */
export function canonicalAuth(op: string, nodeId: NodeId, ts: number, nonce: string, bodyHashHex: string): Uint8Array {
	return utf8([op, nodeId, String(ts), nonce, bodyHashHex].join("\n"));
}

export async function bodyHashSubmit(
	crypto: CryptoProvider,
	dst: NodeId,
	msgId: string,
	prio: RelayPriority,
	blob: Uint8Array,
): Promise<string> {
	return toHex(await crypto.sha256(concat(utf8(`${dst}|${msgId}|${prio}|`), blob)));
}

export async function bodyHashPull(crypto: CryptoProvider, limit: number): Promise<string> {
	return toHex(await crypto.sha256(utf8(`pull|${limit}`)));
}

export async function bodyHashAck(crypto: CryptoProvider, ids: readonly string[]): Promise<string> {
	return toHex(await crypto.sha256(utf8(`ack|${[...ids].sort().join(",")}`)));
}

export async function bodyHashRoster(crypto: CryptoProvider): Promise<string> {
	return toHex(await crypto.sha256(utf8("roster")));
}

/** Helper so clients (and tests) build a signed request identically to how the
 * relay verifies it. */
export async function signAuth(
	crypto: CryptoProvider,
	signSeed: Uint8Array,
	op: string,
	nodeId: NodeId,
	ts: number,
	nonce: string,
	bodyHashHex: string,
): Promise<SignedAuth> {
	const sig = await crypto.ed25519Sign(signSeed, canonicalAuth(op, nodeId, ts, nonce, bodyHashHex));
	return { nodeId, ts, nonce, sig };
}

interface Bucket {
	tokens: number;
	last: number;
}

export class RelayCore {
	private readonly pins = new Map<NodeId, Uint8Array>();
	private readonly buckets = new Map<NodeId, Bucket>();
	private readonly nonces = new Map<NodeId, Map<string, number>>();
	/** nodeId -> last roster ping time; drives the Internet-tier presence list. */
	private readonly presence = new Map<NodeId, number>();

	constructor(
		private readonly crypto: CryptoProvider,
		private readonly store: RelayStore,
		private readonly clock: RelayClock,
		private readonly config: RelayConfig = DEFAULT_RELAY_CONFIG,
	) {}

	/** TOFU registration: pin nodeId -> signing key. The node id MUST equal
	 * hash(signPub), and a later key change for the same id is rejected. */
	async register(req: RegisterRequest): Promise<RegisterResult> {
		const derived = await deriveNodeId(this.crypto, req.signPub);
		if (derived !== req.nodeId) return { ok: false, error: "bad-node-id" };
		const existing = this.pins.get(req.nodeId);
		if (existing && toHex(existing) !== toHex(req.signPub)) return { ok: false, error: "key-changed" };
		if (!existing) this.pins.set(req.nodeId, req.signPub);
		return { ok: true };
	}

	private async verifyAuth(op: string, auth: SignedAuth, bodyHashHex: string): Promise<RelayError | null> {
		const pin = this.pins.get(auth.nodeId);
		if (!pin) return "not-registered";
		const now = this.clock.now();
		if (Math.abs(now - auth.ts) > this.config.skewWindowMs) return "stale-request";
		let seen = this.nonces.get(auth.nodeId);
		if (!seen) {
			seen = new Map();
			this.nonces.set(auth.nodeId, seen);
		}
		for (const [n, t] of seen) if (now - t > this.config.nonceTtlMs) seen.delete(n);
		if (seen.has(auth.nonce)) return "replayed-nonce";
		const ok = await this.crypto.ed25519Verify(
			pin,
			canonicalAuth(op, auth.nodeId, auth.ts, auth.nonce, bodyHashHex),
			auth.sig,
		);
		if (!ok) return "bad-signature";
		seen.set(auth.nonce, auth.ts); // record only AFTER a valid signature
		return null;
	}

	private rateLimit(nodeId: NodeId, cost: number): boolean {
		const now = this.clock.now();
		const b = this.buckets.get(nodeId) ?? { tokens: this.config.rateCapacity, last: now };
		const elapsedSec = Math.max(0, (now - b.last) / 1000);
		b.tokens = Math.min(this.config.rateCapacity, b.tokens + elapsedSec * this.config.rateRefillPerSec);
		b.last = now;
		if (b.tokens < cost) {
			this.buckets.set(nodeId, b);
			return false;
		}
		b.tokens -= cost;
		this.buckets.set(nodeId, b);
		return true;
	}

	async submit(req: SubmitRequest): Promise<SubmitResult> {
		if (req.blob.length === 0 || req.blob.length > this.config.maxBlobBytes)
			return { ok: false, error: "payload-too-large" };
		const prio: RelayPriority = req.prio ?? "normal";
		const bh = await bodyHashSubmit(this.crypto, req.dst, req.id, prio, req.blob);
		const err = await this.verifyAuth("submit", req.auth, bh);
		if (err) return { ok: false, error: err };
		if (!this.rateLimit(req.auth.nodeId, 1)) return { ok: false, error: "rate-limited" };
		const now = this.clock.now();
		this.store.pruneExpired(now);
		if (this.store.has(req.id)) return { ok: true, duplicate: true };
		if (prio !== "sos" && this.store.countFor(req.dst, now) >= this.config.maxPerDst)
			return { ok: false, error: "mailbox-full" };
		const ttl = prio === "sos" ? this.config.sosRetentionMs : this.config.retentionMs;
		this.store.put({ id: req.id, dst: req.dst, blob: req.blob, prio, receivedAt: now, expiresAt: now + ttl });
		return { ok: true, duplicate: false };
	}

	async pull(req: PullRequest): Promise<PullResult> {
		const limit = req.limit ?? 64;
		const bh = await bodyHashPull(this.crypto, limit);
		const err = await this.verifyAuth("pull", req.auth, bh);
		if (err) return { ok: false, error: err };
		const now = this.clock.now();
		this.store.pruneExpired(now);
		return { ok: true, messages: this.store.listFor(req.auth.nodeId, limit, now) };
	}

	async ack(req: AckRequest): Promise<AckResult> {
		const bh = await bodyHashAck(this.crypto, req.ids);
		const err = await this.verifyAuth("ack", req.auth, bh);
		if (err) return { ok: false, error: err };
		return { ok: true, deleted: this.store.deleteByIds(req.auth.nodeId, req.ids) };
	}

	/**
	 * Refresh the caller's presence and return everyone else currently online
	 * (within presenceTtlMs). Authenticated like every other op so only pinned
	 * nodes appear in the roster and stale entries self-expire.
	 */
	async roster(req: RosterRequest): Promise<RosterResult> {
		const bh = await bodyHashRoster(this.crypto);
		const err = await this.verifyAuth("roster", req.auth, bh);
		if (err) return { ok: false, error: err };
		if (!this.rateLimit(req.auth.nodeId, 1)) return { ok: false, error: "rate-limited" };
		const now = this.clock.now();
		this.presence.set(req.auth.nodeId, now);
		const peers: NodeId[] = [];
		for (const [id, seenAt] of this.presence) {
			if (now - seenAt > this.config.presenceTtlMs) {
				this.presence.delete(id);
				continue;
			}
			if (id !== req.auth.nodeId) peers.push(id);
		}
		return { ok: true, peers };
	}

	stats(): { pinned: number; stored: number } {
		return { pinned: this.pins.size, stored: this.store.total() };
	}
}
