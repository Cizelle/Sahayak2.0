/**
 * Communication modes + settings (items #2, #5, #6).
 *
 * Lists every tier in the exact fallback priority order the engine uses
 * (Internet -> Wi-Fi Direct -> Bluetooth LE -> SMS), shows each one's live
 * status, highlights the mode currently CARRYING traffic, and exposes a switch
 * to enable/disable each tier on the fly. Toggles persist across launches.
 *
 * Item #5: the Internet tier needs a relay/signalling endpoint, configured here
 * (Relay URL). Saving it restarts the engine so the Internet transport binds to
 * the new endpoint. Wi-Fi + BLE discover and connect automatically with no URL.
 *
 * Item #2: the SOS emergency phone number used for the SMS fallback is set here
 * so a real text can be delivered when only the cellular tier is available.
 */
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from "react-native";
import { useMesh } from "../mesh/MeshContext.tsx";

const TRACK_COLOR = { false: "#2a3454", true: "#274690" } as const;

export function ModesScreen(): React.JSX.Element {
	const {
		modes,
		activeModeId,
		setModeEnabled,
		relayUrl,
		emergencyNumbers,
		setRelayUrl,
		addEmergencyNumber,
		removeEmergencyNumber,
	} = useMesh();
	const [relayDraft, setRelayDraft] = useState(relayUrl);
	const [numberDraft, setNumberDraft] = useState("");
	useEffect(() => setRelayDraft(relayUrl), [relayUrl]);
	const relayDirty = relayDraft.trim() !== relayUrl;
	const canAddNumber = numberDraft.trim().length > 0;

	function onAddNumber(): void {
		if (!canAddNumber) return;
		void addEmergencyNumber(numberDraft);
		setNumberDraft("");
	}

	return (
		<ScrollView contentContainerStyle={styles.wrap}>
			<Text style={styles.heading}>Communication modes</Text>
			<Text style={styles.sub}>In fallback priority order. The highlighted mode is the one currently in use.</Text>
			{modes.map((m, i) => (
				<View key={m.id} style={[styles.row, m.active && styles.rowActive]}>
					<View style={styles.rank}>
						<Text style={styles.rankNum}>{i + 1}</Text>
					</View>
					<View style={styles.info}>
						<View style={styles.titleRow}>
							<Text style={styles.name}>{m.label}</Text>
							{m.active && <Text style={styles.activeTag}>IN USE</Text>}
						</View>
						<Text style={styles.blurb}>{m.blurb}</Text>
						<Text style={[styles.detail, m.active && styles.detailActive]}>{m.detail}</Text>
					</View>
					<Switch
						value={m.enabled}
						onValueChange={(on) => void setModeEnabled(m.id, on)}
						trackColor={TRACK_COLOR}
						thumbColor="#eaf0ff"
					/>
				</View>
			))}
			<Text style={styles.foot}>
				{activeModeId
					? `Active path: ${modes.find((m) => m.id === activeModeId)?.label ?? activeModeId}.`
					: "No connected path yet — searching on every enabled mode."}
			</Text>

			<Text style={styles.heading}>Internet relay</Text>
			<Text style={styles.sub}>
				The Internet tier syncs through a relay endpoint (wss:// or https://). Leave blank to run purely offline on
				Wi-Fi + BLE. Saving restarts the mesh.
			</Text>
			<View style={styles.settingRow}>
				<TextInput
					style={styles.input}
					value={relayDraft}
					onChangeText={setRelayDraft}
					placeholder="wss://relay.example.com"
					placeholderTextColor="#46557a"
					autoCapitalize="none"
					autoCorrect={false}
					keyboardType="url"
				/>
				<Pressable
					style={[styles.applyBtn, !relayDirty && styles.applyOff]}
					onPress={() => relayDirty && void setRelayUrl(relayDraft.trim())}
				>
					<Text style={styles.applyText}>Apply</Text>
				</Pressable>
			</View>

			<Text style={styles.heading}>SOS emergency numbers</Text>
			<Text style={styles.sub}>
				When the mesh can't reach anyone, the SOS button texts these numbers (with your location). Add as many as you
				like — include the country code, e.g. +14155550123.
			</Text>
			{emergencyNumbers.length > 0 ? (
				<View style={styles.numberList}>
					{emergencyNumbers.map((n) => (
						<View key={n} style={styles.numberChip}>
							<Text style={styles.numberText}>{n}</Text>
							<Pressable hitSlop={8} onPress={() => void removeEmergencyNumber(n)}>
								<Text style={styles.numberRemove}>✕</Text>
							</Pressable>
						</View>
					))}
				</View>
			) : (
				<Text style={styles.numberEmpty}>No SOS numbers saved yet.</Text>
			)}
			<View style={styles.settingRow}>
				<TextInput
					style={styles.input}
					value={numberDraft}
					onChangeText={setNumberDraft}
					placeholder="+1 415 555 0123"
					placeholderTextColor="#46557a"
					keyboardType="phone-pad"
					onSubmitEditing={onAddNumber}
				/>
				<Pressable style={[styles.applyBtn, !canAddNumber && styles.applyOff]} onPress={onAddNumber}>
					<Text style={styles.applyText}>Add</Text>
				</Pressable>
			</View>
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	wrap: { padding: 20, gap: 12 },
	heading: { color: "#eaf0ff", fontSize: 18, fontWeight: "800", marginTop: 8 },
	sub: { color: "#6b7a99", fontSize: 13, marginBottom: 4 },
	row: {
		flexDirection: "row",
		alignItems: "center",
		gap: 12,
		backgroundColor: "#11192e",
		borderRadius: 14,
		padding: 14,
		borderWidth: 1,
		borderColor: "transparent",
	},
	rowActive: { borderColor: "#5b8cff", backgroundColor: "#16213f" },
	rank: {
		width: 26,
		height: 26,
		borderRadius: 13,
		backgroundColor: "#0c1222",
		alignItems: "center",
		justifyContent: "center",
	},
	rankNum: { color: "#8aa0d0", fontSize: 13, fontWeight: "800" },
	info: { flex: 1, gap: 2 },
	titleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
	name: { color: "#eaf0ff", fontSize: 16, fontWeight: "700" },
	activeTag: {
		color: "#06122e",
		backgroundColor: "#41d18a",
		fontSize: 10,
		fontWeight: "800",
		paddingHorizontal: 6,
		paddingVertical: 2,
		borderRadius: 6,
		overflow: "hidden",
	},
	blurb: { color: "#6b7a99", fontSize: 12 },
	detail: { color: "#9fb0d8", fontSize: 13, fontWeight: "600", marginTop: 2 },
	detailActive: { color: "#41d18a" },
	foot: { color: "#56648a", fontSize: 12, lineHeight: 18, marginTop: 6 },
	settingRow: { flexDirection: "row", gap: 8 },
	input: {
		flex: 1,
		backgroundColor: "#0c1222",
		borderRadius: 10,
		paddingHorizontal: 12,
		paddingVertical: 10,
		color: "#eaf0ff",
		fontSize: 15,
	},
	applyBtn: { backgroundColor: "#5b8cff", borderRadius: 10, paddingHorizontal: 16, justifyContent: "center" },
	applyOff: { backgroundColor: "#2a3454" },
	applyText: { color: "#06122e", fontWeight: "800" },
	numberList: { gap: 8 },
	numberChip: {
		flexDirection: "row",
		alignItems: "center",
		justifyContent: "space-between",
		backgroundColor: "#11192e",
		borderRadius: 10,
		paddingHorizontal: 14,
		paddingVertical: 10,
	},
	numberText: { color: "#eaf0ff", fontSize: 15, fontWeight: "600" },
	numberRemove: { color: "#ff6b81", fontSize: 16, fontWeight: "800" },
	numberEmpty: { color: "#56648a", fontSize: 13 },
});
