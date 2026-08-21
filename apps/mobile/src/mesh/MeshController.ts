/**
 * MeshController is the single on-device orchestrator. It wires the portable
 * @adaptivemesh/core engine to the real device radios + crypto + storage +
 * GPS + SMS and exposes a tiny, UI-friendly surface that covers every
 * requested feature:
 *
 *  1. Multi-target    - broadcast to everyone OR address ANY NUMBER of specific
 *                       devices at once (a Set of selected node ids); each
 *                       recipient still gets its own E2E-sealed copy.
 *  2. SOS             - crafts a rich emergency message (buildSosMessage) with a
 *                       real GPS fix when available, a nearby peer's shared
 *                       location as fallback, or an honest "location
 *                       unavailable" line; sends it across the mesh AND over SMS
 *                       to a saved emergency number.
 *  3. Fast discovery  - relay polls faster + BLE scans LOW_LATENCY; the refresh
 *                       cadence is tightened so peers appear quickly.
 *  4. Saved devices   - persistable favorites with live connection status and a
 *                       signal level (BLE RSSI -> bars).
 *  5. Internet        - the relay base URL is user-configurable + persisted, so
 *                       the Internet tier can be turned on without rebuilding.
 *  6. Wi-Fi auto-mesh - the Nearby radio auto-advertises + auto-discovers +
 *                       auto-connects, exactly like BLE.
 *  7. Multimedia      - pick a file via SAF and send it as a tagged media
 *                       payload over whichever tier is up, capped to a size the
 *                       active tier can realistically carry.
 *
 * AUTOMATIC BY DESIGN: once start() runs (after ReadinessGate forces all
 * permissions/services on), every enabled transport auto-advertises, scans,
 * handshakes (HELLO), TOFU-pins keys, connects, and relays/stores-and-forwards.
 */
import {
	buildSosMessage,
	decodePayload,
	encodeLocation,
	encodeMedia,
	encodeText,
	exportIdentitySeeds,
	generateIdentity,
	importIdentitySeeds,
	MeshEngine,
	RealClock,
	RelayTransport,
	shortId,
	TransportTier,
	type DeliveredMessage,
	type EngineEvent,
	type LocationInfo,
	type NodeId,
	type SecretIdentity,
	type Transport,
} from "@adaptivemesh/core";
import { Buffer } from "buffer";
import { RnCryptoProvider } from "../native/rnCrypto.ts";
import {
	BleTransport,
	MeshLocation,
	MeshMedia,
	MeshService,
	MeshSystem,
	NearbyTransport,
	nativeAvailable,
	SmsSos,
} from "../native/MeshNative.ts";
import { NativeRadioTransport } from "../native/NativeRadioTransport.ts";
import { BLE_SERVICE_UUID, NEARBY_SERVICE_ID, RELAY_URL } from "./config.ts";
import { MODE_DEFS, type MeshMode, type ModeId } from "./modes.ts";
import { meshStore, type PersistedModeFlags, type SavedPeer } from "./storage.ts";

export type MeshStatus = "idle" | "starting" | "running" | "stopped";

/** Live connection state of a peer (item #4). */
export type PeerStatus = "connected" | "saved" | "offline";

export interface MeshPeer {
	/** Permanent identity hash (item #2). */
	nodeId: NodeId;
	/** First 8 hex chars of the hash, for compact display. */
	short: string;
	/** Self-chosen, non-unique device name advertised via HELLO (if any). */
	name?: string;
	/** Whether the user saved this device to chat with (item #4). */
	saved: boolean;
	/** Whether we currently hold a direct link to this device. */
	connected: boolean;
	/** Live status used by the UI badge (item #4). */
	status: PeerStatus;
	/** Signal level 0-4 (0 = offline). Wi-Fi/Internet links report a nominal level. */
	level: number;
	/** Raw link RSSI in dBm when known (BLE only). */
	rssi?: number;
	/** Name of the carrying transport when connected (e.g. "rn-ble"). */
	tier?: string;
	/** Stored SOS phone number for this device (item #4); an SMS endpoint, not identity. */
	phone?: string;
}

/** A message's recipient set. "me" = inbound, "broadcast" = sent to all. */
export type MessageTo = "me" | "broadcast" | NodeId | NodeId[];

/** An attachment carried by a message (item #7). */
export interface MessageMedia {
	mime: string;
	name: string;
	size: number;
	/** Base64-encoded bytes for inline rendering / saving. */
	dataB64: string;
}

export interface MeshMessage {
	id: string;
	from: NodeId | "me";
	to: MessageTo;
	text: string;
	prio: "normal" | "sos";
	at: number;
	mine: boolean;
	/** "text" (default) or "media" (item #7). */
	kind?: "text" | "media";
	media?: MessageMedia;
}

/**
 * A TOFU (trust-on-first-use) key-change alert: the pinned encryption key for a
 * node no longer matches what it just presented. This is either a reinstall or
 * an impersonation/MITM attempt, so it is surfaced loudly in the UI.
 */
export interface KeyChangeAlert {
	nodeId: NodeId;
	short: string;
	at: number;
}

export interface MeshState {
	status: MeshStatus;
	selfShort: string;
	/** Full permanent hash for this device. */
	selfNodeId: NodeId;
	deviceName: string;
	peers: MeshPeer[];
	messages: MeshMessage[];
	/** Communication modes in priority order with live status (items #5/#6). */
	modes: MeshMode[];
	/** The mode currently carrying traffic, or null if none is connected. */
	activeModeId: ModeId | null;
	/** Selected target node ids; empty = broadcast / show-all (items #1/#3). */
	selectedTargets: NodeId[];
	/** TOFU key-change warnings (possible impersonation/MITM); newest last. */
	securityAlerts: KeyChangeAlert[];
	/** User-configured Internet relay base URL (item #5). */
	relayUrl: string;
	/** Saved emergency SMS recipients for SOS (item #2). */
	emergencyNumbers: string[];
}

type Listener = (s: MeshState) => void;
type SmsOutcome = "sent" | "composer" | "skipped" | "no_number";

/** SOS SMS budget: never text more than this many recipients in one SOS (item #4). */
const SMS_RECIPIENT_CAP = 8;
/** Degrade the SOS body to at most this many characters for SMS (spec: SMS budget/degradation). */
const SMS_MAX_CHARS = 320;

function rid(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class MeshController {
	private engine: MeshEngine | null = null;
	private identity: SecretIdentity | null = null;
	private readonly crypto = new RnCryptoProvider();
	private readonly clock = new RealClock();

	private relay: RelayTransport | null = null;
	private wifi: NativeRadioTransport | null = null;
	private ble: NativeRadioTransport | null = null;
	private smsEnabled = true;
	/**
	 * Real device radio state (item #1/#5). Defaults to true so the JS-only
	 * sandbox/preview still renders tiers as available; on-device they are kept in
	 * sync with the actual Bluetooth/Wi-Fi adapters via pollRadioState().
	 */
	private btOn = true;
	private wifiOn = true;

	private readonly selectedTargets = new Set<NodeId>();
	private selfName = "";
	private relayUrl = "";
	private emergencyNumbers: string[] = [];
	/** User-saved devices (item #4), keyed by permanent node id. */
	private readonly savedPeers = new Map<NodeId, SavedPeer>();
	/** Most-recent location each peer shared over the mesh (item #2 fallback). */
	private readonly peerLocations = new Map<NodeId, LocationInfo>();
	private lastOwnLocation: LocationInfo | null = null;
	private modeTimer: ReturnType<typeof setInterval> | null = null;
	private locationTimer: ReturnType<typeof setInterval> | null = null;

	private readonly listeners = new Set<Listener>();
	private state: MeshState = {
		status: "idle",
		selfShort: "",
		selfNodeId: "",
		deviceName: "",
		peers: [],
		messages: [],
		modes: [],
		activeModeId: null,
		selectedTargets: [],
		securityAlerts: [],
		relayUrl: "",
		emergencyNumbers: [],
	};

	getState(): MeshState {
		return this.state;
	}

	subscribe(fn: Listener): () => void {
		this.listeners.add(fn);
		fn(this.state);
		return () => {
			this.listeners.delete(fn);
		};
	}

	private set(patch: Partial<MeshState>): void {
		this.state = { ...this.state, ...patch };
		for (const l of this.listeners) l(this.state);
	}

	/** Idempotent. Called by ReadinessGate once everything is granted + on. */
	async start(): Promise<void> {
		if (this.engine) return;
		this.set({ status: "starting" });
		if (nativeAvailable && MeshService) await MeshService.start();

		// (2) Stable identity: reuse persisted seeds so the permanent hash never
		// changes across launches; generate + save on first run.
		const saved = await meshStore.loadSeeds();
		this.identity = saved ? await importIdentitySeeds(this.crypto, saved) : await generateIdentity(this.crypto);
		if (!saved) await meshStore.saveSeeds(exportIdentitySeeds(this.identity));

		this.selfName = await meshStore.loadName();
		this.relayUrl = await meshStore.loadRelayUrl();
		this.emergencyNumbers = await meshStore.loadEmergencyNumbers();
		const flags = await meshStore.loadModeFlags();
		this.smsEnabled = flags.sms ?? true;

		this.savedPeers.clear();
		for (const sp of await meshStore.loadSavedPeers()) this.savedPeers.set(sp.nodeId, sp);

		const transports = this.buildTransports(flags);
		this.engine = new MeshEngine({
			identity: this.identity,
			crypto: this.crypto,
			clock: this.clock,
			rand: () => Math.random(),
			name: this.selfName || undefined,
			transports,
			onMessage: (m) => this.onDelivered(m),
			onEvent: (e) => this.onEvent(e),
		});
		this.engine.start();

		// (3) Tighter refresh so newly-discovered peers and relay reachability
		// changes surface quickly even without an engine event.
		this.modeTimer = setInterval(() => {
			void this.pollRadioState();
			this.refresh();
		}, 1500);
		void this.pollRadioState();
		// (2) Periodically share our own location so neighbors can borrow it for
		// their SOS, and keep our own last-known fix warm. Low frequency to spare
		// the battery; SOS still takes a fresh fix on demand.
		this.locationTimer = setInterval(() => void this.broadcastLocationBeacon(), 60_000);

		this.set({
			status: "running",
			selfShort: shortId(this.identity.nodeId),
			selfNodeId: this.identity.nodeId,
			deviceName: this.selfName,
			relayUrl: this.relayUrl,
			emergencyNumbers: this.emergencyNumbers,
		});
		this.refresh();
	}

	private buildTransports(flags: Partial<PersistedModeFlags>): Transport[] {
		const list: Transport[] = [];

		// (5) Internet tier: real roster-based discovery + relay when configured.
		// The user-set URL (persisted) wins over the compile-time default.
		const relayUrl = this.relayUrl || RELAY_URL;
		if (relayUrl && this.identity) {
			this.relay = new RelayTransport({
				relayUrl,
				identity: this.identity,
				crypto: this.crypto,
				enabled: flags.internet ?? true,
			});
			list.push(this.relay);
		} else {
			this.relay = null;
		}

		this.wifi = new NativeRadioTransport({
			name: "rn-wifi",
			tier: TransportTier.Wifi,
			wire: "wifi",
			enabled: flags.wifi ?? true,
			startRadio: async () => {
				await Promise.allSettled([
					NearbyTransport?.startAdvertising(NEARBY_SERVICE_ID) ?? Promise.resolve(),
					NearbyTransport?.startDiscovery(NEARBY_SERVICE_ID) ?? Promise.resolve(),
				]);
			},
			stopRadio: async () => {
				await (NearbyTransport?.stop() ?? Promise.resolve());
			},
			sendFrame: (target, b64) => NearbyTransport?.sendFrame(target, b64) ?? Promise.resolve(),
		});
		list.push(this.wifi);

		this.ble = new NativeRadioTransport({
			name: "rn-ble",
			tier: TransportTier.Ble,
			wire: "ble",
			enabled: flags.ble ?? true,
			startRadio: async () => {
				await Promise.allSettled([
					BleTransport?.startAdvertising(BLE_SERVICE_UUID) ?? Promise.resolve(),
					BleTransport?.startScanning(BLE_SERVICE_UUID) ?? Promise.resolve(),
				]);
			},
			stopRadio: async () => {
				await (BleTransport?.stop() ?? Promise.resolve());
			},
			sendFrame: (target, b64) => BleTransport?.sendFrame(target, b64) ?? Promise.resolve(),
		});
		list.push(this.ble);

		return list;
	}

	async stop(): Promise<void> {
		if (this.modeTimer) {
			clearInterval(this.modeTimer);
			this.modeTimer = null;
		}
		if (this.locationTimer) {
			clearInterval(this.locationTimer);
			this.locationTimer = null;
		}
		this.engine?.stop();
		this.engine = null;
		this.relay = null;
		this.wifi = null;
		this.ble = null;
		if (nativeAvailable && MeshService) await MeshService.stop();
		this.set({ status: "stopped", peers: [], modes: [], activeModeId: null });
	}

	/** Full restart used when a structural setting (relay URL) changes. */
	private async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}

	// ---- (2) device name --------------------------------------------------

	/** Set + persist this device's display name and re-advertise it via HELLO. */
	async setDeviceName(name: string): Promise<void> {
		const trimmed = name.trim();
		this.selfName = trimmed;
		this.engine?.setName(trimmed);
		await meshStore.saveName(trimmed);
		this.set({ deviceName: trimmed });
	}

	// ---- (5) internet relay + (2) emergency number ------------------------

	/** Set + persist the Internet relay base URL; restarts the engine to apply. */
	async setRelayUrl(url: string): Promise<void> {
		const trimmed = url.trim();
		this.relayUrl = trimmed;
		await meshStore.saveRelayUrl(trimmed);
		this.set({ relayUrl: trimmed });
		if (this.engine) await this.restart();
	}

	/**
	 * Add + persist an emergency SMS recipient used by the SOS fallback. The user
	 * can store as many numbers as they like; duplicates are ignored.
	 */
	async addEmergencyNumber(num: string): Promise<void> {
		const cleaned = num.replace(/[^\d+ ()-]/g, "").trim();
		if (!cleaned) return;
		const norm = (s: string): string => s.replace(/[^\d+]/g, "");
		const key = norm(cleaned);
		if (this.emergencyNumbers.some((n) => norm(n) === key)) return;
		this.emergencyNumbers = [...this.emergencyNumbers, cleaned];
		await meshStore.saveEmergencyNumbers(this.emergencyNumbers);
		this.set({ emergencyNumbers: this.emergencyNumbers });
	}

	/** Remove + persist one saved emergency SMS recipient. */
	async removeEmergencyNumber(num: string): Promise<void> {
		const next = this.emergencyNumbers.filter((n) => n !== num);
		if (next.length === this.emergencyNumbers.length) return;
		this.emergencyNumbers = next;
		await meshStore.saveEmergencyNumbers(this.emergencyNumbers);
		this.set({ emergencyNumbers: this.emergencyNumbers });
	}

	// ---- (4) saved / favorite devices -------------------------------------

	async saveDevice(nodeId: NodeId): Promise<void> {
		if (this.savedPeers.has(nodeId)) return;
		const name = this.engine?.peerName(nodeId) ?? "";
		this.savedPeers.set(nodeId, { nodeId, name, savedAt: Date.now() });
		await this.persistSaved();
		this.refresh();
	}

	async unsaveDevice(nodeId: NodeId): Promise<void> {
		if (!this.savedPeers.delete(nodeId)) return;
		await this.persistSaved();
		this.refresh();
	}

	isSaved(nodeId: NodeId): boolean {
		return this.savedPeers.has(nodeId);
	}

	private async persistSaved(): Promise<void> {
		await meshStore.saveSavedPeers([...this.savedPeers.values()]);
	}

	// ---- (1) targeting ----------------------------------------------------

	/** Toggle one device in/out of the multi-select target set (item #1). */
	toggleTarget(nodeId: NodeId): void {
		if (this.selectedTargets.has(nodeId)) this.selectedTargets.delete(nodeId);
		else this.selectedTargets.add(nodeId);
		this.set({ selectedTargets: [...this.selectedTargets] });
	}

	/** Replace the entire selection at once (item #1: select-all / set-many). */
	setTargets(nodeIds: NodeId[]): void {
		this.selectedTargets.clear();
		for (const id of nodeIds) this.selectedTargets.add(id);
		this.set({ selectedTargets: [...this.selectedTargets] });
	}

	clearTargets(): void {
		this.selectedTargets.clear();
		this.set({ selectedTargets: [] });
	}

	/**
	 * Send a normal message. With no targets selected it is broadcast to every
	 * known peer; with one OR MANY targets selected it is addressed only to those
	 * device(s). Either way the engine seals a per-recipient E2E copy and floods.
	 */
	async sendText(text: string): Promise<void> {
		const engine = this.engine;
		if (!engine) throw new Error("mesh not running");
		const body = text.trim();
		if (!body) return;
		const payload = encodeText(body);

		const targets = [...this.selectedTargets];
		if (targets.length === 0) {
			const peers = this.computePeers();
			await Promise.allSettled(peers.map((p) => engine.send(p.nodeId, payload)));
			this.appendMessage({
				id: rid(),
				from: "me",
				to: "broadcast",
				text: body,
				prio: "normal",
				at: Date.now(),
				mine: true,
				kind: "text",
			});
			return;
		}
		await Promise.allSettled(targets.map((t) => engine.send(t, payload)));
		this.appendMessage({
			id: rid(),
			from: "me",
			to: targets.length === 1 ? targets[0]! : targets,
			text: body,
			prio: "normal",
			at: Date.now(),
			mine: true,
			kind: "text",
		});
	}

	// ---- (7) multimedia ---------------------------------------------------

	/** Byte cap for an attachment on the currently-active tier (item #7). */
	mediaSizeCap(): number {
		const KB = 1024;
		const MB = 1024 * 1024;
		// Caps are deliberately conservative: every attachment is sealed + chunked
		// PER recipient, so oversized media is the main cause of UI stalls. Images are
		// additionally downscaled/compressed natively to fit these caps (item #7).
		switch (this.state.activeModeId) {
			case "internet":
				return 2 * MB;
			case "wifi":
				return 1 * MB;
			case "ble":
				return 48 * KB;
			default:
				return 48 * KB;
		}
	}

	/**
	 * Open the system picker, then send the chosen file as a tagged media payload
	 * (item #7). Honours the active selection (broadcast vs specific devices) and
	 * the per-tier size cap. Returns an outcome the UI can surface.
	 */
	async sendMedia(): Promise<{ ok: boolean; reason?: string }> {
		const engine = this.engine;
		if (!engine) return { ok: false, reason: "Mesh is not running" };
		if (!MeshMedia) return { ok: false, reason: "Attachments need the device build" };

		const cap = this.mediaSizeCap();
		let picked;
		try {
			picked = await MeshMedia.pick(cap);
		} catch (e) {
			const msg = (e as Error).message || "cancelled";
			if (msg.includes("cancelled")) return { ok: false };
			if (msg.includes("too_large")) {
				return {
					ok: false,
					reason: `File is too large for the ${this.state.activeModeId ?? "current"} link (max ${Math.floor(cap / 1024)} KB)`,
				};
			}
			return { ok: false, reason: msg };
		}

		const media: MessageMedia = { mime: picked.mime, name: picked.name, size: picked.size, dataB64: picked.base64 };

		// Resolve recipients up front so we can paint the bubble BEFORE the heavy
		// base64-decode + encode + per-recipient sealing. That work is synchronous on
		// the single JS thread, so running it first is what kept the UI frozen ("app
		// still unresponsive when sending media"). Showing the message and yielding a
		// frame first keeps the screen interactive.
		const targets = [...this.selectedTargets];
		let to: MeshMessage["to"];
		let recipients: NodeId[];
		if (targets.length === 0) {
			const peers = this.computePeers();
			if (peers.length === 0) return { ok: false, reason: "No peers connected yet" };
			recipients = peers.map((p) => p.nodeId);
			to = "broadcast";
		} else {
			recipients = targets;
			to = targets.length === 1 ? targets[0]! : targets;
		}

		// 1) Show the attachment immediately, then yield so React can paint it.
		this.appendMessage({
			id: rid(),
			from: "me",
			to,
			text: "",
			prio: "normal",
			at: Date.now(),
			mine: true,
			kind: "media",
			media,
		});
		await new Promise<void>((resolve) => setTimeout(resolve, 0));

		// 2) Encode once and fan the sealed payload out to every recipient.
		const data = new Uint8Array(Buffer.from(picked.base64, "base64"));
		const payload = encodeMedia({ mime: picked.mime, name: picked.name, size: picked.size }, data);
		await Promise.allSettled(recipients.map((id) => engine.send(id, payload)));
		return { ok: true };
	}

	/**
	 * Save a sent/received attachment to the device's shared storage (item #7),
	 * mirroring a normal messenger's "Save": images land in Pictures, other files
	 * in Downloads, under an AdaptiveMesh/ folder.
	 */
	async saveMedia(media: MessageMedia): Promise<{ ok: boolean; reason?: string; name?: string }> {
		if (!MeshMedia?.saveToGallery) return { ok: false, reason: "Saving needs the device build" };
		try {
			const name = await MeshMedia.saveToGallery(media.dataB64, media.mime, media.name);
			return { ok: true, name };
		} catch (e) {
			return { ok: false, reason: (e as Error).message || "Could not save" };
		}
	}

	/** Open an attachment in an external viewer/player (item #7). */
	async openMedia(media: MessageMedia): Promise<{ ok: boolean; reason?: string }> {
		if (!MeshMedia?.openMedia) return { ok: false, reason: "Opening needs the device build" };
		try {
			await MeshMedia.openMedia(media.dataB64, media.mime, media.name);
			return { ok: true };
		} catch (e) {
			return { ok: false, reason: (e as Error).message || "No app can open this file" };
		}
	}

	/**
	 * Delete a message from THIS device's local history (item #7). Local-only: the
	 * mesh has no global unsend, so we never pretend to delete it from peers.
	 */
	deleteMessage(id: string): void {
		this.set({ messages: this.state.messages.filter((m) => m.id !== id) });
	}

	// ---- (2) SOS ----------------------------------------------------------

	/**
	 * Broadcast a crafted SOS across the mesh AND over SMS. Location preference:
	 * a fresh on-device GPS/network fix, else the freshest location a nearby peer
	 * shared, else none (the message says so honestly but still sends). Returns
	 * how many mesh recipients it reached and the SMS outcome.
	 */
	async sendSos(
		note?: string,
	): Promise<{ meshRecipients: number; sms: SmsOutcome; smsRecipients: number; location: LocationInfo | null }> {
		const location = await this.resolveSosLocation();
		const trimmedNote = note && note.trim() ? note.trim() : undefined;
		const body = buildSosMessage({
			deviceName: this.selfName || "Unnamed device",
			shortId: this.state.selfShort || shortId(this.identity?.nodeId ?? ""),
			nowMs: Date.now(),
			location,
			note: trimmedNote,
		});

		let meshRecipients = 0;
		const engine = this.engine;
		if (engine) {
			const peers = this.computePeers();
			await Promise.allSettled(peers.map((p) => engine.sendSos(p.nodeId, body)));
			meshRecipients = peers.length;
		}

		let sms: SmsOutcome = "skipped";
		let smsRecipients = 0;
		if (this.smsEnabled) {
			const result = await this.sendSosSms(body);
			sms = result.outcome;
			smsRecipients = result.recipients;
		}

		this.appendMessage({
			id: rid(),
			from: "me",
			to: "broadcast",
			text: body,
			prio: "sos",
			at: Date.now(),
			mine: true,
			kind: "text",
		});
		return { meshRecipients, sms, smsRecipients, location };
	}

	/** GPS-first SOS location with a nearby-peer fallback (item #2). */
	private async resolveSosLocation(): Promise<LocationInfo | null> {
		const own = await this.resolveOwnLocation(8000);
		if (own) return own;
		return this.freshestPeerLocation();
	}

	/** Take (or reuse) this device's own location fix. */
	private async resolveOwnLocation(timeoutMs: number): Promise<LocationInfo | null> {
		if (!MeshLocation) return this.lastOwnLocation;
		try {
			const fix = await MeshLocation.getLocation(60_000, timeoutMs);
			const loc: LocationInfo = {
				lat: fix.lat,
				lon: fix.lon,
				tsMs: fix.tsMs || Date.now(),
				source: fix.source,
			};
			if (typeof fix.accuracyM === "number" && fix.accuracyM > 0) loc.accuracyM = fix.accuracyM;
			this.lastOwnLocation = loc;
			return loc;
		} catch {
			return this.lastOwnLocation;
		}
	}

	/** Freshest location a neighbor shared, flagged as borrowed/approximate. */
	private freshestPeerLocation(): LocationInfo | null {
		let bestId: NodeId | null = null;
		let best: LocationInfo | null = null;
		for (const [nodeId, loc] of this.peerLocations) {
			if (!best || loc.tsMs > best.tsMs) {
				best = loc;
				bestId = nodeId;
			}
		}
		if (!best || !bestId) return null;
		const from = this.engine?.peerName(bestId) ?? shortId(bestId);
		const out: LocationInfo = { lat: best.lat, lon: best.lon, tsMs: best.tsMs, source: "peer", fromDevice: from };
		if (typeof best.accuracyM === "number") out.accuracyM = best.accuracyM;
		return out;
	}

	/**
	 * SOS SMS recipients (item #4): every saved emergency number, normalized +
	 * de-duplicated, capped to an SMS budget so one SOS never blasts an unbounded
	 * number of texts. Numbers are managed in Modes ▸ "SOS emergency numbers".
	 */
	private sosSmsRecipients(): string[] {
		const out = new Set<string>();
		const norm = (s: string): string => s.replace(/[^\d+]/g, "");
		for (const num of this.emergencyNumbers) {
			const n = norm(num);
			if (n) out.add(n);
		}
		return [...out].slice(0, SMS_RECIPIENT_CAP);
	}

	/** Degrade the rich SOS body to fit a small SMS budget (item #4 / spec). */
	private compactForSms(body: string): string {
		if (body.length <= SMS_MAX_CHARS) return body;
		return body.slice(0, SMS_MAX_CHARS - 1) + "…";
	}

	/**
	 * Send the SOS over SMS to every stored emergency endpoint, preferring a
	 * silent direct send (sideload / SEND_SMS granted) and falling back to the
	 * system composer. Returns the overall outcome and how many numbers it hit.
	 */
	private async sendSosSms(body: string): Promise<{ outcome: SmsOutcome; recipients: number }> {
		if (!SmsSos) return { outcome: "skipped", recipients: 0 };
		const numbers = this.sosSmsRecipients();
		if (numbers.length === 0) return { outcome: "no_number", recipients: 0 };
		const smsBody = this.compactForSms(body);

		let direct = false;
		try {
			direct = await SmsSos.isDirectSendAvailable();
		} catch {
			direct = false;
		}

		if (direct) {
			let sent = 0;
			for (const n of numbers) {
				try {
					await SmsSos.sendSosDirect(n, smsBody);
					sent++;
				} catch {
					/* try the remaining recipients */
				}
			}
			if (sent > 0) return { outcome: "sent", recipients: sent };
		}

		// No direct send (or it failed for all): open the composer pre-filled with
		// every recipient so the user can confirm + send manually.
		try {
			await SmsSos.composeSos(numbers.join(";"), smsBody);
			return { outcome: "composer", recipients: numbers.length };
		} catch {
			try {
				await SmsSos.composeSos(numbers[0]!, smsBody);
				return { outcome: "composer", recipients: 1 };
			} catch {
				return { outcome: "skipped", recipients: 0 };
			}
		}
	}

	/** Share our own location with connected peers so they can borrow it (item #2). */
	private async broadcastLocationBeacon(): Promise<void> {
		const engine = this.engine;
		if (!engine) return;
		const loc = await this.resolveOwnLocation(6000);
		if (!loc) return;
		const peers = this.computePeers().filter((p) => p.connected);
		if (peers.length === 0) return;
		const payload = encodeLocation(loc);
		await Promise.allSettled(peers.map((p) => engine.send(p.nodeId, payload, { prio: "bulk" })));
	}

	// ---- (5/6) modes ------------------------------------------------------

	/** Item #6: enable/disable a tier live for demos; persisted across launches. */
	async setModeEnabled(modeId: ModeId, on: boolean): Promise<void> {
		switch (modeId) {
			case "internet":
				await this.relay?.setEnabled(on);
				break;
			case "wifi":
				await this.wifi?.setEnabled(on);
				// Honest device effect (item #5): an app cannot toggle the phone's Wi-Fi
				// radio, but enabling the tier while Wi-Fi is off opens the system Wi-Fi
				// panel so the user can switch it on. Disabling stops the app's Nearby use.
				if (on && MeshSystem && !this.wifiOn) await MeshSystem.promptEnableWifi().catch(() => false);
				break;
			case "ble":
				await this.ble?.setEnabled(on);
				// Enabling BLE while Bluetooth is off pops the system enable dialog;
				// disabling stops advertising/scanning and drops BLE links immediately.
				if (on && MeshSystem && !this.btOn) await MeshSystem.promptEnableBluetooth().catch(() => false);
				break;
			case "sms":
				this.smsEnabled = on;
				break;
		}
		await meshStore.saveModeFlags(this.currentFlags());
		this.refresh();
	}

	/** Whether the SMS SOS fallback is currently enabled (used by SosButton). */
	isSmsEnabled(): boolean {
		return this.smsEnabled;
	}

	private currentFlags(): PersistedModeFlags {
		return {
			internet: this.relay?.isEnabledFlag() ?? true,
			wifi: this.wifi?.isEnabled() ?? true,
			ble: this.ble?.isEnabled() ?? true,
			sms: this.smsEnabled,
		};
	}

	private computeModes(): { modes: MeshMode[]; activeModeId: ModeId | null } {
		const countOf = (id: ModeId): number => {
			if (id === "internet") return this.relay?.neighbors().length ?? 0;
			// Count distinct connected NODES (learned via HELLO) on this tier, not raw
			// radio link handles. A single peer can briefly form two BLE links (we dial
			// it AND it dials us), and a link only becomes a routable peer once the
			// HELLO handshake completes — so this keeps the Modes count consistent with
			// the Peers list and the header instead of over-counting half-open links.
			if (id === "wifi") return this.connectedNodeCountForTier("wifi");
			if (id === "ble") return this.connectedNodeCountForTier("ble");
			return 0;
		};
		const enabledOf = (id: ModeId): boolean => {
			if (id === "internet") return this.relay?.isEnabledFlag() ?? false;
			if (id === "wifi") return this.wifi?.isEnabled() ?? false;
			if (id === "ble") return this.ble?.isEnabled() ?? false;
			return this.smsEnabled;
		};
		const availableOf = (id: ModeId): boolean => {
			if (id === "internet") return this.relay?.isAvailable() ?? false;
			// A tier is only "available" when its underlying radio is actually ON
			// (item #1/#5): Wi-Fi Direct needs the Wi-Fi adapter, BLE needs Bluetooth.
			// This stops the UI from claiming a tier is up when the user switched the
			// radio off at the OS level.
			if (id === "wifi") return (this.wifi?.isAvailable() ?? false) && this.wifiOn;
			if (id === "ble") return (this.ble?.isAvailable() ?? false) && this.btOn;
			return nativeAvailable && SmsSos !== null;
		};
		const detailOf = (id: ModeId, enabled: boolean, available: boolean, count: number): string => {
			if (id === "internet" && !this.relay) return "not configured";
			if ((id === "wifi" || id === "ble") && !nativeAvailable) return "needs device build";
			if (id === "ble" && enabled && !this.btOn) return "Bluetooth is off — turn it on in Settings";
			if (id === "wifi" && enabled && !this.wifiOn) return "Wi-Fi is off — turn it on in Settings";
			if (id === "sms") {
				if (!available) return "needs device build";
				if (this.emergencyNumbers.length === 0) return enabled ? "set a number" : "off";
				return enabled ? "ready (SOS fallback)" : "off";
			}
			if (!enabled) return "off";
			if (count > 0) return `${count} peer${count === 1 ? "" : "s"}`;
			return available ? "searching…" : "connecting…";
		};

		const ordered = [...MODE_DEFS].sort((a, b) => a.priority - b.priority);
		let activeModeId: ModeId | null = null;
		const modes: MeshMode[] = ordered.map((def) => {
			const enabled = enabledOf(def.id);
			const available = availableOf(def.id);
			const count = countOf(def.id);
			const carrying = def.id !== "sms" && enabled && available && count > 0;
			if (carrying && activeModeId === null) activeModeId = def.id;
			return { ...def, enabled, available, active: false, detail: detailOf(def.id, enabled, available, count) };
		});
		for (const m of modes) m.active = m.id === activeModeId;
		return { modes, activeModeId };
	}

	// ---- internals --------------------------------------------------------

	/**
	 * Human-readable, HONEST link label for a peer (item #1). Nearby Connections
	 * reports its tier as "wifi" even when it physically falls back to Bluetooth
	 * because the Wi-Fi radio is off — so when Wi-Fi is actually off we label such a
	 * link "Bluetooth" (the real medium) instead of misleadingly showing "wifi".
	 */
	private tierLabel(transport: string): string {
		const t = transport.replace("rn-", "");
		if (t === "wifi") return this.wifiOn ? "Wi-Fi" : "Bluetooth";
		if (t === "ble") return "Bluetooth";
		if (t === "relay" || t === "internet") return "Internet";
		return t;
	}

	/** Map a BLE RSSI (dBm) to a 0-4 bar level; connected-without-RSSI = 3. */
	private signalLevel(connected: boolean, rssi?: number): number {
		if (!connected) return 0;
		if (typeof rssi !== "number") return 3;
		if (rssi >= -55) return 4;
		if (rssi >= -67) return 3;
		if (rssi >= -78) return 2;
		return 1;
	}

	/**
	 * Number of distinct directly-connected nodes whose link rides the given
	 * tier. Used for the per-mode peer count so it matches the actual routable
	 * peer list (deduped by node) rather than raw radio link handles.
	 */
	private connectedNodeCountForTier(tier: "wifi" | "ble"): number {
		const engine = this.engine;
		if (!engine) return 0;
		const self = this.identity?.nodeId;
		let count = 0;
		for (const node of engine.connectedNodes()) {
			if (node === self) continue;
			const link = engine.linkFor(node);
			if (link && link.transport.replace("rn-", "") === tier) count++;
		}
		return count;
	}

	private makePeer(nodeId: NodeId, connected: Set<NodeId>): MeshPeer {
		const isConn = connected.has(nodeId);
		const saved = this.savedPeers.has(nodeId);
		const link = isConn ? this.engine?.linkFor(nodeId) : undefined;
		const rssi = link?.rssi;
		const name = this.engine?.peerName(nodeId) ?? this.savedPeers.get(nodeId)?.name;
		const phone = this.savedPeers.get(nodeId)?.phone;
		const peer: MeshPeer = {
			nodeId,
			short: shortId(nodeId),
			saved,
			connected: isConn,
			status: isConn ? "connected" : saved ? "saved" : "offline",
			level: this.signalLevel(isConn, rssi),
		};
		if (name && name.length > 0) peer.name = name;
		if (typeof rssi === "number") peer.rssi = rssi;
		if (link?.transport) peer.tier = this.tierLabel(link.transport);
		if (phone) peer.phone = phone;
		return peer;
	}

	private computePeers(): MeshPeer[] {
		if (!this.engine || !this.identity) return [];
		const self = this.identity.nodeId;
		const connected = new Set<NodeId>(this.engine.connectedNodes().filter((n) => n !== self));
		const byId = new Map<NodeId, MeshPeer>();
		for (const c of this.engine.knownContacts()) {
			if (c.nodeId === self) continue;
			byId.set(c.nodeId, this.makePeer(c.nodeId, connected));
		}
		// Saved devices appear even when offline so the user can see/queue them.
		for (const sp of this.savedPeers.values()) {
			if (sp.nodeId === self || byId.has(sp.nodeId)) continue;
			byId.set(sp.nodeId, this.makePeer(sp.nodeId, connected));
		}
		for (const n of connected) {
			if (!byId.has(n)) byId.set(n, this.makePeer(n, connected));
		}
		return [...byId.values()].sort((a, b) => {
			if (a.connected !== b.connected) return a.connected ? -1 : 1;
			if (a.saved !== b.saved) return a.saved ? -1 : 1;
			return a.short.localeCompare(b.short);
		});
	}

	/** Recompute everything that can change without an explicit event. */
	private refresh(): void {
		if (!this.engine) return;
		const { modes, activeModeId } = this.computeModes();
		this.set({ peers: this.computePeers(), modes, activeModeId });
	}

	/**
	 * Poll the real device Bluetooth/Wi-Fi adapter state (item #1/#5) so the modes
	 * and peer tiers reflect what is actually on. No-op (keeps optimistic defaults)
	 * in the JS-only sandbox where MeshSystem is unavailable.
	 */
	private async pollRadioState(): Promise<void> {
		if (!MeshSystem) return;
		try {
			const [bt, wifi] = await Promise.all([
				MeshSystem.isBluetoothEnabled().catch(() => this.btOn),
				MeshSystem.isWifiEnabled().catch(() => this.wifiOn),
			]);
			if (bt !== this.btOn || wifi !== this.wifiOn) {
				this.btOn = bt;
				this.wifiOn = wifi;
				this.refresh();
			}
		} catch {
			/* keep last-known radio state */
		}
	}

	private onDelivered(m: DeliveredMessage): void {
		const payload = decodePayload(m.plaintext);
		if (payload.kind === "location") {
			// A neighbor shared its location: store it for SOS fallback, no bubble.
			if (payload.location) this.peerLocations.set(m.from, payload.location);
			return;
		}
		const prio: "normal" | "sos" = m.prio === "sos" ? "sos" : "normal";
		if (payload.kind === "media" && payload.media && payload.data) {
			const media: MessageMedia = {
				mime: payload.media.mime,
				name: payload.media.name,
				size: payload.media.size,
				dataB64: Buffer.from(payload.data).toString("base64"),
			};
			this.appendMessage({
				id: rid(),
				from: m.from,
				to: "me",
				text: payload.text ?? "",
				prio,
				at: Date.now(),
				mine: false,
				kind: "media",
				media,
			});
			return;
		}
		this.appendMessage({
			id: rid(),
			from: m.from,
			to: "me",
			text: payload.text ?? "",
			prio,
			at: Date.now(),
			mine: false,
			kind: "text",
		});
	}

	private onEvent(e: EngineEvent): void {
		if (e.kind === "neighbor" || e.kind === "deliver") this.refresh();
		if (e.kind === "key-change") {
			const alert: KeyChangeAlert = { nodeId: e.nodeId, short: shortId(e.nodeId), at: Date.now() };
			// Keep the most recent few; the UI renders the latest as a loud banner.
			this.set({ securityAlerts: [...this.state.securityAlerts, alert].slice(-5) });
		}
	}

	private appendMessage(msg: MeshMessage): void {
		this.set({ messages: [...this.state.messages, msg] });
	}
}

/** App-wide singleton. */
export const meshController = new MeshController();
