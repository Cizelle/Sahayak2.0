/**
 * Persistence abstraction for store-and-forward + outbound retry queues.
 *
 * The engine depends only on PersistenceStore. MemoryStore is the portable,
 * fully-tested default used by the simulator and unit tests; SqliteStore (see
 * persistenceSqlite.ts) is the durable on-device implementation backed by
 * node:sqlite / expo-sqlite. Keeping the interface here keeps the core free of
 * any platform dependency.
 */
import type { Priority } from "./types.ts";

export interface StoredMessage {
	/** Unique per (src,id,chunkIndex). */
	key: string;
	dst: string;
	/** Encoded MSG-frame payload (the serialized envelope). */
	bytes: Uint8Array;
	prio: Priority;
	createdAt: number;
	expiresAt: number;
	attempts: number;
	nextAttempt: number;
}

export interface PersistenceStore {
	put(m: StoredMessage): void;
	get(key: string): StoredMessage | undefined;
	delete(key: string): void;
	/** Non-expired entries whose nextAttempt <= now, highest priority first. */
	due(now: number): StoredMessage[];
	all(): StoredMessage[];
	/** Remove expired entries; returns how many were dropped. */
	prune(now: number): number;
	size(): number;
}

const PRIO_ORDER: Record<Priority, number> = { sos: 0, control: 1, normal: 2, bulk: 3 };

export class MemoryStore implements PersistenceStore {
	private readonly map = new Map<string, StoredMessage>();
	constructor(private readonly maxEntries = 5000) {}

	put(m: StoredMessage): void {
		this.map.set(m.key, m);
		if (this.map.size > this.maxEntries) {
			// Evict the entry expiring soonest (least useful to keep).
			let evict: StoredMessage | undefined;
			for (const v of this.map.values()) {
				if (!evict || v.expiresAt < evict.expiresAt) evict = v;
			}
			if (evict) this.map.delete(evict.key);
		}
	}

	get(key: string): StoredMessage | undefined {
		return this.map.get(key);
	}

	delete(key: string): void {
		this.map.delete(key);
	}

	due(now: number): StoredMessage[] {
		const out: StoredMessage[] = [];
		for (const m of this.map.values()) {
			if (m.expiresAt > now && m.nextAttempt <= now) out.push(m);
		}
		out.sort((a, b) => PRIO_ORDER[a.prio] - PRIO_ORDER[b.prio] || a.nextAttempt - b.nextAttempt);
		return out;
	}

	all(): StoredMessage[] {
		return [...this.map.values()];
	}

	prune(now: number): number {
		let n = 0;
		for (const [k, m] of this.map) {
			if (m.expiresAt <= now) {
				this.map.delete(k);
				n++;
			}
		}
		return n;
	}

	size(): number {
		return this.map.size;
	}
}
