/**
 * A shared broadcast radio medium. Models what BLE/Wi-Fi-Aware actually give
 * you: an undirected adjacency graph, per-transmission packet loss, and a
 * propagation/scheduling delay. A node `send()` reaches every current neighbor
 * (true broadcast), each independently subject to loss and delay. Link churn
 * (mobility / partitions) is expressed by linkUp / linkDown / setAvailable,
 * which fire the neighbor up/down callbacks the engine relies on.
 */
import type { Rng } from "./prng.ts";
import type { SimClock } from "./simClock.ts";

export interface MediumEndpoint {
	readonly nodeId: string;
	isAvailable(): boolean;
	deliverBytes(from: string, bytes: Uint8Array): void | Promise<void>;
	neighborChange(peer: string, up: boolean): void;
}

export interface MediumConfig {
	/** Probability [0,1] that any single transmission to a neighbor is lost. */
	lossRate?: number;
	minDelayMs?: number;
	maxDelayMs?: number;
}

export interface MediumStats {
	transmissions: number; // air transmissions (one broadcast = one)
	deliveries: number; // successful per-neighbor receptions
	drops: number; // per-neighbor losses
}

export class Medium {
	private readonly endpoints = new Map<string, MediumEndpoint>();
	private readonly adj = new Map<string, Set<string>>();
	readonly stats: MediumStats = { transmissions: 0, deliveries: 0, drops: 0 };
	private readonly loss: number;
	private readonly minD: number;
	private readonly maxD: number;

	constructor(
		private readonly clock: SimClock,
		private readonly rng: Rng,
		cfg: MediumConfig = {},
	) {
		this.loss = cfg.lossRate ?? 0;
		this.minD = cfg.minDelayMs ?? 5;
		this.maxD = cfg.maxDelayMs ?? 25;
	}

	register(ep: MediumEndpoint): void {
		this.endpoints.set(ep.nodeId, ep);
		if (!this.adj.has(ep.nodeId)) this.adj.set(ep.nodeId, new Set());
	}

	private up(n: string): boolean {
		return this.endpoints.get(n)?.isAvailable() ?? false;
	}

	linkUp(a: string, b: string): void {
		if (a === b) return;
		const had = this.adj.get(a)?.has(b) ?? false;
		this.adj.get(a)?.add(b);
		this.adj.get(b)?.add(a);
		if (!had && this.up(a) && this.up(b)) {
			this.endpoints.get(a)?.neighborChange(b, true);
			this.endpoints.get(b)?.neighborChange(a, true);
		}
	}

	linkDown(a: string, b: string): void {
		const had = this.adj.get(a)?.has(b) ?? false;
		this.adj.get(a)?.delete(b);
		this.adj.get(b)?.delete(a);
		if (had && this.up(a) && this.up(b)) {
			this.endpoints.get(a)?.neighborChange(b, false);
			this.endpoints.get(b)?.neighborChange(a, false);
		}
	}

	/** Toggle a node's radio. Fires neighbor up/down to all adjacent live nodes. */
	onAvailabilityChange(node: string, on: boolean): void {
		for (const peer of this.adj.get(node) ?? []) {
			if (!this.up(peer)) continue;
			this.endpoints.get(node)?.neighborChange(peer, on);
			this.endpoints.get(peer)?.neighborChange(node, on);
		}
	}

	neighborsOf(node: string): string[] {
		if (!this.up(node)) return [];
		return [...(this.adj.get(node) ?? [])].filter((p) => this.up(p));
	}

	send(from: string, bytes: Uint8Array, peer?: string): void {
		if (!this.up(from)) return;
		const all = this.adj.get(from);
		if (!all) return;
		const targets = peer ? [peer] : [...all];
		this.stats.transmissions++;
		for (const t of targets) {
			if (!all.has(t) || !this.up(t)) continue;
			if (this.rng() < this.loss) {
				this.stats.drops++;
				continue;
			}
			const delay = this.minD + this.rng() * (this.maxD - this.minD);
			const target = this.endpoints.get(t);
			if (!target) continue;
			this.clock.setTimer(delay, () => {
				this.stats.deliveries++;
				// The receive may be async (decrypt/verify); hand the promise to the
				// clock so run() awaits it before advancing virtual time.
				const inflight = target.deliverBytes(from, bytes);
				if (inflight) this.clock.trackAsync(inflight);
			});
		}
	}
}
