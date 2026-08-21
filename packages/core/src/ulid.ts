/**
 * Monotonic ULID (Universally Unique Lexicographically Sortable Identifier).
 * 48-bit millisecond timestamp + 80 bits of randomness, Crockford base32, 26
 * chars. Monotonic within the same millisecond by incrementing the random tail,
 * which guarantees strictly increasing ids for dedup ordering and digest sync.
 */
import { crockford32 } from "./bytes.ts";

export type Ulid = string;

export interface UlidFactory {
	(now?: number): Ulid;
}

/**
 * Build a monotonic ULID factory. `randomBytes` is injected so the same code
 * runs in tests (seeded), the simulator (deterministic), and on device.
 */
export function createUlidFactory(randomBytes: (n: number) => Uint8Array): UlidFactory {
	let lastTime = -1;
	let lastRandom: Uint8Array = new Uint8Array(10);

	return function ulid(now: number = Date.now()): Ulid {
		const time = Math.floor(now);
		if (time === lastTime) {
			// Increment the 80-bit random component as a big-endian integer.
			const r = lastRandom.slice();
			for (let i = r.length - 1; i >= 0; i--) {
				if (r[i]! < 0xff) {
					r[i] = r[i]! + 1;
					break;
				}
				r[i] = 0;
			}
			lastRandom = r;
		} else {
			lastTime = time;
			lastRandom = randomBytes(10);
		}

		const timeBytes = new Uint8Array(6);
		let t = time;
		for (let i = 5; i >= 0; i--) {
			timeBytes[i] = t & 0xff;
			t = Math.floor(t / 256);
		}
		return crockford32(timeBytes, 10) + crockford32(lastRandom, 16);
	};
}

/** Extract the millisecond timestamp encoded in a ULID. */
export function ulidTime(id: Ulid): number {
	const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
	let time = 0;
	for (let i = 0; i < 10; i++) {
		time = time * 32 + CROCKFORD.indexOf(id[i]!);
	}
	return time;
}
