/**
 * Control-frame payloads exchanged between directly-connected neighbors.
 *
 * HELLO advertises a node's identity (both public keys + node id). Because the
 * node id is sha256(signPub), the receiver can immediately verify the binding
 * and TOFU-pin the keys. ROUTE_ADV carries an anti-entropy digest: the set of
 * (src,id) message keys this node is currently holding in store-and-forward, so
 * a reconnecting peer can detect what it is missing and request a re-flood
 * instead of blindly resyncing everything.
 */
import { ByteReader, ByteWriter } from "./bytes.ts";

export interface Hello {
	nodeId: string;
	signPub: Uint8Array; // 32
	kexPub: Uint8Array; // 32
	/** Optional opaque SMS-SOS endpoint hint (never a durable identity). */
	smsHint?: string;
	/**
	 * Optional human-friendly device name (an "alias"). Not required to be
	 * unique and never used for routing or identity binding — the durable
	 * identity is always the nodeId = sha256(signPub). Purely a display label so
	 * peers can show "Ravi's phone" instead of a raw hash.
	 */
	name?: string;
}

export function encodeHello(h: Hello): Uint8Array {
	return new ByteWriter()
		.lpStr(h.nodeId)
		.lpBytes(h.signPub)
		.lpBytes(h.kexPub)
		.lpStr(h.smsHint ?? "")
		.lpStr(h.name ?? "")
		.finish();
}

export function decodeHello(bytes: Uint8Array): Hello {
	const r = new ByteReader(bytes);
	const nodeId = r.lpStr();
	const signPub = r.lpBytes().slice();
	const kexPub = r.lpBytes().slice();
	const smsHint = r.lpStr();
	// `name` was appended after smsHint in a later protocol revision. Guard the
	// read so HELLO frames produced by older peers (which stop after smsHint)
	// still decode cleanly instead of throwing on a missing length prefix.
	const name = r.remaining > 0 ? r.lpStr() : "";
	const h: Hello = { nodeId, signPub, kexPub };
	if (smsHint) h.smsHint = smsHint;
	if (name) h.name = name;
	return h;
}

export interface RouteAdv {
	/** dedup keys (src|id) this node currently holds and can re-offer. */
	digest: string[];
}

export function encodeRouteAdv(a: RouteAdv): Uint8Array {
	const w = new ByteWriter().varuint(a.digest.length);
	for (const k of a.digest) w.lpStr(k);
	return w.finish();
}

export function decodeRouteAdv(bytes: Uint8Array): RouteAdv {
	const r = new ByteReader(bytes);
	const n = r.varuint();
	const digest: string[] = [];
	for (let i = 0; i < n; i++) digest.push(r.lpStr());
	return { digest };
}
