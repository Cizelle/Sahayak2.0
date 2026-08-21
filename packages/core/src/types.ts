/** Shared protocol types and constants. */
import type { Ulid } from "./ulid.ts";
import type { NodeId } from "./identity.ts";

export const PROTOCOL_VERSION = 1;

/** Delivery priority. Higher urgency = lower index. */
export type Priority = "sos" | "control" | "normal" | "bulk";
export const PRIORITIES: readonly Priority[] = ["sos", "control", "normal", "bulk"];
export function priorityRank(p: Priority): number {
	return PRIORITIES.indexOf(p);
}

/** How a message is being moved through the mesh. */
export type Mode = "direct" | "flood" | "store-forward" | "relay" | "sos";

/** Transport tiers, ordered best-first. The engine always prefers the lowest. */
export const TransportTier = {
	Internet: 0,
	Wifi: 1,
	Ble: 2,
	Sms: 3,
} as const;
export type TransportTier = (typeof TransportTier)[keyof typeof TransportTier];

export const DEFAULT_HOP_LIMIT = 3;
export const MAX_HOP_LIMIT = 7;

/**
 * Envelope header.
 *
 * IMPORTANT: every field EXCEPT `hop` is covered by the Ed25519 signature
 * (see codec.encodeSignedHeader). `hop` is intentionally mutable and unsigned
 * because relays increment it; abuse (resetting hop) cannot create loops or
 * storms because (a) each node rebroadcasts a given (src,id) at most once via
 * the dedup cache, and (b) `hopLimit` is signed and strictly enforced.
 */
export interface Header {
	v: number;
	id: Ulid;
	traceId: string;
	src: NodeId;
	dst: NodeId; // E2E messages are addressed; broadcast control uses HELLO/ROUTE_ADV frames
	ts: number; // origin wall-clock ms (advisory only; not trusted for expiry)
	ttlMs: number; // relative lifetime budget from ts (signed, immutable)
	hopLimit: number; // signed, immutable, <= MAX_HOP_LIMIT
	hop: number; // mutable, unsigned, incremented per relay
	prio: Priority;
	mode: Mode;
	payloadHash: Uint8Array; // sha256(plaintext) of THIS chunk (32 bytes)
	chunkIndex: number; // 0-based
	chunkCount: number; // >= 1
}

export interface Envelope {
	header: Header;
	/**
	 * Origin's Ed25519 public key, carried in-band. The recipient verifies
	 * sha256(srcSignPub) === header.src before trusting the signature, so a node
	 * can authenticate a multi-hop sender it has never directly met (TOFU). It is
	 * NOT part of the signed header because it is self-authenticating via the
	 * node-id hash binding.
	 */
	srcSignPub: Uint8Array; // 32
	ephPub: Uint8Array; // X25519 ephemeral public key (32)
	nonce: Uint8Array; // AEAD nonce (12)
	cipher: Uint8Array; // ciphertext || tag
	sig: Uint8Array; // Ed25519 signature over canonical signed header (64)
}

/** Frame type tags for the length-prefixed binary wire format. */
export const FrameType = {
	HELLO: 1,
	MSG: 2,
	CHUNK: 3,
	ACK: 4,
	ROUTE_ADV: 5,
	CONGESTION: 6,
	KEEPALIVE: 7,
	ERROR: 8,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

export interface Frame {
	type: FrameType;
	payload: Uint8Array;
}

/** (src,id) dedup key. */
export function dedupKey(src: NodeId, id: Ulid): string {
	return src + "|" + id;
}
