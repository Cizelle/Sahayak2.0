/**
 * MeshEngine — the pure-TS orchestrator. It owns identity, crypto, routing,
 * congestion, store-and-forward and reassembly, and speaks only to the Transport
 * interface and the Clock. No platform APIs, no wall-clock, no globals: the same
 * instance runs unchanged in the deterministic simulator and on a real device.
 *
 * Message lifecycle:
 *   send() -> seal (per-chunk ECIES envelope) -> store-for-reoffer -> flood now
 *             if any neighbor exists, else wait for a neighbor to appear.
 *   recv MSG -> Router decides deliver / rebroadcast(once) / suppress / drop.
 *   neighbor up -> anti-entropy: re-offer all non-expired stored envelopes to the
 *                  new neighbor (this is what carries messages across a healed
 *                  partition). Receivers dedup, so re-offers never storm.
 */
import { toHex, utf8 } from "./bytes.ts";
import type { Clock, TimerHandle } from "./clock.ts";
import { decodeEnvelope, encodeEnvelope } from "./codec.ts";
import { CongestionController, type CongestionConfig } from "./congestion.ts";
import { DedupCache, type DedupOptions } from "./dedup.ts";
import { openEnvelope, Reassembler, sealEnvelope, splitPlaintext } from "./envelope.ts";
import { decodeHello, encodeHello, type Hello } from "./hello.ts";
import type { NodeId, PublicIdentity, SecretIdentity } from "./identity.ts";
import { MemoryStore, type PersistenceStore, type StoredMessage } from "./persistence.ts";
import { DEFAULT_ROUTER, Router } from "./router.ts";
import type { BackoffConfig } from "./scheduler.ts";
import type { Transport, IncomingFrame, PeerHandle } from "./transport.ts";
import { createUlidFactory, type UlidFactory } from "./ulid.ts";
import {
	DEFAULT_HOP_LIMIT,
	dedupKey,
	FrameType,
	MAX_HOP_LIMIT,
	PROTOCOL_VERSION,
	type Envelope,
	type Frame,
	type Header,
	type Mode,
	type Priority,
} from "./types.ts";

export interface DeliveredMessage {
	from: NodeId;
	to: NodeId;
	plaintext: Uint8Array;
	prio: Priority;
	traceId: string;
}

export interface SendOptions {
	prio?: Priority;
	mode?: Mode;
	ttlMs?: number;
	hopLimit?: number;
}

export type EngineEvent =
	| { kind: "tx"; what: "originate" | "relay" | "reoffer"; key: string; via: string }
	| { kind: "deliver"; from: NodeId; traceId: string }
	| { kind: "suppress"; key: string; reason: string }
	| { kind: "drop"; key: string; reason: string }
	| { kind: "store"; key: string }
	| { kind: "key-change"; nodeId: NodeId }
	| { kind: "neighbor"; peer: PeerHandle; up: boolean };

export interface EngineConfig {
	identity: SecretIdentity;
	crypto: import("./crypto/provider.ts").CryptoProvider;
	clock: Clock;
	rand: () => number;
	transports: Transport[];
	/**
	 * Optional human-friendly device name advertised to neighbors in HELLO. Not
	 * unique and never used for routing. Purely a display label.
	 */
	name?: string;
	/** Known recipient identities (nodeId -> public keys) needed to seal to them. */
	contacts?: Map<NodeId, PublicIdentity>;
	dedup?: DedupOptions;
	router?: Partial<typeof DEFAULT_ROUTER>;
	backoff?: BackoffConfig;
	congestion?: CongestionConfig;
	store?: PersistenceStore;
	maxChunkBytes?: number;
	defaultTtlMs?: number;
	queueCapacity?: number;
	onMessage?: (m: DeliveredMessage) => void;
	onEvent?: (e: EngineEvent) => void;
}

interface ReassemblyState {
	re: Reassembler;
	from: NodeId;
	to: NodeId;
	prio: Priority;
	traceId: string;
}

export class MeshEngine {
	readonly nodeId: NodeId;
	private readonly cfg: Required<Pick<EngineConfig, "maxChunkBytes" | "defaultTtlMs" | "queueCapacity">>;
	private readonly crypto: EngineConfig["crypto"];
	private readonly ulid: UlidFactory;
	private readonly identity: SecretIdentity;
	private readonly clock: Clock;
	private readonly rand: () => number;
	private readonly transports: Transport[];
	private readonly contacts: Map<NodeId, PublicIdentity>;
	/** nodeId -> last-seen human-friendly device name advertised via HELLO. */
	private readonly peerNames = new Map<NodeId, string>();
	/** This node's advertised display name (may be empty). */
	private selfName: string;
	private readonly dedup: DedupCache;
	private readonly router: Router;
	private readonly congestion: CongestionController;
	private readonly store: PersistenceStore;
	private readonly onMessage: ((m: DeliveredMessage) => void) | undefined;
	private readonly onEvent: ((e: EngineEvent) => void) | undefined;

	/** transport-name|peer -> learned neighbor node id. */
	private readonly peerToNode = new Map<string, NodeId>();
	/** node id -> { transport, peer } for direct routing. */
	private readonly nodeToPeer = new Map<NodeId, { transport: Transport; peer: PeerHandle }>();
	private readonly signPin = new Map<NodeId, string>();
	private readonly reasm = new Map<string, ReassemblyState>();
	private readonly timers = new Set<TimerHandle>();
	private started = false;

	constructor(config: EngineConfig) {
		this.identity = config.identity;
		this.nodeId = config.identity.nodeId;
		this.crypto = config.crypto;
		this.ulid = createUlidFactory((n) => this.crypto.randomBytes(n));
		this.clock = config.clock;
		this.rand = config.rand;
		this.transports = config.transports;
		this.contacts = config.contacts ?? new Map();
		this.selfName = config.name ?? "";
		this.onMessage = config.onMessage;
		this.onEvent = config.onEvent;
		this.cfg = {
			maxChunkBytes: config.maxChunkBytes ?? 480,
			defaultTtlMs: config.defaultTtlMs ?? 10 * 60_000,
			queueCapacity: config.queueCapacity ?? 256,
		};
		this.dedup = new DedupCache(config.dedup ?? { maxEntries: 4096, ttlMs: 15 * 60_000 });
		this.congestion = new CongestionController(config.congestion);
		this.store = config.store ?? new MemoryStore();
		this.router = new Router({ selfId: this.nodeId, rand: this.rand, ...DEFAULT_ROUTER, ...config.router }, this.dedup);
	}

	/** Register a contact so we can seal messages addressed to them. */
	addContact(id: PublicIdentity): void {
		this.contacts.set(id.nodeId, id);
	}

	/**
	 * Snapshot of all identities this node can currently seal to: peers learned
	 * from HELLO frames plus any contacts seeded via config/addContact. The UI
	 * uses this to render the peer list. Returns a copy so callers cannot mutate
	 * the engine's internal map.
	 */
	knownContacts(): PublicIdentity[] {
		return [...this.contacts.values()];
	}

	/**
	 * The human-friendly name a peer last advertised via HELLO, if any. The UI
	 * falls back to a short hash when this is undefined.
	 */
	peerName(nodeId: NodeId): string | undefined {
		const n = this.peerNames.get(nodeId);
		return n && n.length > 0 ? n : undefined;
	}

	/** Update this node's advertised display name. Re-greets current neighbors. */
	setName(name: string): void {
		this.selfName = name;
		if (!this.started) return;
		// Re-greet every currently-connected neighbor so they pick up the new name
		// without waiting for a churn event.
		for (const { transport, peer } of this.nodeToPeer.values()) {
			void transport.send({ type: FrameType.HELLO, payload: encodeHello(this.makeHello()) }, peer);
		}
	}

	/** Build the HELLO frame advertising this node's identity + display name. */
	private makeHello(): Hello {
		const hello: Hello = {
			nodeId: this.nodeId,
			signPub: this.identity.signPub,
			kexPub: this.identity.kexPub,
		};
		if (this.selfName.length > 0) hello.name = this.selfName;
		return hello;
	}

	start(): void {
		if (this.started) return;
		this.started = true;
		for (const t of this.transports) {
			t.onFrame((msg) => this.onIncoming(t, msg));
			t.onNeighbor((peer, up) => this.onNeighbor(t, peer, up));
			void t.start();
		}
	}

	stop(): void {
		this.started = false;
		for (const h of this.timers) this.clock.clearTimer(h);
		this.timers.clear();
		for (const t of this.transports) void t.stop();
	}

	private emit(e: EngineEvent): void {
		this.onEvent?.(e);
	}

	private availableTransports(): Transport[] {
		return this.transports.filter((t) => t.isAvailable());
	}

	private anyNeighbor(): boolean {
		return this.availableTransports().some((t) => t.neighbors().length > 0);
	}

	private schedule(delayMs: number, cb: () => void): void {
		const h = this.clock.setTimer(delayMs, () => {
			this.timers.delete(h);
			cb();
		});
		this.timers.add(h);
	}

	private updateLoad(): void {
		this.congestion.update(Math.min(1, this.store.size() / this.cfg.queueCapacity));
	}

	// --- Sending ------------------------------------------------------------

	/** Seal `plaintext` for `dst` and inject it into the mesh. Returns traceId. */
	async send(dst: NodeId, plaintext: Uint8Array, opts: SendOptions = {}): Promise<string> {
		const recipient = this.contacts.get(dst);
		if (!recipient) throw new Error(`unknown contact ${dst}: cannot seal (need kexPub)`);
		const prio = opts.prio ?? "normal";
		const mode: Mode = opts.mode ?? "flood";
		const ttlMs = opts.ttlMs ?? this.cfg.defaultTtlMs;
		const hopLimit = Math.min(MAX_HOP_LIMIT, opts.hopLimit ?? DEFAULT_HOP_LIMIT);
		const traceId = this.ulid(this.clock.now());
		const chunks = splitPlaintext(plaintext, this.cfg.maxChunkBytes);

		for (let i = 0; i < chunks.length; i++) {
			const payload = chunks[i]!;
			const header: Header = {
				v: PROTOCOL_VERSION,
				id: this.ulid(this.clock.now()),
				traceId,
				src: this.nodeId,
				dst,
				ts: this.clock.now(),
				ttlMs,
				hopLimit,
				hop: 0,
				prio,
				mode,
				payloadHash: await this.crypto.sha256(payload),
				chunkIndex: i,
				chunkCount: chunks.length,
			};
			const env = await sealEnvelope(this.crypto, header, payload, recipient, this.identity);
			const key = dedupKey(env.header.src, env.header.id);
			// Our own originated id should never be relayed back to us.
			this.dedup.add(key, this.clock.now());
			this.persist(env, key);
			if (this.anyNeighbor()) this.flood(env, key, "originate");
		}
		return traceId;
	}

	/** Convenience helper for emergency payloads. */
	sendSos(dst: NodeId, text: string): Promise<string> {
		return this.send(dst, utf8(text), { prio: "sos", mode: "sos", hopLimit: MAX_HOP_LIMIT });
	}

	private persist(env: Envelope, key: string): void {
		const now = this.clock.now();
		const bytes = encodeEnvelope(env);
		const m: StoredMessage = {
			key,
			dst: env.header.dst,
			bytes,
			prio: env.header.prio,
			createdAt: now,
			expiresAt: env.header.ts + env.header.ttlMs,
			attempts: 0,
			nextAttempt: now,
		};
		this.store.put(m);
		this.emit({ kind: "store", key });
		this.updateLoad();
	}

	/** Broadcast (flood) an envelope across every available mesh transport. */
	private flood(env: Envelope, key: string, what: "originate" | "relay" | "reoffer"): void {
		if (!this.congestion.admits(env.header.prio)) {
			this.emit({ kind: "suppress", key, reason: `congestion-${this.congestion.state}` });
			return;
		}
		const frame: Frame = { type: FrameType.MSG, payload: encodeEnvelope(env) };
		const direct = this.nodeToPeer.get(env.header.dst);
		if (direct && direct.transport.isAvailable()) {
			void direct.transport.send(frame, direct.peer);
			this.emit({ kind: "tx", what, key, via: `${direct.transport.name}->${direct.peer}` });
			return;
		}
		for (const t of this.availableTransports()) {
			if (t.neighbors().length === 0) continue;
			void t.send(frame);
			this.emit({ kind: "tx", what, key, via: t.name });
		}
	}

	// --- Receiving ----------------------------------------------------------

	private onIncoming(transport: Transport, msg: IncomingFrame): void | Promise<void> {
		const frame = msg.frame;
		switch (frame.type) {
			case FrameType.HELLO:
				this.handleHello(transport, msg.from, decodeHello(frame.payload));
				return;
			case FrameType.MSG:
				// Receive is async (decrypt/verify). Return the in-flight promise so a
				// deterministic driver (the simulator's virtual clock) can await the
				// full decrypt/deliver chain before advancing time; production
				// transports simply ignore the return value. Never let a rejection
				// become an unhandled promise — surface it as a drop instead.
				return this.handleMsg(decodeEnvelope(frame.payload)).catch((err) => {
					this.emit({ kind: "drop", key: "receive", reason: `receive-error: ${(err as Error).message}` });
				});
			default:
				// ACK/ROUTE_ADV/CONGESTION/KEEPALIVE/ERROR: reserved for later phases.
				return;
		}
	}

	private handleHello(transport: Transport, peer: PeerHandle, hello: Hello): void {
		const pkey = `${transport.name}|${peer}`;
		this.peerToNode.set(pkey, hello.nodeId);
		this.nodeToPeer.set(hello.nodeId, { transport, peer });
		const pinned = this.signPin.get(hello.nodeId);
		const seen = toHex(hello.signPub);
		if (pinned && pinned !== seen) this.emit({ kind: "key-change", nodeId: hello.nodeId });
		if (!pinned) this.signPin.set(hello.nodeId, seen);
		if (!this.contacts.has(hello.nodeId)) {
			this.contacts.set(hello.nodeId, { nodeId: hello.nodeId, signPub: hello.signPub, kexPub: hello.kexPub });
		}
		if (hello.name && hello.name.length > 0) this.peerNames.set(hello.nodeId, hello.name);
	}

	private async handleMsg(env: Envelope): Promise<void> {
		const now = this.clock.now();
		// Expiry by relative TTL budget (clock-skew safe: TTL is a duration).
		if (env.header.ts + env.header.ttlMs <= now && env.header.dst !== this.nodeId) {
			this.emit({ kind: "drop", key: dedupKey(env.header.src, env.header.id), reason: "expired" });
			return;
		}
		const dec = this.router.onReceive(env, now);
		switch (dec.type) {
			case "deliver":
				if (!dec.duplicate) await this.deliver(env);
				return;
			case "rebroadcast": {
				// Epidemic store: keep a copy to re-offer to future neighbors too.
				const relayed = this.cloneWithHop(env, env.header.hop + 1);
				this.persist(relayed, dec.key);
				this.schedule(dec.delayMs, () => {
					if (this.router.onRebroadcastDue(dec.key)) this.flood(relayed, dec.key, "relay");
					else this.emit({ kind: "suppress", key: dec.key, reason: "neighbor-relayed" });
				});
				return;
			}
			case "suppress":
				this.emit({ kind: "suppress", key: dedupKey(env.header.src, env.header.id), reason: dec.reason });
				return;
			case "drop":
				this.emit({ kind: "drop", key: dedupKey(env.header.src, env.header.id), reason: dec.reason });
				return;
		}
	}

	private cloneWithHop(env: Envelope, hop: number): Envelope {
		return { ...env, header: { ...env.header, hop } };
	}

	private async deliver(env: Envelope): Promise<void> {
		const res = await openEnvelope(this.crypto, env, this.identity);
		if (!res.ok) {
			this.emit({ kind: "drop", key: dedupKey(env.header.src, env.header.id), reason: `open-${res.reason}` });
			return;
		}
		// Pin sender key (TOFU) and warn on change.
		const seen = toHex(env.srcSignPub);
		const pinned = this.signPin.get(env.header.src);
		if (pinned && pinned !== seen) this.emit({ kind: "key-change", nodeId: env.header.src });
		if (!pinned) this.signPin.set(env.header.src, seen);

		const groupKey = `${env.header.src}|${env.header.traceId}`;
		let st = this.reasm.get(groupKey);
		if (!st) {
			st = {
				re: new Reassembler(env.header.chunkCount),
				from: env.header.src,
				to: env.header.dst,
				prio: env.header.prio,
				traceId: env.header.traceId,
			};
			this.reasm.set(groupKey, st);
		}
		st.re.add(env.header.chunkIndex, res.plaintext);
		if (st.re.complete) {
			this.reasm.delete(groupKey);
			this.emit({ kind: "deliver", from: st.from, traceId: st.traceId });
			this.onMessage?.({
				from: st.from,
				to: st.to,
				plaintext: st.re.assemble(),
				prio: st.prio,
				traceId: st.traceId,
			});
		}
	}

	// --- Neighbor churn / anti-entropy --------------------------------------

	private onNeighbor(transport: Transport, peer: PeerHandle, up: boolean): void {
		this.emit({ kind: "neighbor", peer, up });
		if (up) {
			// Greet, then re-offer everything we are holding (epidemic anti-entropy).
			void transport.send({ type: FrameType.HELLO, payload: encodeHello(this.makeHello()) }, peer);
			this.reoffer(transport, peer);
		} else {
			const pkey = `${transport.name}|${peer}`;
			const node = this.peerToNode.get(pkey);
			this.peerToNode.delete(pkey);
			if (node && this.nodeToPeer.get(node)?.peer === peer) this.nodeToPeer.delete(node);
		}
	}

	private reoffer(transport: Transport, peer: PeerHandle): void {
		const now = this.clock.now();
		this.store.prune(now);
		for (const m of this.store.all()) {
			if (m.expiresAt <= now) continue;
			if (!this.congestion.admits(m.prio)) continue;
			void transport.send({ type: FrameType.MSG, payload: m.bytes }, peer);
			this.emit({ kind: "tx", what: "reoffer", key: m.key, via: `${transport.name}->${peer}` });
		}
		this.updateLoad();
	}

	// --- Introspection (for tests, UI, observability) -----------------------

	/**
	 * Node ids we currently have a direct neighbor link to (learned via HELLO).
	 * The UI uses this to mark peers as "connected" vs merely known/saved
	 * (item #4).
	 */
	connectedNodes(): NodeId[] {
		return [...this.nodeToPeer.keys()];
	}

	/**
	 * Link info for a directly-connected node: the carrying transport's name and
	 * an optional signal strength in dBm (item #4). Returns undefined if the node
	 * is not a direct neighbor.
	 */
	linkFor(nodeId: NodeId): { transport: string; rssi?: number } | undefined {
		const link = this.nodeToPeer.get(nodeId);
		if (!link) return undefined;
		const out: { transport: string; rssi?: number } = { transport: link.transport.name };
		const rssi = link.transport.signalOf?.(link.peer);
		if (typeof rssi === "number") out.rssi = rssi;
		return out;
	}

	stats(): { stored: number; dedup: number; congestion: string; neighbors: number } {
		return {
			stored: this.store.size(),
			dedup: this.dedup.size,
			congestion: this.congestion.state,
			neighbors: this.nodeToPeer.size,
		};
	}
}
