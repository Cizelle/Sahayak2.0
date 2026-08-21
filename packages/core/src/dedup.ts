/**
 * Dedup + replay protection: a bounded LRU with per-entry TTL keyed by (src,id).
 *
 * This is the single most important defense against broadcast storms: a node
 * processes/rebroadcasts any given (src,id) at most once. It is also the replay
 * guard — a re-injected old envelope is recognized and dropped. Bounded size +
 * TTL keep memory flat on long-running, resource-constrained devices.
 */
export interface DedupOptions {
	maxEntries: number;
	ttlMs: number;
}

export class DedupCache {
	// insertion-ordered Map doubles as an LRU; value = expiry timestamp (ms).
	private readonly map = new Map<string, number>();
	constructor(private readonly opts: DedupOptions) {}

	/** Returns true if this key is NEW (and records it); false if duplicate. */
	add(key: string, now: number): boolean {
		this.prune(now);
		if (this.map.has(key)) {
			// refresh recency
			this.map.delete(key);
			this.map.set(key, now + this.opts.ttlMs);
			return false;
		}
		this.map.set(key, now + this.opts.ttlMs);
		if (this.map.size > this.opts.maxEntries) {
			const oldest = this.map.keys().next().value as string | undefined;
			if (oldest !== undefined) this.map.delete(oldest);
		}
		return true;
	}

	has(key: string, now: number): boolean {
		const exp = this.map.get(key);
		if (exp === undefined) return false;
		if (exp <= now) {
			this.map.delete(key);
			return false;
		}
		return true;
	}

	prune(now: number): void {
		for (const [k, exp] of this.map) {
			if (exp <= now) this.map.delete(k);
			else break; // entries are roughly time-ordered; stop at first live one
		}
	}

	get size(): number {
		return this.map.size;
	}
}
