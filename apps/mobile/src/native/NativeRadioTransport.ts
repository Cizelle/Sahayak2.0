/**
 * One real offline radio (Wi-Fi-Direct/Nearby OR Bluetooth-LE) presented to the
 * engine as a single-tier `Transport`. It is the per-tier successor to the old
 * combined RnMeshTransport: splitting the radios lets the UI show each mode's
 * own status (item #5) and toggle each independently for demos (item #6).
 *
 * Protocol stays 100% in the portable core: outbound Frames are serialized with
 * the real length-prefixed codec and inbound radio bytes are stitched back into
 * whole Frames with the real FrameReader, so on-device behavior matches the
 * simulated tests exactly. This class is just a typed pipe + an enable switch.
 *
 * Native contract (DeviceEventEmitter):
 *   "meshFrame"    { peerId, base64Frame, tier:"wifi"|"ble" }
 *   "meshNeighbor" { peerId, tier:"wifi"|"ble", up }
 * Events are filtered by `wire` so each transport only sees its own radio.
 */
import {
	encodeFrame,
	FrameReader,
	TransportTier,
	type Frame,
	type FrameHandler,
	type IncomingFrame,
	type NeighborHandler,
	type PeerHandle,
	type Transport,
} from "@adaptivemesh/core";
import { Buffer } from "buffer";
import { nativeAvailable, onNativeFrame, onNativeNeighbor, type NativeFrameEvent, type NativeNeighborEvent } from "./MeshNative.ts";

const toB64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

export interface NativeRadioOptions {
	/** Transport.name, e.g. "rn-wifi" / "rn-ble". */
	name: string;
	tier: TransportTier;
	/** Event wire tag to filter DeviceEventEmitter events. */
	wire: "wifi" | "ble";
	/** Start advertising + scanning on this radio (no-op resolves if module missing). */
	startRadio: () => Promise<void>;
	/** Stop advertising + scanning on this radio. */
	stopRadio: () => Promise<void>;
	/** Send base64 frame bytes to a peer (or "*" for broadcast). */
	sendFrame: (target: PeerHandle, base64Frame: string) => Promise<void>;
	enabled?: boolean;
}

export class NativeRadioTransport implements Transport {
	readonly name: string;
	readonly tier: TransportTier;
	private readonly wire: "wifi" | "ble";
	private readonly startRadio: () => Promise<void>;
	private readonly stopRadio: () => Promise<void>;
	private readonly sendFrame: (target: PeerHandle, base64Frame: string) => Promise<void>;

	private enabled: boolean;
	private started = false;
	private frameHandler: FrameHandler | undefined;
	private neighborHandler: NeighborHandler | undefined;
	private readonly readers = new Map<PeerHandle, FrameReader>();
	private readonly peers = new Set<PeerHandle>();
	/** Last-known link quality (dBm) per neighbor, when the radio reports it. */
	private readonly rssiByPeer = new Map<PeerHandle, number>();
	private disposers: Array<() => void> = [];

	constructor(opts: NativeRadioOptions) {
		this.name = opts.name;
		this.tier = opts.tier;
		this.wire = opts.wire;
		this.startRadio = opts.startRadio;
		this.stopRadio = opts.stopRadio;
		this.sendFrame = opts.sendFrame;
		this.enabled = opts.enabled ?? true;
	}

	isAvailable(): boolean {
		return this.started && this.enabled && nativeAvailable;
	}

	isEnabled(): boolean {
		return this.enabled;
	}

	neighborCount(): number {
		return this.peers.size;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.disposers.push(
			onNativeFrame((e) => {
				if (e.tier === this.wire) this.onRadioBytes(e);
			}),
			onNativeNeighbor((e) => {
				if (e.tier === this.wire) this.onRadioNeighbor(e);
			}),
		);
		if (this.enabled) await this.safeStart();
	}

	async stop(): Promise<void> {
		this.started = false;
		for (const d of this.disposers) d();
		this.disposers = [];
		this.dropAllPeers();
		await this.safeStop();
	}

	/** Item #6: turn this mode on/off live without tearing down the engine. */
	async setEnabled(on: boolean): Promise<void> {
		if (on === this.enabled) return;
		this.enabled = on;
		if (!this.started) return;
		if (on) {
			await this.safeStart();
		} else {
			this.dropAllPeers();
			await this.safeStop();
		}
	}

	async send(frame: Frame, peer?: PeerHandle): Promise<void> {
		if (!this.isAvailable()) return;
		await this.sendFrame(peer ?? "*", toB64(encodeFrame(frame.type, frame.payload)));
	}

	neighbors(): PeerHandle[] {
		return [...this.peers];
	}

	/** Item #4: BLE reports RSSI; Wi-Fi/Nearby does not, so this may be undefined. */
	signalOf(peer: PeerHandle): number | undefined {
		return this.rssiByPeer.get(peer);
	}

	onFrame(handler: FrameHandler): void {
		this.frameHandler = handler;
	}

	onNeighbor(handler: NeighborHandler): void {
		this.neighborHandler = handler;
	}

	private async safeStart(): Promise<void> {
		try {
			await this.startRadio();
		} catch {
			/* radio refused (perms/hardware) -> mode simply has no neighbors */
		}
	}

	private async safeStop(): Promise<void> {
		try {
			await this.stopRadio();
		} catch {
			/* ignore */
		}
	}

	private dropAllPeers(): void {
		const gone = [...this.peers];
		this.peers.clear();
		this.readers.clear();
		this.rssiByPeer.clear();
		for (const p of gone) this.neighborHandler?.(p, false);
	}

	private onRadioBytes(e: NativeFrameEvent): void {
		if (!this.enabled) return;
		let reader = this.readers.get(e.peerId);
		if (!reader) {
			reader = new FrameReader();
			this.readers.set(e.peerId, reader);
		}
		for (const frame of reader.push(fromB64(e.base64Frame))) {
			const msg: IncomingFrame = { frame, from: e.peerId, transport: this.name };
			this.frameHandler?.(msg);
		}
	}

	private onRadioNeighbor(e: NativeNeighborEvent): void {
		if (e.up) {
			this.peers.add(e.peerId);
			if (typeof e.rssi === "number" && e.rssi !== 0) this.rssiByPeer.set(e.peerId, e.rssi);
		} else {
			this.peers.delete(e.peerId);
			this.readers.delete(e.peerId);
			this.rssiByPeer.delete(e.peerId);
		}
		this.neighborHandler?.(e.peerId, e.up);
	}
}
