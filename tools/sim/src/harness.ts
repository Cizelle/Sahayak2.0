/**
 * Simulation harness: spins up N MeshEngine instances — the exact production
 * engine — each bound to a SimulatedTransport on a shared Medium and driven by a
 * shared deterministic SimClock. Collects the metrics that the evaluation
 * reports: delivery ratio, per-message latency, hop count proxy, and total air
 * transmissions (the storm / efficiency metric).
 */
import {
	generateIdentity,
	MeshEngine,
	toPublic,
	type DeliveredMessage,
	type EngineEvent,
	type PublicIdentity,
	type SecretIdentity,
} from "../../../packages/core/src/index.ts";
import { NodeCryptoProvider } from "../../../packages/core/src/crypto/nodeProvider.ts";
import { mulberry32 } from "./prng.ts";
import { SimClock } from "./simClock.ts";
import { Medium, type MediumConfig } from "./medium.ts";
import { SimulatedTransport } from "./simTransport.ts";

export class Metrics {
	readonly sendTimes = new Map<string, number>();
	readonly deliverTimes = new Map<string, number>();
	tx = 0;
	relays = 0;
	reoffers = 0;
	suppressed = 0;
	dropped = 0;
	delivered = 0;
	keyChanges = 0;

	recordSend(traceId: string, at: number): void {
		this.sendTimes.set(traceId, at);
	}

	onEvent(e: EngineEvent): void {
		switch (e.kind) {
			case "tx":
				this.tx++;
				if (e.what === "relay") this.relays++;
				else if (e.what === "reoffer") this.reoffers++;
				return;
			case "suppress":
				this.suppressed++;
				return;
			case "drop":
				this.dropped++;
				return;
			case "key-change":
				this.keyChanges++;
				return;
			default:
				return;
		}
	}

	recordDeliver(traceId: string, at: number): void {
		if (this.deliverTimes.has(traceId)) return; // count first delivery only
		this.deliverTimes.set(traceId, at);
		this.delivered++;
	}

	/** Latencies (ms) for every delivered, previously-sent message. */
	latencies(): number[] {
		const out: number[] = [];
		for (const [traceId, at] of this.deliverTimes) {
			const sent = this.sendTimes.get(traceId);
			if (sent !== undefined) out.push(at - sent);
		}
		return out;
	}
}

export interface SimNode {
	readonly id: string;
	readonly index: number;
	readonly engine: MeshEngine;
	readonly transport: SimulatedTransport;
	readonly identity: SecretIdentity;
	received: DeliveredMessage[];
}

export interface BuildOptions {
	n: number;
	seed: number;
	medium?: MediumConfig;
	maxChunkBytes?: number;
	mtu?: number;
	defaultTtlMs?: number;
	queueCapacity?: number;
}

export interface Network {
	nodes: SimNode[];
	clock: SimClock;
	medium: Medium;
	metrics: Metrics;
	contacts: Map<string, PublicIdentity>;
}

export async function buildNetwork(opts: BuildOptions): Promise<Network> {
	const clock = new SimClock();
	const metrics = new Metrics();
	const medium = new Medium(clock, mulberry32(opts.seed ^ 0x9e3779b9), opts.medium ?? {});
	const crypto = new NodeCryptoProvider();

	const identities: SecretIdentity[] = [];
	for (let i = 0; i < opts.n; i++) identities.push(await generateIdentity(crypto));
	const contacts = new Map<string, PublicIdentity>(identities.map((id) => [id.nodeId, toPublic(id)]));

	const nodes: SimNode[] = [];
	for (let i = 0; i < opts.n; i++) {
		const identity = identities[i]!;
		const transport = new SimulatedTransport(identity.nodeId, medium, { mtu: opts.mtu ?? 0 });
		const node: SimNode = {
			id: identity.nodeId,
			index: i,
			engine: undefined as never,
			transport,
			identity,
			received: [],
		};
		const engine = new MeshEngine({
			identity,
			crypto,
			clock,
			rand: mulberry32(opts.seed + i + 1),
			transports: [transport],
			contacts: new Map(contacts),
			maxChunkBytes: opts.maxChunkBytes ?? 480,
			defaultTtlMs: opts.defaultTtlMs ?? 10 * 60_000,
			queueCapacity: opts.queueCapacity ?? 256,
			onMessage: (m) => {
				node.received.push(m);
				metrics.recordDeliver(m.traceId, clock.now());
			},
			onEvent: (e) => metrics.onEvent(e),
		});
		(node as { engine: MeshEngine }).engine = engine;
		engine.start();
		nodes.push(node);
	}
	return { nodes, clock, medium, metrics, contacts };
}

/** Connect nodes in a line: 0-1-2-...-(n-1). Classic multi-hop worst case. */
export function lineTopology(net: Network): void {
	for (let i = 0; i + 1 < net.nodes.length; i++) {
		net.medium.linkUp(net.nodes[i]!.id, net.nodes[i + 1]!.id);
	}
}

/** Fully-connected cluster: every node hears every other. Storm stress test. */
export function fullyConnected(net: Network): void {
	for (let i = 0; i < net.nodes.length; i++) {
		for (let j = i + 1; j < net.nodes.length; j++) {
			net.medium.linkUp(net.nodes[i]!.id, net.nodes[j]!.id);
		}
	}
}

/** Random geometric-ish graph: each pair linked with probability p (seeded). */
export function randomGraph(net: Network, p: number, seed: number): void {
	const rng = mulberry32(seed);
	for (let i = 0; i < net.nodes.length; i++) {
		for (let j = i + 1; j < net.nodes.length; j++) {
			if (rng() < p) net.medium.linkUp(net.nodes[i]!.id, net.nodes[j]!.id);
		}
	}
}

export function mean(xs: number[]): number {
	return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

export function percentile(xs: number[], p: number): number {
	if (xs.length === 0) return 0;
	const sorted = [...xs].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
	return sorted[idx]!;
}
