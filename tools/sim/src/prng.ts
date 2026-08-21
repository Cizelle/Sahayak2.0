/**
 * Deterministic PRNG (mulberry32). Every stochastic choice in the simulator —
 * link loss, propagation delay, router contention jitter — is drawn from a
 * seeded Rng so a given seed reproduces identical benchmark numbers on every
 * run and every machine. This is what makes the evaluation numbers defensible.
 */
export type Rng = () => number;

export function mulberry32(seed: number): Rng {
	let a = seed >>> 0;
	return function () {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Uniform integer in [0, n). */
export function randInt(rng: Rng, n: number): number {
	return Math.floor(rng() * n);
}

/** Deterministic byte buffer (used where seeded material is wanted). */
export function seededBytes(rng: Rng, n: number): Uint8Array {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) b[i] = Math.floor(rng() * 256);
	return b;
}
