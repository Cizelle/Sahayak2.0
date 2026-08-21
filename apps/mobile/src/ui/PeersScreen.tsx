/**
 * Identity + neighbors.
 *
 * Item #2: every node has a PERMANENT hash id (persisted via identity seeds so
 * it never changes across launches) plus a human, non-unique device NAME the
 * user can set here and that is broadcast via HELLO.
 *
 * Item #4: each device row has a SAVE button (favorite the devices you want to
 * chat with), a live STATUS badge (connected / saved / offline) and a SIGNAL
 * LEVEL meter (BLE RSSI mapped to bars; Wi-Fi/Internet links show a nominal
 * level). Saved devices stay listed even when offline so you can re-find them.
 */
import React, { useEffect, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useMesh } from "../mesh/MeshContext.tsx";
import type { MeshPeer } from "../mesh/MeshController.ts";

function shortHash(nodeId: string): string {
	if (nodeId.length <= 20) return nodeId;
	return `${nodeId.slice(0, 10)}…${nodeId.slice(-6)}`;
}

/** Four-bar signal meter driven by level 0-4. */
function SignalBars({ level, connected }: { level: number; connected: boolean }): React.JSX.Element {
	return (
		<View style={styles.bars}>
			{[1, 2, 3, 4].map((n) => (
				<View
					key={n}
					style={[
						styles.bar,
						{ height: 5 + n * 3 },
						n <= level ? (connected ? styles.barOn : styles.barSaved) : styles.barOff,
					]}
				/>
			))}
		</View>
	);
}

function StatusBadge({ peer }: { peer: MeshPeer }): React.JSX.Element {
	const map = {
		connected: { label: "connected", style: styles.badgeConnected },
		saved: { label: "saved · offline", style: styles.badgeSaved },
		offline: { label: "offline", style: styles.badgeOffline },
	} as const;
	const info = map[peer.status];
	return (
		<Text style={[styles.badge, info.style]}>
			{info.label}
			{peer.connected && peer.tier ? ` · ${peer.tier.replace("rn-", "")}` : ""}
			{peer.connected && typeof peer.rssi === "number" ? ` · ${peer.rssi} dBm` : ""}
		</Text>
	);
}

/**
 * One device row: identity + status + save toggle (item #4). SOS phone numbers
 * are NOT set here — they live in Modes ▸ "SOS emergency numbers" as a single
 * shared list, so the same numbers are used no matter which device is nearby.
 */
function PeerRow({ peer }: { peer: MeshPeer }): React.JSX.Element {
	const { saveDevice, unsaveDevice } = useMesh();
	return (
		<View style={styles.row}>
			<View style={styles.rowTop}>
				<SignalBars level={peer.level} connected={peer.connected} />
				<View style={styles.rowText}>
					<Text style={styles.peer}>{peer.name && peer.name.length > 0 ? peer.name : `node-${peer.short}`}</Text>
					<Text style={styles.peerHash} selectable>
						{shortHash(peer.nodeId)}
					</Text>
					<StatusBadge peer={peer} />
				</View>
				<Pressable
					style={[styles.favBtn, peer.saved && styles.favOn]}
					onPress={() => void (peer.saved ? unsaveDevice(peer.nodeId) : saveDevice(peer.nodeId))}
				>
					<Text style={[styles.favText, peer.saved && styles.favTextOn]}>{peer.saved ? "★ Saved" : "☆ Save"}</Text>
				</Pressable>
			</View>
		</View>
	);
}

export function PeersScreen(): React.JSX.Element {
	const { peers, status, deviceName, selfShort, selfNodeId, setDeviceName } = useMesh();
	const [draft, setDraft] = useState(deviceName);
	useEffect(() => setDraft(deviceName), [deviceName]);
	const dirty = draft.trim() !== deviceName;

	return (
		<ScrollView contentContainerStyle={styles.wrap}>
			<View style={styles.selfCard}>
				<Text style={styles.selfLabel}>THIS DEVICE</Text>
				<View style={styles.nameRow}>
					<TextInput
						style={styles.nameInput}
						value={draft}
						onChangeText={setDraft}
						placeholder={`node-${selfShort || "…"}`}
						placeholderTextColor="#46557a"
						maxLength={32}
						onSubmitEditing={() => void setDeviceName(draft)}
					/>
					<Pressable
						style={[styles.saveBtn, !dirty && styles.saveOff]}
						onPress={() => dirty && void setDeviceName(draft)}
					>
						<Text style={styles.saveText}>Save</Text>
					</Pressable>
				</View>
				<Text style={styles.hashLabel}>Permanent ID</Text>
				<Text style={styles.hash} selectable>
					{selfNodeId || "—"}
				</Text>
			</View>

			<Text style={styles.heading}>Devices ({peers.length})</Text>
			{peers.length === 0 && (
				<Text style={styles.empty}>{status === "running" ? "Scanning for nearby devices…" : status}</Text>
			)}
			{peers.map((p) => (
				<PeerRow key={p.nodeId} peer={p} />
			))}
		</ScrollView>
	);
}

const styles = StyleSheet.create({
	wrap: { padding: 20, gap: 12 },
	selfCard: { backgroundColor: "#11192e", borderRadius: 14, padding: 16, gap: 8 },
	selfLabel: { color: "#6b7a99", fontSize: 11, fontWeight: "800", letterSpacing: 1 },
	nameRow: { flexDirection: "row", gap: 8 },
	nameInput: {
		flex: 1,
		backgroundColor: "#0c1222",
		borderRadius: 10,
		paddingHorizontal: 12,
		paddingVertical: 8,
		color: "#eaf0ff",
		fontSize: 16,
		fontWeight: "600",
	},
	saveBtn: { backgroundColor: "#5b8cff", borderRadius: 10, paddingHorizontal: 16, justifyContent: "center" },
	saveOff: { backgroundColor: "#2a3454" },
	saveText: { color: "#06122e", fontWeight: "800" },
	hashLabel: { color: "#6b7a99", fontSize: 11, fontWeight: "700", marginTop: 4 },
	hash: { color: "#9fb0d8", fontSize: 12, fontFamily: "monospace" },
	heading: { color: "#aab6d6", fontSize: 16, fontWeight: "700", marginTop: 8 },
	empty: { color: "#56648a", fontSize: 13 },
	row: {
		flexDirection: "column",
		gap: 10,
		backgroundColor: "#11192e",
		borderRadius: 12,
		padding: 12,
	},
	rowTop: { flexDirection: "row", alignItems: "center", gap: 12 },
	rowText: { flex: 1, gap: 2 },
	bars: { flexDirection: "row", alignItems: "flex-end", gap: 2, height: 18, width: 22 },
	bar: { width: 4, borderRadius: 1 },
	barOn: { backgroundColor: "#41d18a" },
	barSaved: { backgroundColor: "#5b8cff" },
	barOff: { backgroundColor: "#26304c" },
	peer: { color: "#eaf0ff", fontSize: 15, fontWeight: "600" },
	peerHash: { color: "#6b7a99", fontSize: 11, fontFamily: "monospace" },
	badge: { fontSize: 11, fontWeight: "700", marginTop: 2 },
	badgeConnected: { color: "#41d18a" },
	badgeSaved: { color: "#8aa0d0" },
	badgeOffline: { color: "#6b7a99" },
	favBtn: { backgroundColor: "#16203a", borderRadius: 10, paddingHorizontal: 12, paddingVertical: 8 },
	favOn: { backgroundColor: "#243a66" },
	favText: { color: "#9fb0d8", fontSize: 12, fontWeight: "700" },
	favTextOn: { color: "#ffd76a" },
});
