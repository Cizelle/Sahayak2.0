/**
 * Bridge to MeshSystemModule (Kotlin): query and prompt the Bluetooth and
 * Location *services* themselves (distinct from runtime permissions). Android
 * forbids silently enabling either, so promptEnable* launches the system
 * dialog/settings; the ReadinessGate re-checks is*On afterward and stays
 * blocking until both are on.
 *
 * DEVICE-REQUIRED: resolves to "already on / success" on non-Android sandboxes
 * so the UI remains reviewable without hardware.
 */
import { NativeModules, Platform } from "react-native";

interface NativeSystem {
	isBluetoothEnabled(): Promise<boolean>;
	isLocationEnabled(): Promise<boolean>;
	promptEnableBluetooth(): Promise<boolean>;
	promptEnableLocation(): Promise<boolean>;
}

const Native = ((NativeModules as Record<string, unknown>)["MeshSystem"] ?? null) as NativeSystem | null;

export const systemControlsAvailable = Platform.OS === "android" && Native !== null;

export function isBluetoothOn(): Promise<boolean> {
	return Native ? Native.isBluetoothEnabled() : Promise.resolve(true);
}

export function isLocationOn(): Promise<boolean> {
	return Native ? Native.isLocationEnabled() : Promise.resolve(true);
}

export function promptEnableBluetooth(): Promise<boolean> {
	return Native ? Native.promptEnableBluetooth() : Promise.resolve(true);
}

export function promptEnableLocation(): Promise<boolean> {
	return Native ? Native.promptEnableLocation() : Promise.resolve(true);
}
