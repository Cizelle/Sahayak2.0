/**
 * Chat surface. Discovery/connection/relaying are automatic; the user only
 * (a) chooses recipients, (b) types, and (c) optionally attaches a file.
 *
 * Recipients (item #1): the "All" chip broadcasts to every peer; tapping one or
 * MORE device chips builds a multi-select target set, and the message is sealed
 * per-recipient and sent to all of them at once. A checkmark + "Send to N"
 * button make the multi-select obvious. While focused, only that thread is
 * shown, but the engine keeps receiving and relaying everyone else's traffic
 * underneath (the device still forwards for the mesh).
 *
 * Multimedia (item #7): the clip button opens the system file picker and sends
 * the file as a tagged media payload over whichever tier is up, capped to a
 * size that tier can realistically carry. Inbound images render inline; other
 * files render as a labelled attachment chip.
 */
import React, { useState } from "react";
import { ActivityIndicator, FlatList, Image, Modal, Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { MotiView } from "moti";
import { useMesh } from "../mesh/MeshContext.tsx";
import type { MeshMessage, MeshPeer } from "../mesh/MeshController.ts";

const BUBBLE_FROM = { opacity: 0, translateY: 6 } as const;
const BUBBLE_TO = { opacity: 1, translateY: 0 } as const;

function peerLabel(p: MeshPeer): string {
	return p.name && p.name.length > 0 ? p.name : `node-${p.short}`;
}

function prettySize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Renders a media attachment: inline image preview, or a file chip otherwise. */
function MediaBlock({
	media,
	onPress,
}: {
	media: NonNullable<MeshMessage["media"]>;
	onPress: () => void;
}): React.JSX.Element {
	if (media.mime.startsWith("image/")) {
		// Hoist the source object so the JSX never contains adjacent braces.
		const imgSource = { uri: `data:${media.mime};base64,${media.dataB64}` } as const;
		return (
			<Pressable onPress={onPress}>
				<Image source={imgSource} style={styles.image} resizeMode="cover" />
			</Pressable>
		);
	}
	return (
		<Pressable style={styles.fileChip} onPress={onPress}>
			<Text style={styles.fileIcon}>FILE</Text>
			<View style={styles.fileMeta}>
				<Text style={styles.fileName} numberOfLines={1}>
					{media.name}
				</Text>
				<Text style={styles.fileSize}>{prettySize(media.size)}</Text>
			</View>
			<Text style={styles.fileOpen}>Open</Text>
		</Pressable>
	);
}

export function ChatScreen(): React.JSX.Element {
	const {
		visibleMessages,
		peers,
		status,
		selectedTargets,
		sendText,
		sendMedia,
		openMedia,
		saveMedia,
		deleteMessage,
		toggleTarget,
		clearTargets,
	} = useMesh();
	const [draft, setDraft] = useState("");
	const [attaching, setAttaching] = useState(false);
	const [hint, setHint] = useState("");
	const [viewer, setViewer] = useState<MeshMessage | null>(null);
	const [sheet, setSheet] = useState<MeshMessage | null>(null);

	// Tap an attachment: images open in the in-app fullscreen viewer; other files
	// are handed to an external app via the native FileProvider "open" path.
	async function onOpenMedia(item: MeshMessage): Promise<void> {
		if (!item.media) return;
		if (item.media.mime.startsWith("image/")) {
			setViewer(item);
			return;
		}
		const res = await openMedia(item.media);
		if (!res.ok) setHint(res.reason ?? "No app can open this file");
	}

	async function onSaveMedia(item: MeshMessage): Promise<void> {
		if (!item.media) return;
		const res = await saveMedia(item.media);
		setHint(res.ok ? `Saved ${res.name ?? item.media.name}` : (res.reason ?? "Could not save"));
	}

	// Long-press any bubble to open the messenger-style action sheet. We use a
	// custom in-app sheet instead of Alert.alert because Android's native alert
	// renders at most 3 buttons, which silently dropped the Delete action.
	function onLongPressMessage(item: MeshMessage): void {
		setSheet(item);
	}
	const nameOf = (id: string): string => {
		const p = peers.find((x) => x.nodeId === id);
		return p ? peerLabel(p) : `node-${id.slice(0, 8)}`;
	};
	const broadcasting = selectedTargets.length === 0;
	const canSend = status === "running" && (broadcasting ? peers.length > 0 : selectedTargets.length > 0);
	const sendLabel = broadcasting ? "Send" : `Send to ${selectedTargets.length}`;

	async function onSend(): Promise<void> {
		const text = draft.trim();
		if (!text || !canSend) return;
		setDraft("");
		await sendText(text);
	}

	async function onAttach(): Promise<void> {
		if (!canSend || attaching) return;
		setAttaching(true);
		setHint("");
		try {
			const res = await sendMedia();
			if (!res.ok && res.reason) setHint(res.reason);
		} finally {
			setAttaching(false);
		}
	}

	return (
		<View style={styles.wrap}>
			<View style={styles.targets}>
				<Pressable onPress={clearTargets} style={[styles.chip, broadcasting && styles.chipActive]}>
					<Text style={styles.chipText}>All</Text>
				</Pressable>
				{peers.length === 0 ? (
					<Text style={styles.empty}>Discovering devices… you can message once a peer appears.</Text>
				) : (
					peers.map((p) => {
						const on = selectedTargets.includes(p.nodeId);
						return (
							<Pressable
								key={p.nodeId}
								onPress={() => toggleTarget(p.nodeId)}
								style={[styles.chip, on && styles.chipActive, !p.connected && styles.chipOffline]}
							>
								<Text style={styles.chipText}>
									{on ? "\u2713 " : ""}
									{peerLabel(p)}
								</Text>
							</Pressable>
						);
					})
				)}
			</View>
			{!broadcasting && (
				<Text style={styles.focusBanner}>
					Focused on {selectedTargets.length} device{selectedTargets.length === 1 ? "" : "s"} — others' messages hidden
					(still relayed).
				</Text>
			)}
			<FlatList
				data={visibleMessages}
				keyExtractor={(m) => m.id}
				contentContainerStyle={styles.list}
				renderItem={({ item }) => {
					const toLabel = Array.isArray(item.to)
						? item.to.map(nameOf).join(", ")
						: item.to === "broadcast"
							? "everyone"
							: item.to === "me"
								? ""
								: nameOf(item.to);
					return (
						<Pressable onLongPress={() => onLongPressMessage(item)} delayLongPress={300}>
							<MotiView
								from={BUBBLE_FROM}
								animate={BUBBLE_TO}
								style={[styles.bubble, item.mine ? styles.mine : styles.theirs, item.prio === "sos" && styles.sos]}
							>
								{!item.mine && <Text style={styles.sender}>{nameOf(String(item.from))}</Text>}
								{item.mine && toLabel.length > 0 && <Text style={styles.sender}>to {toLabel}</Text>}
								{item.media ? <MediaBlock media={item.media} onPress={() => void onOpenMedia(item)} /> : null}
								{item.text.length > 0 ? <Text style={styles.msgText}>{item.text}</Text> : null}
								{item.prio === "sos" && <Text style={styles.sosTag}>SOS</Text>}
							</MotiView>
						</Pressable>
					);
				}}
			/>
			{hint.length > 0 && <Text style={styles.hint}>{hint}</Text>}
			<View style={styles.inputRow}>
				<Pressable
					style={[styles.attach, !canSend && styles.sendOff]}
					onPress={() => void onAttach()}
					disabled={!canSend}
				>
					{attaching ? <ActivityIndicator color="#dce6ff" /> : <Text style={styles.attachText}>+</Text>}
				</Pressable>
				<TextInput
					style={styles.input}
					value={draft}
					onChangeText={setDraft}
					placeholder={
						!canSend
							? "Waiting for a peer…"
							: broadcasting
								? "Broadcast to all…"
								: `Message ${selectedTargets.length} device${selectedTargets.length === 1 ? "" : "s"}…`
					}
					placeholderTextColor="#46557a"
					editable={canSend}
					onSubmitEditing={() => void onSend()}
				/>
				<Pressable style={[styles.send, !canSend && styles.sendOff]} onPress={() => void onSend()}>
					<Text style={styles.sendText}>{sendLabel}</Text>
				</Pressable>
			</View>
			{viewer?.media ? (
				<Modal visible transparent animationType="fade" onRequestClose={() => setViewer(null)}>
					<View style={styles.viewerBackdrop}>
						<Image
							source={{ uri: `data:${viewer.media.mime};base64,${viewer.media.dataB64}` }}
							style={styles.viewerImage}
							resizeMode="contain"
						/>
						<Text style={styles.viewerName} numberOfLines={1}>
							{viewer.media.name}
						</Text>
						<View style={styles.viewerBar}>
							<Pressable style={styles.viewerBtn} onPress={() => void onSaveMedia(viewer)}>
								<Text style={styles.viewerBtnText}>Save</Text>
							</Pressable>
							<Pressable style={styles.viewerBtn} onPress={() => setViewer(null)}>
								<Text style={styles.viewerBtnText}>Close</Text>
							</Pressable>
						</View>
					</View>
				</Modal>
			) : null}
			{sheet ? (
				<Modal visible transparent animationType="fade" onRequestClose={() => setSheet(null)}>
					<Pressable style={styles.sheetBackdrop} onPress={() => setSheet(null)}>
						<View style={styles.sheet}>
							<Text style={styles.sheetTitle} numberOfLines={1}>
								{sheet.media ? sheet.media.name : "Message"}
							</Text>
							{sheet.media ? (
								<Pressable
									style={styles.sheetItem}
									onPress={() => {
										const m = sheet;
										setSheet(null);
										void onSaveMedia(m);
									}}
								>
									<Text style={styles.sheetText}>Save to device</Text>
								</Pressable>
							) : null}
							{sheet.media && !sheet.media.mime.startsWith("image/") ? (
								<Pressable
									style={styles.sheetItem}
									onPress={() => {
										const m = sheet;
										setSheet(null);
										void onOpenMedia(m);
									}}
								>
									<Text style={styles.sheetText}>Open</Text>
								</Pressable>
							) : null}
							<Pressable
								style={styles.sheetItem}
								onPress={() => {
									const id = sheet.id;
									setSheet(null);
									deleteMessage(id);
								}}
							>
								<Text style={[styles.sheetText, styles.sheetDanger]}>Delete for me</Text>
							</Pressable>
							<Pressable style={[styles.sheetItem, styles.sheetCancel]} onPress={() => setSheet(null)}>
								<Text style={styles.sheetText}>Cancel</Text>
							</Pressable>
						</View>
					</Pressable>
				</Modal>
			) : null}
		</View>
	);
}

const styles = StyleSheet.create({
	wrap: { flex: 1 },
	targets: { flexDirection: "row", flexWrap: "wrap", gap: 8, paddingHorizontal: 16, paddingVertical: 10 },
	empty: { color: "#56648a", fontSize: 13 },
	focusBanner: { color: "#9fb0d8", fontSize: 12, paddingHorizontal: 16, paddingBottom: 6 },
	chip: { backgroundColor: "#16203a", paddingVertical: 6, paddingHorizontal: 12, borderRadius: 16 },
	chipActive: { backgroundColor: "#5b8cff" },
	chipOffline: { opacity: 0.55 },
	chipText: { color: "#dce6ff", fontSize: 12, fontWeight: "600" },
	list: { paddingHorizontal: 16, paddingBottom: 12, gap: 8 },
	bubble: { maxWidth: "82%", borderRadius: 14, paddingVertical: 8, paddingHorizontal: 12 },
	mine: { alignSelf: "flex-end", backgroundColor: "#274690" },
	theirs: { alignSelf: "flex-start", backgroundColor: "#16203a" },
	sos: { borderColor: "#ff5b6e", borderWidth: 1 },
	sender: { color: "#7f8db0", fontSize: 11, marginBottom: 2 },
	msgText: { color: "#eaf0ff", fontSize: 15 },
	image: { width: 200, height: 200, borderRadius: 10, marginBottom: 4, backgroundColor: "#0c1424" },
	fileChip: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
	fileIcon: {
		color: "#9fb0d8",
		fontSize: 11,
		fontWeight: "800",
		backgroundColor: "#0c1424",
		padding: 6,
		borderRadius: 6,
	},
	fileMeta: { flexShrink: 1 },
	fileName: { color: "#eaf0ff", fontSize: 14, fontWeight: "600" },
	fileSize: { color: "#7f8db0", fontSize: 11 },
	sosTag: { color: "#ff8a97", fontSize: 10, fontWeight: "800", marginTop: 4, letterSpacing: 1 },
	hint: { color: "#ffb27a", fontSize: 12, paddingHorizontal: 16, paddingBottom: 4 },
	inputRow: { flexDirection: "row", padding: 12, gap: 8, borderTopColor: "#1a2238", borderTopWidth: 1 },
	attach: {
		width: 44,
		backgroundColor: "#16203a",
		borderRadius: 12,
		alignItems: "center",
		justifyContent: "center",
	},
	attachText: { color: "#dce6ff", fontSize: 24, fontWeight: "700", lineHeight: 26 },
	input: {
		flex: 1,
		backgroundColor: "#11192e",
		borderRadius: 12,
		paddingHorizontal: 14,
		color: "#eaf0ff",
		fontSize: 15,
	},
	send: { backgroundColor: "#5b8cff", borderRadius: 12, paddingHorizontal: 18, justifyContent: "center" },
	sendOff: { backgroundColor: "#2a3454" },
	sendText: { color: "#06122e", fontWeight: "800" },
	fileOpen: { color: "#9fb0d8", fontSize: 12, fontWeight: "700" },
	viewerBackdrop: {
		flex: 1,
		backgroundColor: "#000000ee",
		alignItems: "center",
		justifyContent: "center",
		padding: 16,
	},
	viewerImage: { width: "100%", height: "78%" },
	viewerName: { color: "#cdd7f0", fontSize: 13, marginTop: 12 },
	viewerBar: { flexDirection: "row", gap: 12, marginTop: 16 },
	viewerBtn: { backgroundColor: "#5b8cff", borderRadius: 12, paddingHorizontal: 28, paddingVertical: 12 },
	viewerBtnText: { color: "#06122e", fontWeight: "800", fontSize: 15 },
	sheetBackdrop: { flex: 1, backgroundColor: "#00000099", justifyContent: "flex-end" },
	sheet: { backgroundColor: "#11192e", borderTopLeftRadius: 18, borderTopRightRadius: 18, padding: 12, gap: 4 },
	sheetTitle: { color: "#7f8db0", fontSize: 12, fontWeight: "700", paddingHorizontal: 12, paddingVertical: 8 },
	sheetItem: { paddingVertical: 14, paddingHorizontal: 12, borderRadius: 10 },
	sheetText: { color: "#eaf0ff", fontSize: 16, fontWeight: "600" },
	sheetDanger: { color: "#ff6b81" },
	sheetCancel: { backgroundColor: "#0c1222", marginTop: 4 },
});
