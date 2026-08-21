/**
 * One-tap SOS (item #2). The MeshController does the real work:
 *   1. Resolves a location GPS-first, then borrows the freshest location a
 *      nearby peer shared over the mesh, else sends an honest "no location".
 *   2. Crafts a rich, human-readable SOS (who, when, where, map link, note).
 *   3. Floods an E2E-sealed copy to every known mesh peer AND sends it over SMS
 *      to the saved emergency number (direct send on the sideload flavor, the
 *      system composer otherwise).
 * This screen only triggers that and reports exactly what happened.
 */
import React, { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, { Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { useMesh } from "../mesh/MeshContext.tsx";

function locationNote(loc: { source: string; fromDevice?: string } | null): string {
	if (!loc) return "No location available — sent SOS without coordinates.";
	if (loc.source === "peer")
		return `Location borrowed from a nearby device${loc.fromDevice ? ` (${loc.fromDevice})` : ""} — approximate.`;
	return `Location included from this device's ${loc.source === "gps" ? "GPS" : "network"} fix.`;
}

export function SosButton(): React.JSX.Element {
	const { sendSos, peers, emergencyNumbers } = useMesh();
	const [busy, setBusy] = useState(false);
	const [note, setNote] = useState("One tap: flood an SOS to every device in range and text your emergency contact.");
	const pulse = useSharedValue(1);

	useEffect(() => {
		pulse.value = withRepeat(withTiming(1.18, { duration: 900, easing: Easing.inOut(Easing.ease) }), -1, true);
	}, [pulse]);

	const ring = useAnimatedStyle(() => ({ transform: [{ scale: pulse.value }], opacity: 2 - pulse.value }));

	async function onSos(): Promise<void> {
		if (busy) return;
		setBusy(true);
		try {
			const { meshRecipients, sms, smsRecipients, location } = await sendSos();
			const parts: string[] = [];
			parts.push(
				meshRecipients > 0
					? `Flooded to ${meshRecipients} mesh peer${meshRecipients === 1 ? "" : "s"}.`
					: "No mesh peer in range.",
			);
			if (sms === "sent") parts.push(`SMS sent to ${smsRecipients} contact${smsRecipients === 1 ? "" : "s"}.`);
			else if (sms === "composer")
				parts.push(`Opened the SMS composer for ${smsRecipients} contact${smsRecipients === 1 ? "" : "s"} — tap send.`);
			else if (sms === "no_number")
				parts.push("No SOS numbers saved — set an emergency number or add numbers to saved devices.");
			else parts.push("SMS fallback is off.");
			parts.push(locationNote(location));
			setNote(parts.join(" "));
		} finally {
			setBusy(false);
		}
	}

	return (
		<View style={styles.wrap}>
			<View style={styles.center}>
				<Animated.View style={[styles.ring, ring]} />
				<Pressable style={styles.button} onPress={() => void onSos()}>
					<Text style={styles.label}>SOS</Text>
				</Pressable>
			</View>
			<Text style={styles.peers}>
				{peers.length} mesh peer{peers.length === 1 ? "" : "s"} known·{" "}
				{emergencyNumbers.length > 0
					? `SMS → ${emergencyNumbers.length} contact${emergencyNumbers.length === 1 ? "" : "s"}`
					: "no SMS contact set"}
			</Text>
			<Text style={styles.note}>{note}</Text>
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { flex: 1, alignItems: "center", justifyContent: "center", gap: 16, padding: 24 },
	center: { width: 240, height: 240, alignItems: "center", justifyContent: "center" },
	ring: { position: "absolute", width: 220, height: 220, borderRadius: 110, backgroundColor: "#ff5b6e" },
	button: {
		width: 170,
		height: 170,
		borderRadius: 85,
		backgroundColor: "#ff3b52",
		alignItems: "center",
		justifyContent: "center",
	},
	label: { color: "#fff", fontSize: 44, fontWeight: "900", letterSpacing: 3 },
	peers: { color: "#aab6d6", fontSize: 14, textAlign: "center" },
	note: { color: "#56648a", fontSize: 13, textAlign: "center", lineHeight: 19 },
});
