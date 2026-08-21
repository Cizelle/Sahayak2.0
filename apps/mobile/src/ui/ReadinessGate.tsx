/**
 * Blocking readiness gate. This is the honest, Play-compliant equivalent of
 * "force everything on": Android will not let any app silently grant a
 * permission or switch on Bluetooth/Location, so instead we DEMAND them up
 * front and refuse to render the app until every requirement is satisfied.
 *
 * Flow (re-runs on every "continue" tap):
 *   1. request all runtime permissions          (system dialogs)
 *   2. if Bluetooth is off -> launch enable prompt, re-check
 *   3. if Location is off  -> launch settings,    re-check
 *   4. start the mesh (foreground service + engine + auto-discovery)
 * Permanently-denied permissions deep-link to App Settings.
 */
import React, { useCallback, useEffect, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from "react-native";
import { meshController } from "../mesh/MeshController.ts";
import { openAppSettings, requestMeshPermissions } from "../native/permissions.ts";
import { isBluetoothOn, isLocationOn, promptEnableBluetooth, promptEnableLocation } from "../native/system.ts";

type Phase = "checking" | "need-perms" | "need-bluetooth" | "need-location" | "blocked" | "ready" | "error";

export function ReadinessGate({ children }: { children: React.ReactNode }): React.JSX.Element {
	const [phase, setPhase] = useState<Phase>("checking");
	const [detail, setDetail] = useState("");

	const run = useCallback(async () => {
		try {
			setPhase("checking");
			const perms = await requestMeshPermissions();
			if (!perms.granted) {
				if (perms.blocked.length > 0) {
					setDetail("Some permissions were permanently denied. Open Settings to enable Bluetooth & nearby access.");
					setPhase("blocked");
					return;
				}
				setDetail("Bluetooth and nearby-device permissions are required to find other phones.");
				setPhase("need-perms");
				return;
			}
			if (!(await isBluetoothOn())) {
				await promptEnableBluetooth();
				if (!(await isBluetoothOn())) {
					setDetail("Bluetooth must be ON to reach nearby devices.");
					setPhase("need-bluetooth");
					return;
				}
			}
			if (!(await isLocationOn())) {
				await promptEnableLocation();
				if (!(await isLocationOn())) {
					setDetail("Location services must be ON — Android requires it for device discovery.");
					setPhase("need-location");
					return;
				}
			}
			await meshController.start();
			setPhase("ready");
		} catch (err) {
			setDetail(err instanceof Error ? err.message : String(err));
			setPhase("error");
		}
	}, []);

	useEffect(() => {
		void run();
	}, [run]);

	if (phase === "ready") return <>{children}</>;

	const showAction = phase !== "checking";
	const actionLabel = phase === "blocked" ? "Open Settings" : "Grant & continue";
	const onAction = (): void => {
		if (phase === "blocked") void openAppSettings();
		else void run();
	};

	return (
		<View style={styles.wrap}>
			<Text style={styles.title}>Setting up the mesh</Text>
			{phase === "checking" ? (
				<ActivityIndicator color="#5b8cff" size="large" />
			) : (
				<Text style={styles.detail}>{detail}</Text>
			)}
			{showAction && (
				<Pressable style={styles.btn} onPress={onAction}>
					<Text style={styles.btnText}>{actionLabel}</Text>
				</Pressable>
			)}
			<Text style={styles.foot}>
				AdaptiveMesh needs Bluetooth, nearby Wi-Fi and Location turned ON to discover and connect to other devices.
				Messaging and SOS stay disabled until everything is enabled — after that, discovery and connection are fully
				automatic.
			</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { flex: 1, backgroundColor: "#0a0e1a", alignItems: "center", justifyContent: "center", padding: 28, gap: 18 },
	title: { color: "#eaf0ff", fontSize: 22, fontWeight: "700" },
	detail: { color: "#aab6d6", fontSize: 15, textAlign: "center", lineHeight: 21 },
	btn: { backgroundColor: "#5b8cff", paddingVertical: 12, paddingHorizontal: 26, borderRadius: 12 },
	btnText: { color: "#06122e", fontSize: 16, fontWeight: "700" },
	foot: { color: "#56648a", fontSize: 12, textAlign: "center", lineHeight: 18, marginTop: 6 },
});
