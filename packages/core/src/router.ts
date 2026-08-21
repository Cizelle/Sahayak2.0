/**
 * Managed / controlled flooding (Meshtastic-style), the heart of the mesh.
 *
 * On receiving an addressed envelope a node:
 *   - delivers it if it is the destination (recording the id so duplicates are
 *     ignored), OR
 *   - relays it exactly ONCE: the first copy schedules a rebroadcast after a
 *     small random contention delay; any further copies heard during that delay
 *     increment a counter, and if enough neighbors already relayed it we SUPPRESS
 *     our own rebroadcast. This is what collapses an exponential broadcast storm
 *     into roughly one transmission per node.
 *
 * Loop/replay freedom comes from the (src,id) dedup cache; the signed `hopLimit`
 * strictly bounds depth even against a misbehaving relay that resets `hop`.
 */
import type { DedupCache } from "./dedup.ts";
import { contentionDelay } from "./scheduler.ts";
import type { NodeId } from "./identity.ts";
import type { Envelope } from "./types.ts";
import { dedupKey } from "./types.ts";

export type RouteDecision =
	| { type: "deliver"; key: string; duplicate: boolean }
	| { type: "rebroadcast"; key: string; delayMs: number }
	| { type: "suppress"; reason: string }
	| { type: "drop"; reason: "hop-limit" | "expired" };

export interface RouterConfig {
	selfId: NodeId;
	contentionMinMs: number;
	contentionMaxMs: number;
	/** Suppress our rebroadcast if we hear this many duplicates while waiting. */
	suppressionThreshold: number;
	rand: () => number;
}

export const DEFAULT_ROUTER: Omit<RouterConfig, "selfId" | "rand"> = {
	contentionMinMs: 20,
	contentionMaxMs: 120,
	suppressionThreshold: 2,
};

export class Router {
	/** key -> number of duplicate copies heard while a rebroadcast is pending. */
	private readonly heard = new Map<string, number>();

	constructor(
		private readonly cfg: RouterConfig,
		private readonly dedup: DedupCache,
	) {}

	/**
	 * Decide what to do with a freshly received envelope.
	 * `now` is the injected clock time (deterministic in simulation).
	 */
	onReceive(env: Envelope, now: number): RouteDecision {
		const key = dedupKey(env.header.src, env.header.id);
		const forSelf = env.header.dst === this.cfg.selfId;

		if (forSelf) {
			const fresh = this.dedup.add(key, now);
			return { type: "deliver", key, duplicate: !fresh };
		}

		// Relay path. Enforce the signed hop budget first.
		if (env.header.hop >= env.header.hopLimit) {
			this.dedup.add(key, now);
			return { type: "drop", reason: "hop-limit" };
		}

		const fresh = this.dedup.add(key, now);
		if (!fresh) {
			if (this.heard.has(key)) this.heard.set(key, (this.heard.get(key) ?? 0) + 1);
			return { type: "suppress", reason: "duplicate" };
		}

		this.heard.set(key, 0);
		const delayMs = contentionDelay(this.cfg.contentionMinMs, this.cfg.contentionMaxMs, this.cfg.rand);
		return { type: "rebroadcast", key, delayMs };
	}

	/** Called when a rebroadcast contention timer fires. */
	onRebroadcastDue(key: string): boolean {
		const heard = this.heard.get(key) ?? 0;
		this.heard.delete(key);
		return heard < this.cfg.suppressionThreshold;
	}

	get pendingCount(): number {
		return this.heard.size;
	}
}
