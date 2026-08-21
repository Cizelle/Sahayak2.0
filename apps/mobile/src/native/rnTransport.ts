/**
 * The on-device counterpart to tools/sim's SimulatedTransport: ONE combined
 * Transport over both radios (Nearby = Wi-Fi tier preferred, BLE fallback). It
 * implements the SAME `Transport` contract the engine talks to — it serializes
 * Frames with the real length-prefixed codec and reassembles inbound radio
 * bytes with the real FrameReader — so on-device behavior matches the simulated
 * tests. All protocol logic stays in the portable core; this is just a pipe.
 *
 * Native side contract (see MeshNative.ts + the Kotlin transports):
 *  - emits "meshFrame"    { peerId, base64Frame, tier } for inbound radio bytes
 *    (possibly fragmented; FrameReader stitches them back into whole frames)
 *  - emits "meshNeighbor" { peerId, tier, up } on connect / disconnect
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
import { BLE_SERVICE_UUID, NEARBY_SERVICE_ID } from "../mesh/config.ts";
import {
	BleTransport,
	nativeAvailable,
	NearbyTransport,
	onNativeFrame,
	onNativeNeighbor,
	type NativeFrameEvent,
	type NativeNeighborEvent,
} from "./MeshNative.ts";

const toB64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const fromB64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

export class RnMeshTransport implements Transport {
	readonly name = "rn-mesh";
	readonly tier: TransportTier = TransportTier.Wifi;

	private started = false;
	private frameHandler: FrameHandler | undefined;
	private neighborHandler: NeighborHandler | undefined;
	private readonly readers = new Map<PeerHandle, FrameReader>();
	private readonly peers = new Set<PeerHandle>();
	private disposers: Array<() => void> = [];

	isAvailable(): boolean {
		return this.started && nativeAvailable;
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		this.disposers.push(
			onNativeFrame((e) => this.onRadioBytes(e)),
			onNativeNeighbor((e) => this.onRadioNeighbor(e)),
		);
		// Auto-discovery: advertise + scan on BOTH radios with no user action.
		await Promise.allSettled([
			NearbyTransport?.startAdvertising(NEARBY_SERVICE_ID) ?? Promise.resolve(),
			NearbyTransport?.startDiscovery(NEARBY_SERVICE_ID) ?? Promise.resolve(),
			BleTransport?.startAdvertising(BLE_SERVICE_UUID) ?? Promise.resolve(),
			BleTransport?.startScanning(BLE_SERVICE_UUID) ?? Promise.resolve(),
		]);
	}

	async stop(): Promise<void> {
		this.started = false;
		for (const d of this.disposers) d();
		this.disposers = [];
		this.readers.clear();
		this.peers.clear();
		await Promise.allSettled([NearbyTransport?.stop() ?? Promise.resolve(), BleTransport?.stop() ?? Promise.resolve()]);
	}

	async send(frame: Frame, peer?: PeerHandle): Promise<void> {
		const payload = toB64(encodeFrame(frame.type, frame.payload));
		const target = peer ?? "*";
		// Prefer Wi-Fi (Nearby); fall back to BLE if Nearby can't carry it.
		try {
			if (!NearbyTransport) throw new Error("no-nearby");
			await NearbyTransport.sendFrame(target, payload);
		} catch {
			await BleTransport?.sendFrame(target, payload);
		}
	}

	neighbors(): PeerHandle[] {
		return [...this.peers];
	}

	onFrame(handler: FrameHandler): void {
		this.frameHandler = handler;
	}

	onNeighbor(handler: NeighborHandler): void {
		this.neighborHandler = handler;
	}

	private onRadioBytes(e: NativeFrameEvent): void {
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
		} else {
			this.peers.delete(e.peerId);
			this.readers.delete(e.peerId);
		}
		this.neighborHandler?.(e.peerId, e.up);
	}
}
