/**
 * The single transport abstraction. The pure-TS engine talks ONLY to this
 * interface; every radio (BLE, Nearby, Wi-Fi Aware, Internet relay, SMS-SOS)
 * and the SimulatedTransport implement it identically. This is what lets the
 * exact same routing/crypto code run in a deterministic simulator and on a real
 * Android device.
 */
import type { Frame, TransportTier } from "./types.ts";

/** A transport-local handle for a neighbor (e.g. a BLE connection id). */
export type PeerHandle = string;

export interface IncomingFrame {
	frame: Frame;
	from: PeerHandle;
	transport: string;
}

export type FrameHandler = (msg: IncomingFrame) => void | Promise<void>;
export type NeighborHandler = (peer: PeerHandle, up: boolean) => void;

export interface Transport {
	readonly name: string;
	readonly tier: TransportTier;
	/** Whether this transport can currently carry traffic (radio on, perms ok). */
	isAvailable(): boolean;
	start(): Promise<void> | void;
	stop(): Promise<void> | void;
	/** Unicast to `peer`, or broadcast to all current neighbors if omitted. */
	send(frame: Frame, peer?: PeerHandle): Promise<void> | void;
	neighbors(): PeerHandle[];
	onFrame(handler: FrameHandler): void;
	onNeighbor(handler: NeighborHandler): void;
	/**
	 * Optional link-quality hint for a neighbor, in dBm (e.g. BLE RSSI). Used by
	 * the UI to render a signal level (item #4). Transports without a meaningful
	 * signal (Internet relay, Wi-Fi Nearby) may omit this or return undefined.
	 */
	signalOf?(peer: PeerHandle): number | undefined;
}
