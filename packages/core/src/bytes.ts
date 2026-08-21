/**
 * Byte / encoding primitives used across the protocol. Pure, dependency-free,
 * and portable to React Native (no Buffer, no Node globals).
 */

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
	let out = "";
	for (let i = 0; i < bytes.length; i++) {
		const b = bytes[i]!;
		out += HEX[b >> 4]! + HEX[b & 0x0f]!;
	}
	return out;
}

export function fromHex(hex: string): Uint8Array {
	if (hex.length % 2 !== 0) throw new Error("fromHex: odd-length string");
	const out = new Uint8Array(hex.length / 2);
	for (let i = 0; i < out.length; i++) {
		out[i] = parseInt(hex.substr(i * 2, 2), 16);
	}
	return out;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function utf8(s: string): Uint8Array {
	return encoder.encode(s);
}

export function fromUtf8(bytes: Uint8Array): string {
	return decoder.decode(bytes);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	let total = 0;
	for (const p of parts) total += p.length;
	const out = new Uint8Array(total);
	let off = 0;
	for (const p of parts) {
		out.set(p, off);
		off += p.length;
	}
	return out;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	// Constant-time-ish compare (length already leaked, acceptable for tags).
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
	return diff === 0;
}

/** Base32 (Crockford) used by ULID. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function crockford32(bytes: Uint8Array, length: number): string {
	// Big-endian base32 encode of the provided bytes into `length` chars.
	let bits = 0;
	let value = 0;
	let output = "";
	for (let i = 0; i < bytes.length; i++) {
		value = (value << 8) | bytes[i]!;
		bits += 8;
		while (bits >= 5) {
			output += CROCKFORD[(value >>> (bits - 5)) & 31]!;
			bits -= 5;
		}
	}
	if (bits > 0) output += CROCKFORD[(value << (5 - bits)) & 31]!;
	return output.padStart(length, "0").slice(0, length);
}

// ---------------------------------------------------------------------------
// Minimal binary writer/reader with LEB128 varints + length-prefixed buffers.
// Used for canonical header serialization and frame encoding.
// ---------------------------------------------------------------------------

export class ByteWriter {
	private chunks: number[] = [];

	u8(n: number): this {
		this.chunks.push(n & 0xff);
		return this;
	}

	u32be(n: number): this {
		this.chunks.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
		return this;
	}

	/** Unsigned LEB128 varint. Supports full 53-bit safe integers. */
	varuint(n: number): this {
		if (n < 0 || !Number.isInteger(n)) throw new Error("varuint: needs non-negative integer");
		let v = n;
		while (v >= 0x80) {
			this.chunks.push((v & 0x7f) | 0x80);
			v = Math.floor(v / 128);
		}
		this.chunks.push(v & 0x7f);
		return this;
	}

	bytes(b: Uint8Array): this {
		for (let i = 0; i < b.length; i++) this.chunks.push(b[i]!);
		return this;
	}

	/** Length-prefixed (varuint length) byte blob. */
	lpBytes(b: Uint8Array): this {
		return this.varuint(b.length).bytes(b);
	}

	/** Length-prefixed UTF-8 string. */
	lpStr(s: string): this {
		return this.lpBytes(utf8(s));
	}

	finish(): Uint8Array {
		return Uint8Array.from(this.chunks);
	}
}

export class ByteReader {
	private off = 0;
	constructor(private readonly buf: Uint8Array) {}

	get offset(): number {
		return this.off;
	}

	get remaining(): number {
		return this.buf.length - this.off;
	}

	u8(): number {
		if (this.off >= this.buf.length) throw new Error("ByteReader: out of bounds");
		return this.buf[this.off++]!;
	}

	u32be(): number {
		const a = this.u8(),
			b = this.u8(),
			c = this.u8(),
			d = this.u8();
		return (a * 0x1000000 + (b << 16) + (c << 8) + d) >>> 0;
	}

	varuint(): number {
		let result = 0;
		let shift = 1;
		for (;;) {
			const byte = this.u8();
			result += (byte & 0x7f) * shift;
			if ((byte & 0x80) === 0) break;
			shift *= 128;
			if (shift > Number.MAX_SAFE_INTEGER) throw new Error("varuint: too large");
		}
		return result;
	}

	bytes(n: number): Uint8Array {
		if (this.off + n > this.buf.length) throw new Error("ByteReader: out of bounds");
		const out = this.buf.subarray(this.off, this.off + n);
		this.off += n;
		return out;
	}

	lpBytes(): Uint8Array {
		const len = this.varuint();
		return this.bytes(len);
	}

	lpStr(): string {
		return fromUtf8(this.lpBytes());
	}
}
