/**
 * TypeScript accessors for the Android TurboModules. These wrap the native
 * Kotlin modules (BleTransport, NearbyTransport, SmsSos, MeshService) and adapt
 * them to the core `Transport` interface so the SAME pure-TS engine that runs
 * in tests/sim drives the radios on-device.
 *
 * DEVICE-REQUIRED: NativeModules.* are null in JS-only environments (sandbox,
 * Jest without the native build). The guards below degrade gracefully so the
 * UI can render and unit logic can be exercised without hardware.
 */
import { DeviceEventEmitter, NativeModules, Platform } from "react-native";

type NativeBle = {
	startAdvertising(serviceId: string): Promise<void>;
	startScanning(serviceId: string): Promise<void>;
	stop(): Promise<void>;
	/** Send a length-prefixed binary frame (base64) to a connected peer. */
	sendFrame(peerId: string, base64Frame: string): Promise<void>;
	negotiatedMtu(peerId: string): Promise<number>;
};

type NativeNearby = {
	startAdvertising(serviceId: string): Promise<void>;
	startDiscovery(serviceId: string): Promise<void>;
	stop(): Promise<void>;
	sendFrame(peerId: string, base64Frame: string): Promise<void>;
};

type NativeSms = {
	/** Play-store flavor: opens the SMS composer via smsto: intent (no SEND_SMS perm). */
	composeSos(phone: string, body: string): Promise<void>;
	/** Sideload flavor only: sends directly via SmsManager (requires SEND_SMS). */
	sendSosDirect(phone: string, body: string): Promise<boolean>;
	isDirectSendAvailable(): Promise<boolean>;
};

type NativeService = {
	/** Starts the connectedDevice foreground service AFTER perms are granted. */
	start(): Promise<void>;
	stop(): Promise<void>;
	/** Returns true only if all BLE/Nearby runtime perms are granted. */
	ensurePermissions(): Promise<boolean>;
};

type NativePrefs = {
	getItem(key: string): Promise<string | null>;
	setItem(key: string, value: string): Promise<boolean>;
	removeItem(key: string): Promise<boolean>;
};

/** A device location fix returned by the native MeshLocation module. */
export interface NativeLocationFix {
	lat: number;
	lon: number;
	accuracyM: number;
	tsMs: number;
	/** Which Android provider produced the fix. */
	source: "gps" | "network";
}

type NativeLocation = {
	/**
	 * Best available device fix. Returns a recent last-known fix immediately when
	 * one is fresher than maxAgeMs, otherwise requests a single live update and
	 * resolves within timeoutMs. Rejects when location is off/denied/unavailable.
	 */
	getLocation(maxAgeMs: number, timeoutMs: number): Promise<NativeLocationFix>;
};

/** A picked attachment returned by the native MeshMedia module. */
export interface NativePickedMedia {
	base64: string;
	mime: string;
	name: string;
	size: number;
}

type NativeMedia = {
	/**
	 * Opens the system document picker (ACTION_GET_CONTENT/SAF) and returns the
	 * chosen file as base64 + metadata. maxBytes guards against OOM on huge
	 * files; the picker rejects with "too_large" when exceeded. Rejects with
	 * "cancelled" when the user backs out.
	 */
	pick(maxBytes: number): Promise<NativePickedMedia>;
	/** Save base64 bytes to shared storage (Pictures for images, Downloads otherwise). Resolves to the saved file name. */
	saveToGallery(base64: string, mime: string, name: string): Promise<string>;
	/** Write bytes to the app cache and open them in an external app via a FileProvider content URI. */
	openMedia(base64: string, mime: string, name: string): Promise<boolean>;
};

/**
 * System radio/service state queries (real device Bluetooth/Wi-Fi/Location
 * adapter state). Used to show the TRUE on/off state of each tier and to prompt
 * the user to switch a radio on. Android forbids apps from toggling these
 * silently, so promptEnable* open the system enable dialog / settings panel.
 */
type NativeSystem = {
	isBluetoothEnabled(): Promise<boolean>;
	isWifiEnabled(): Promise<boolean>;
	isLocationEnabled(): Promise<boolean>;
	promptEnableBluetooth(): Promise<boolean>;
	promptEnableWifi(): Promise<boolean>;
	promptEnableLocation(): Promise<boolean>;
};

const NM = NativeModules as Record<string, unknown>;

export const BleTransport = (NM["BleTransport"] ?? null) as NativeBle | null;
export const NearbyTransport = (NM["NearbyTransport"] ?? null) as NativeNearby | null;
export const SmsSos = (NM["SmsSos"] ?? null) as NativeSms | null;
export const MeshService = (NM["MeshService"] ?? null) as NativeService | null;
export const MeshPrefs = (NM["MeshPrefs"] ?? null) as NativePrefs | null;
export const MeshLocation = (NM["MeshLocation"] ?? null) as NativeLocation | null;
export const MeshMedia = (NM["MeshMedia"] ?? null) as NativeMedia | null;
export const MeshSystem = (NM["MeshSystem"] ?? null) as NativeSystem | null;

export const nativeAvailable = Platform.OS === "android" && BleTransport !== null;

/** Incoming-frame events emitted by the native side: { peerId, base64Frame, tier }. */
export interface NativeFrameEvent {
	peerId: string;
	base64Frame: string;
	tier: "wifi" | "ble";
}

/** Neighbor up/down events emitted by the native side on connect/disconnect. */
export interface NativeNeighborEvent {
	peerId: string;
	tier: "wifi" | "ble";
	up: boolean;
	/** Optional link quality in dBm (BLE RSSI). Absent/0 when unknown. */
	rssi?: number;
}

// The native modules emit "meshFrame"/"meshNeighbor" through RCTDeviceEventEmitter
// (see BleTransportModule.emitFrame/emitNeighbor), so we subscribe on the global
// DeviceEventEmitter rather than constructing a NativeEventEmitter around a
// specific module (there is no dedicated "MeshEvents" module).
export function onNativeFrame(cb: (e: NativeFrameEvent) => void): () => void {
	if (BleTransport === null) return () => {};
	const sub = DeviceEventEmitter.addListener("meshFrame", cb);
	return () => sub.remove();
}

export function onNativeNeighbor(cb: (e: NativeNeighborEvent) => void): () => void {
	if (BleTransport === null) return () => {};
	const sub = DeviceEventEmitter.addListener("meshNeighbor", cb);
	return () => sub.remove();
}
