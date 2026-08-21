/**
 * SimulatedTransport implements the SAME Transport interface that the real BLE /
 * Nearby / relay transports implement, so the engine code under test is
 * byte-for-byte the production code. It even serializes frames with the real
 * length-prefixed codec and reassembles them with the real FrameReader, so the
 * simulator exercises the actual wire framing (including multi-fragment frames),
 * not a shortcut.
 */
import {
	encodeFrame,
	FrameReader,
	TransportTier,
	type Frame,
	type FrameHandler,
	type NeighborHandler,
	type PeerHandle,
	type Transport,
} from "../../../packages/core/src/index.ts";
import type { Medium, MediumEndpoint } from "./medium.ts";

export interface SimTransportOptions {
	name?: string;
	tier?: TransportTier;
	/** Optional max bytes per air-write; larger frames are fragmented (BLE-like). */
	mtu?: number;
}

export class SimulatedTransport implements Transport, MediumEndpoint {
	readonly name: string;
	readonly tier: TransportTier;
	readonly nodeId: string;
	private readonly medium: Medium;
	private readonly mtu: number;
	private available = true;
	private frameHandler: FrameHandler | undefined;
	private neighborHandler: NeighborHandler | undefined;
	private readonly readers = new Map<string, FrameReader>();

	constructor(nodeId: string, medium: Medium, opts: SimTransportOptions = {}) {
		this.nodeId = nodeId;
		this.medium = medium;
		this.name = opts.name ?? "sim";
		this.tier = opts.tier ?? TransportTier.Ble;
		this.mtu = opts.mtu ?? 0;
		medium.register(this);
	}

	isAvailable(): boolean {
		return this.available;
	}

	setAvailable(a: boolean): void {
		if (a === this.available) return;
		this.available = a;
		this.medium.onAvailabilityChange(this.nodeId, a);
	}

	start(): void {
		this.available = true;
	}

	stop(): void {
		this.available = false;
	}

	send(frame: Frame, peer?: PeerHandle): void {
		const bytes = encodeFrame(frame.type, frame.payload);
		if (this.mtu > 0 && bytes.length > this.mtu) {
			for (let off = 0; off < bytes.length; off += this.mtu) {
				this.medium.send(this.nodeId, bytes.subarray(off, Math.min(off + this.mtu, bytes.length)).slice(), peer);
			}
		} else {
			this.medium.send(this.nodeId, bytes, peer);
		}
	}

	neighbors(): PeerHandle[] {
		return this.medium.neighborsOf(this.nodeId);
	}

	onFrame(handler: FrameHandler): void {
		this.frameHandler = handler;
	}

	onNeighbor(handler: NeighborHandler): void {
		this.neighborHandler = handler;
	}

	// --- MediumEndpoint -----------------------------------------------------

	deliverBytes(from: string, bytes: Uint8Array): void | Promise<void> {
		let reader = this.readers.get(from);
		if (!reader) {
			reader = new FrameReader();
			this.readers.set(from, reader);
		}
		// The engine's receive path is async (decrypt/verify). Collect the in-flight
		// promises so the Medium can register them with the SimClock, which awaits
		// them before advancing virtual time — the key to deterministic delivery.
		const inflight: Array<Promise<void>> = [];
		for (const frame of reader.push(bytes)) {
			const r = this.frameHandler?.({ frame, from, transport: this.name });
			if (r) inflight.push(r);
		}
		if (inflight.length === 1) return inflight[0];
		if (inflight.length > 1) return Promise.all(inflight).then(() => {});
		return;
	}

	neighborChange(peer: string, up: boolean): void {
		this.neighborHandler?.(peer, up);
	}
}
