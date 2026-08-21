/**
 * Communication-mode metadata (items #5 and #6).
 *
 * The four tiers are listed in the EXACT fallback priority the engine uses:
 * Internet (0) -> Wi-Fi Direct (1) -> Bluetooth LE (2) -> SMS (3). Lower
 * `priority` = tried first. The controller turns this static table into live
 * `MeshMode` rows (available / enabled / active + a human detail string).
 */
import { TransportTier } from "@adaptivemesh/core";

export type ModeId = "internet" | "wifi" | "ble" | "sms";

export interface ModeDef {
	id: ModeId;
	label: string;
	tier: TransportTier;
	/** 0 = highest priority (tried first). Mirrors TransportTier ordering. */
	priority: number;
	blurb: string;
}

export const MODE_DEFS: readonly ModeDef[] = [
	{ id: "internet", label: "Internet", tier: TransportTier.Internet, priority: 0, blurb: "Encrypted relay over the internet" },
	{ id: "wifi", label: "Wi-Fi Direct", tier: TransportTier.Wifi, priority: 1, blurb: "Nearby Connections (offline Wi-Fi)" },
	{ id: "ble", label: "Bluetooth LE", tier: TransportTier.Ble, priority: 2, blurb: "BLE GATT mesh (offline)" },
	{ id: "sms", label: "SMS", tier: TransportTier.Sms, priority: 3, blurb: "Cellular SOS fallback" },
] as const;

/** A live snapshot of one mode for the UI. */
export interface MeshMode extends ModeDef {
	/** User toggle (item #6). */
	enabled: boolean;
	/** Hardware / configuration actually supports it right now. */
	available: boolean;
	/** This is the mode currently carrying traffic (highest usable tier). */
	active: boolean;
	/** Short status line, e.g. "2 peers", "off", "not configured". */
	detail: string;
}
