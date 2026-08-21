/**
 * App-level message payload codec (item #7: multimedia).
 *
 * The engine carries OPAQUE bytes between nodes (engine.send takes a
 * Uint8Array and chunks/reassembles transparently via splitPlaintext +
 * Reassembler). To support text, images, files AND location beacons over the
 * exact same sealed/relayed path, the app wraps every message body in this
 * tiny tagged container before handing it to the engine, and unwraps it on
 * delivery.
 *
 * Wire format (all big-endian / LEB128 via ByteWriter):
 *   u8  MAGIC (0xA1)
 *   u8  VERSION (1)
 *   u8  KIND (1=text, 2=media, 3=location)
 *   kind == text:     lpStr(text)
 *   kind == media:    lpStr(JSON metaWithoutBytes) , lpBytes(rawData)
 *   kind == location: lpStr(JSON location)
 *
 * BACKWARD COMPATIBLE: any buffer whose first byte is not MAGIC is treated as
 * a legacy plain-text body (older builds sent raw UTF-8), so a new node can
 * still read messages from an old node and vice-versa (an old node simply
 * shows the tagged bytes as text it cannot parse — new nodes always tag).
 */
import { ByteReader, ByteWriter, fromUtf8 } from "./bytes.ts";

export type MeshPayloadKind = "text" | "media" | "location";

export interface MediaMeta {
	/** MIME type, e.g. "image/jpeg", "application/pdf". */
	mime: string;
	/** Original file/display name. */
	name: string;
	/** Byte length of the raw data (redundant with data.length; kept for display before full reassembly). */
	size: number;
}

export type LocationSource = "gps" | "network" | "peer";

export interface LocationInfo {
	lat: number;
	lon: number;
	/** Horizontal accuracy in meters, if known. */
	accuracyM?: number;
	/** Capture time (epoch ms). */
	tsMs: number;
	/** Where the fix came from. */
	source: LocationSource;
	/** When source === "peer": the device alias/short id the fix was borrowed from. */
	fromDevice?: string;
}

export interface MeshPayload {
	kind: MeshPayloadKind;
	/** Present for kind === "text" (also the caption for media, optional). */
	text?: string;
	/** Present for kind === "media". */
	media?: MediaMeta;
	/** Raw bytes for kind === "media". */
	data?: Uint8Array;
	/** Present for kind === "location". */
	location?: LocationInfo;
}

const MAGIC = 0xa1;
const VERSION = 1;
const KIND_TEXT = 1;
const KIND_MEDIA = 2;
const KIND_LOCATION = 3;

/** Encode a text message body. */
export function encodeText(text: string): Uint8Array {
	return new ByteWriter().u8(MAGIC).u8(VERSION).u8(KIND_TEXT).lpStr(text).finish();
}

/** Encode a media message body (optional caption in meta is carried as text). */
export function encodeMedia(meta: MediaMeta, data: Uint8Array, caption?: string): Uint8Array {
	const metaWire = JSON.stringify({ mime: meta.mime, name: meta.name, size: meta.size, caption: caption ?? "" });
	return new ByteWriter().u8(MAGIC).u8(VERSION).u8(KIND_MEDIA).lpStr(metaWire).lpBytes(data).finish();
}

/** Encode a location beacon body. */
export function encodeLocation(loc: LocationInfo): Uint8Array {
	return new ByteWriter().u8(MAGIC).u8(VERSION).u8(KIND_LOCATION).lpStr(JSON.stringify(loc)).finish();
}

/** Convenience: encode any payload. */
export function encodePayload(p: MeshPayload): Uint8Array {
	if (p.kind === "media" && p.media && p.data) return encodeMedia(p.media, p.data, p.text);
	if (p.kind === "location" && p.location) return encodeLocation(p.location);
	return encodeText(p.text ?? "");
}

/**
 * Decode a message body. Never throws: malformed or legacy buffers fall back
 * to being interpreted as plain UTF-8 text so the chat never loses a message.
 */
export function decodePayload(bytes: Uint8Array): MeshPayload {
	if (bytes.length < 3 || bytes[0] !== MAGIC || bytes[1] !== VERSION) {
		return { kind: "text", text: safeUtf8(bytes) };
	}
	try {
		const r = new ByteReader(bytes);
		r.u8(); // magic
		r.u8(); // version
		const kind = r.u8();
		if (kind === KIND_TEXT) {
			return { kind: "text", text: r.lpStr() };
		}
		if (kind === KIND_MEDIA) {
			const meta = JSON.parse(r.lpStr()) as MediaMeta & { caption?: string };
			const data = r.lpBytes();
			const out: MeshPayload = {
				kind: "media",
				media: { mime: meta.mime, name: meta.name, size: meta.size },
				data,
			};
			if (meta.caption && meta.caption.length > 0) out.text = meta.caption;
			return out;
		}
		if (kind === KIND_LOCATION) {
			return { kind: "location", location: JSON.parse(r.lpStr()) as LocationInfo };
		}
	} catch {
		/* fall through to legacy text */
	}
	return { kind: "text", text: safeUtf8(bytes) };
}

function safeUtf8(bytes: Uint8Array): string {
	try {
		return fromUtf8(bytes);
	} catch {
		return "";
	}
}
