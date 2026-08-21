/**
 * Runtime permission acquisition for the mesh radios.
 *
 * HONEST ANDROID NOTE: an app cannot silently grant permissions — the OS always
 * shows its own dialog and the user must tap Allow. The strongest "forced" UX
 * possible is therefore to (a) request every required permission up front, and
 * (b) refuse to run the mesh until they are all granted (enforced by
 * ReadinessGate). If the user permanently denies one, we deep-link to App
 * Settings so they can flip it manually.
 *
 * DEVICE-REQUIRED: PermissionsAndroid is a no-op on non-Android / JS-only
 * sandboxes; requestMeshPermissions resolves { granted: true } there so the UI
 * remains reviewable without hardware.
 */
import { Linking, PermissionsAndroid, Platform } from "react-native";

type AndroidPermission = (typeof PermissionsAndroid.PERMISSIONS)[keyof typeof PermissionsAndroid.PERMISSIONS];

export interface PermissionReport {
	granted: boolean;
	/** Permanently denied ("Don't ask again") — needs a Settings visit. */
	blocked: string[];
	/** Denied this round but still re-requestable. */
	denied: string[];
}

function androidApiLevel(): number {
	return typeof Platform.Version === "number" ? Platform.Version : parseInt(String(Platform.Version), 10);
}

/** Permissions that are nice-to-have but must NOT block mesh readiness. */
function isOptional(perm: string): boolean {
	const P = PermissionsAndroid.PERMISSIONS;
	if (perm === P.SEND_SMS || perm === P.POST_NOTIFICATIONS) return true;
	// Coarse location only ever helps the SOS location fix - never block on it.
	if (perm === P.ACCESS_COARSE_LOCATION) return true;
	// Fine location is required for BLE scanning before Android 12, but on 12+
	// it is used only for SOS GPS, so it must not block mesh readiness there.
	if (perm === P.ACCESS_FINE_LOCATION) return androidApiLevel() >= 31;
	return false;
}

function requiredPermissions(): AndroidPermission[] {
	if (Platform.OS !== "android") return [];
	const P = PermissionsAndroid.PERMISSIONS;
	const api = androidApiLevel();
	const list: AndroidPermission[] = [];
	if (api >= 31) {
		list.push(P.BLUETOOTH_SCAN, P.BLUETOOTH_ADVERTISE, P.BLUETOOTH_CONNECT);
	} else {
		// Pre-Android 12: BLE scanning is gated behind fine location.
		list.push(P.ACCESS_FINE_LOCATION);
	}
	// SOS GPS (item #2): request precise + coarse location on every Android
	// version. On 12+ these are optional (BLE uses neverForLocation) but they
	// power the SOS location fix; the Set below dedupes the pre-12 fine entry.
	list.push(P.ACCESS_FINE_LOCATION, P.ACCESS_COARSE_LOCATION);
	if (api >= 33) {
		list.push(P.NEARBY_WIFI_DEVICES, P.POST_NOTIFICATIONS);
	}
	// Sideload flavor can send the SOS SMS directly; harmless to request elsewhere.
	if (P.SEND_SMS) list.push(P.SEND_SMS);
	return Array.from(new Set(list));
}

/**
 * Requests every required permission and reports the outcome. `granted` is true
 * only when all *critical* (non-optional) permissions are granted.
 */
export async function requestMeshPermissions(): Promise<PermissionReport> {
	if (Platform.OS !== "android") return { granted: true, blocked: [], denied: [] };
	const perms = requiredPermissions();
	if (perms.length === 0) return { granted: true, blocked: [], denied: [] };
	const result = await PermissionsAndroid.requestMultiple(perms);
	const blocked: string[] = [];
	const denied: string[] = [];
	for (const perm of perms) {
		if (isOptional(perm)) continue;
		const outcome = result[perm];
		if (outcome === PermissionsAndroid.RESULTS.NEVER_ASK_AGAIN) blocked.push(perm);
		else if (outcome !== PermissionsAndroid.RESULTS.GRANTED) denied.push(perm);
	}
	return { granted: blocked.length === 0 && denied.length === 0, blocked, denied };
}

/** Deep-link to the app's system settings page (for permanently denied perms). */
export function openAppSettings(): Promise<void> {
	return Linking.openSettings();
}
