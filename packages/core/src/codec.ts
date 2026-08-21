/**
 * Binary wire codec.
 *
 * - encodeSignedHeader: deterministic, canonical serialization of the header
 *   fields that the origin signs (everything EXCEPT the mutable `hop`). Both
 *   the AEAD AAD and the Ed25519 signature are computed over these exact bytes,
 *   so a relay cannot alter routing-relevant fields without detection.
 * - encodeEnvelope/decodeEnvelope: full on-wire envelope (includes hop + crypto).
 * - encodeFrame/decodeFrame + FrameReader: length-prefixed framing that survives
 *   the 20-byte BLE worst case (a frame may span many transport reads).
 */
import { ByteReader, ByteWriter } from "./bytes.ts";
import { FrameType, PROTOCOL_VERSION } from "./types.ts";
import type { Envelope, Frame, Header, Mode, Priority } from "./types.ts";

const PRIO_CODE: Record<Priority, number> = { sos: 0, control: 1, normal: 2, bulk: 3 };
const PRIO_NAME: Priority[] = ["sos", "control", "normal", "bulk"];
const MODE_CODE: Record<Mode, number> = {
	direct: 0,
	flood: 1,
	"store-forward": 2,
	relay: 3,
	sos: 4,
};
const MODE_NAME: Mode[] = ["direct", "flood", "store-forward", "relay", "sos"];

/** Canonical bytes the origin signs. Excludes `hop` (mutable in transit). */
export function encodeSignedHeader(h: Header): Uint8Array {
	if (h.payloadHash.length !== 32) throw new Error("payloadHash must be 32 bytes");
	return new ByteWriter()
		.u8(h.v)
		.lpStr(h.id)
		.lpStr(h.traceId)
		.lpStr(h.src)
		.lpStr(h.dst)
		.varuint(h.ts)
		.varuint(h.ttlMs)
		.u8(h.hopLimit)
		.u8(PRIO_CODE[h.prio])
		.u8(MODE_CODE[h.mode])
		.bytes(h.payloadHash)
		.varuint(h.chunkIndex)
		.varuint(h.chunkCount)
		.finish();
}

export function encodeEnvelope(env: Envelope): Uint8Array {
	const h = env.header;
	return new ByteWriter()
		.lpBytes(encodeSignedHeader(h))
		.varuint(h.hop) // mutable, carried but not signed
		.lpBytes(env.srcSignPub)
		.lpBytes(env.ephPub)
		.lpBytes(env.nonce)
		.lpBytes(env.cipher)
		.lpBytes(env.sig)
		.finish();
}

function decodeSignedHeader(bytes: Uint8Array, hop: number): Header {
	const r = new ByteReader(bytes);
	const v = r.u8();
	const id = r.lpStr();
	const traceId = r.lpStr();
	const src = r.lpStr();
	const dst = r.lpStr();
	const ts = r.varuint();
	const ttlMs = r.varuint();
	const hopLimit = r.u8();
	const prio = PRIO_NAME[r.u8()];
	const mode = MODE_NAME[r.u8()];
	const payloadHash = r.bytes(32).slice();
	const chunkIndex = r.varuint();
	const chunkCount = r.varuint();
	if (!prio || !mode) throw new Error("decodeHeader: bad prio/mode");
	return { v, id, traceId, src, dst, ts, ttlMs, hopLimit, hop, prio, mode, payloadHash, chunkIndex, chunkCount };
}

export function decodeEnvelope(bytes: Uint8Array): Envelope {
	const r = new ByteReader(bytes);
	const signed = r.lpBytes();
	const hop = r.varuint();
	const srcSignPub = r.lpBytes().slice();
	const ephPub = r.lpBytes().slice();
	const nonce = r.lpBytes().slice();
	const cipher = r.lpBytes().slice();
	const sig = r.lpBytes().slice();
	const header = decodeSignedHeader(signed, hop);
	if (header.v !== PROTOCOL_VERSION) throw new Error(`unsupported protocol version ${header.v}`);
	return { header, srcSignPub, ephPub, nonce, cipher, sig };
}

// --- Frames ----------------------------------------------------------------

export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
	return new ByteWriter().u8(type).u32be(payload.length).bytes(payload).finish();
}

export function decodeFrame(bytes: Uint8Array): Frame {
	const r = new ByteReader(bytes);
	const type = r.u8() as FrameType;
	const len = r.u32be();
	return { type, payload: r.bytes(len).slice() };
}

/**
 * Reassembles whole frames from an arbitrarily-fragmented byte stream. This is
 * exactly what the BLE transport needs: GATT may hand us 20-byte slivers, and a
 * single MSG frame can span dozens of them.
 */
export class FrameReader {
	private buf = new Uint8Array(0);

	push(chunk: Uint8Array): Frame[] {
		const merged = new Uint8Array(this.buf.length + chunk.length);
		merged.set(this.buf, 0);
		merged.set(chunk, this.buf.length);
		this.buf = merged;

		const frames: Frame[] = [];
		for (;;) {
			if (this.buf.length < 5) break; // need type(1) + len(4)
			const len = (this.buf[1]! * 0x1000000 + (this.buf[2]! << 16) + (this.buf[3]! << 8) + this.buf[4]!) >>> 0;
			const total = 5 + len;
			if (this.buf.length < total) break;
			frames.push(decodeFrame(this.buf.subarray(0, total)));
			this.buf = this.buf.subarray(total).slice();
		}
		return frames;
	}

	get buffered(): number {
		return this.buf.length;
	}
}
