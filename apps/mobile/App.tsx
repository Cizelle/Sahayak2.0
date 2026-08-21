/**
 * AdaptiveMesh app shell.
 *
 * MeshProvider exposes the live mesh state; ReadinessGate forces every
 * permission/service ON and then auto-starts the mesh before any screen is
 * shown. After that, discovery + connection + relaying are automatic; the
 * manual surfaces are the Chat composer, recipient selection, mode toggles,
 * and the SOS button. The header shows this node, its peer count, and which
 * communication mode is currently in use.
 */
import React, { useState } from "react";
import { Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { MeshProvider, useMesh } from "./src/mesh/MeshContext.tsx";
import { ReadinessGate } from "./src/ui/ReadinessGate.tsx";
import { ChatScreen } from "./src/ui/ChatScreen.tsx";
import { PeersScreen } from "./src/ui/PeersScreen.tsx";
import { ModesScreen } from "./src/ui/ModesScreen.tsx";
import { SosButton } from "./src/ui/SosButton.tsx";

type Tab = "chat" | "peers" | "modes" | "sos";
const TABS: Tab[] = ["chat", "peers", "modes", "sos"];

function Shell(): React.JSX.Element {
	const [tab, setTab] = useState<Tab>("chat");
	const { status, selfShort, deviceName, peers, modes, activeModeId, securityAlerts } = useMesh();
	const peerLabel = `${peers.length} peer${peers.length === 1 ? "" : "s"}`;
	const selfLabel = deviceName && deviceName.length > 0 ? deviceName : `node ${selfShort}`;
	const activeLabel = activeModeId ? (modes.find((m) => m.id === activeModeId)?.label ?? "") : "searching";
	const statusLine = status === "running" ? `${selfLabel} · ${peerLabel} · via ${activeLabel}` : status;
	return (
		<SafeAreaView style={styles.root}>
			<View style={styles.header}>
				<Text style={styles.title}>AdaptiveMesh</Text>
				<Text style={styles.status}>{statusLine}</Text>
			</View>
			{securityAlerts.length > 0 && (
				<View style={styles.alert}>
					<Text style={styles.alertText}>
						⚠️ Security: the encryption key for node {securityAlerts[securityAlerts.length - 1]!.short} changed. This
						can mean a reinstall — or an impersonation attempt. Verify out-of-band before trusting messages.
					</Text>
				</View>
			)}
			<View style={styles.body}>
				{tab === "chat" && <ChatScreen />}
				{tab === "peers" && <PeersScreen />}
				{tab === "modes" && <ModesScreen />}
				{tab === "sos" && <SosButton />}
			</View>
			<View style={styles.tabbar}>
				{TABS.map((t) => (
					<Pressable key={t} onPress={() => setTab(t)} style={styles.tab}>
						<Text style={[styles.tabText, tab === t && styles.tabActive]}>{t.toUpperCase()}</Text>
					</Pressable>
				))}
			</View>
		</SafeAreaView>
	);
}

export default function App(): React.JSX.Element {
	return (
		<MeshProvider>
			<ReadinessGate>
				<Shell />
			</ReadinessGate>
		</MeshProvider>
	);
}

const styles = StyleSheet.create({
	root: { flex: 1, backgroundColor: "#0a0e1a" },
	header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10 },
	title: { color: "#eaf0ff", fontSize: 24, fontWeight: "800" },
	status: { color: "#5b8cff", fontSize: 13, marginTop: 2 },
	alert: {
		backgroundColor: "#3a1722",
		borderColor: "#a3354f",
		borderWidth: 1,
		marginHorizontal: 16,
		marginBottom: 8,
		padding: 10,
		borderRadius: 10,
	},
	alertText: { color: "#ffd7df", fontSize: 12, lineHeight: 17 },
	body: { flex: 1 },
	tabbar: { flexDirection: "row", borderTopColor: "#1a2238", borderTopWidth: 1, backgroundColor: "#0c1222" },
	tab: { flex: 1, alignItems: "center", paddingVertical: 14 },
	tabText: { color: "#6b7a99", fontSize: 12, fontWeight: "700", letterSpacing: 1 },
	tabActive: { color: "#eaf0ff" },
});
