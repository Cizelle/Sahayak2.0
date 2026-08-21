/**
 * React glue for the MeshController singleton. The provider subscribes to the
 * controller's state stream; useMesh() exposes that live state plus the manual
 * actions. All automation lives in the controller, not in React.
 */
import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { meshController, type MeshMessage, type MessageMedia, type MeshState } from "./MeshController.ts";
import type { ModeId } from "./modes.ts";

const MeshStateContext = createContext<MeshState>(meshController.getState());

export function MeshProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
	const [state, setState] = useState<MeshState>(meshController.getState());
	useEffect(() => meshController.subscribe(setState), []);
	return <MeshStateContext.Provider value={state}>{children}</MeshStateContext.Provider>;
}

/**
 * (4) Conversation focus: when one or more targets are selected, show ONLY the
 * thread with those device(s) — my messages addressed to them and their
 * messages to me. Everyone else's traffic is hidden from view even though the
 * engine keeps receiving and relaying it underneath. With no target selected,
 * every message is shown.
 */
export function filterMessages(messages: MeshMessage[], selectedTargets: string[]): MeshMessage[] {
	if (selectedTargets.length === 0) return messages;
	const sel = new Set(selectedTargets);
	const toHits = (to: MeshMessage["to"]): boolean => {
		if (Array.isArray(to)) return to.some((t) => sel.has(t));
		return typeof to === "string" && sel.has(to);
	};
	return messages.filter((m) => (m.mine ? toHits(m.to) : sel.has(m.from)));
}

export interface UseMesh extends MeshState {
	/** Visible messages after applying the selected-target conversation filter. */
	visibleMessages: MeshMessage[];
	sendText: (text: string) => Promise<void>;
	/** (7) Pick a file and send it as a media attachment on the active tier. */
	sendMedia: () => Promise<{ ok: boolean; reason?: string }>;
	/** (7) Save an attachment to the device's shared storage. */
	saveMedia: (media: MessageMedia) => Promise<{ ok: boolean; reason?: string; name?: string }>;
	/** (7) Open an attachment in an external app. */
	openMedia: (media: MessageMedia) => Promise<{ ok: boolean; reason?: string }>;
	/** (7) Delete a message from this device's local history. */
	deleteMessage: (id: string) => void;
	/** (2) Craft + send the SOS over mesh and SMS; returns reach + SMS outcome. */
	sendSos: (note?: string) => ReturnType<typeof meshController.sendSos>;
	setDeviceName: (name: string) => Promise<void>;
	toggleTarget: (nodeId: string) => void;
	clearTargets: () => void;
	setModeEnabled: (modeId: ModeId, on: boolean) => Promise<void>;
	/** (4) Save / unsave a device to favorites. */
	saveDevice: (nodeId: string) => Promise<void>;
	unsaveDevice: (nodeId: string) => Promise<void>;
	/** (5) Configure + persist the Internet relay URL (restarts the engine). */
	setRelayUrl: (url: string) => Promise<void>;
	/** (2) Add an emergency SMS recipient (the user can save as many as they want). */
	addEmergencyNumber: (num: string) => Promise<void>;
	/** (2) Remove one saved emergency SMS recipient. */
	removeEmergencyNumber: (num: string) => Promise<void>;
}

export function useMesh(): UseMesh {
	const state = useContext(MeshStateContext);
	const visibleMessages = useMemo(
		() => filterMessages(state.messages, state.selectedTargets),
		[state.messages, state.selectedTargets],
	);
	return {
		...state,
		visibleMessages,
		sendText: (text) => meshController.sendText(text),
		sendMedia: () => meshController.sendMedia(),
		saveMedia: (media) => meshController.saveMedia(media),
		openMedia: (media) => meshController.openMedia(media),
		deleteMessage: (id) => meshController.deleteMessage(id),
		sendSos: (note) => meshController.sendSos(note),
		setDeviceName: (name) => meshController.setDeviceName(name),
		toggleTarget: (nodeId) => meshController.toggleTarget(nodeId),
		clearTargets: () => meshController.clearTargets(),
		setModeEnabled: (modeId, on) => meshController.setModeEnabled(modeId, on),
		saveDevice: (nodeId) => meshController.saveDevice(nodeId),
		unsaveDevice: (nodeId) => meshController.unsaveDevice(nodeId),
		setRelayUrl: (url) => meshController.setRelayUrl(url),
		addEmergencyNumber: (num) => meshController.addEmergencyNumber(num),
		removeEmergencyNumber: (num) => meshController.removeEmergencyNumber(num),
	};
}
