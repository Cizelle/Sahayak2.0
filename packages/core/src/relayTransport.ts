/**
 * RelayTransport — the Internet tier (TransportTier.Internet, highest priority).
 *
 * Unlike the radios, this transport needs no native module: it speaks plain
 * HTTP(S) to a zero-knowledge relay (services/relay) using nothing but the
 * global `fetch`, so the EXACT same code runs in Node tests, the simulator, and
 * on a real phone. It is what makes "no devices shown" actually resolve today —
 * two phones that both have internet discover each other through the relay's
 * presence/roster endpoint and exchange sealed frames through its mailbox.
 *
 * Discovery:   POST /register once, then poll /roster -> emits neighbor up/down.
 * Delivery:    send() -> POST /submit (dst mailbox); poll /pull -> deliver +
 *              /ack. Each blob is `lpStr(senderNodeId) || encodeFrame(frame)`,
 *              so the receiver can attribute the frame to a routable peer
 *              handle. MSG payloads are already E2E-sealed by the engine; the
 *              relay only ever sees opaque bytes + the dst node id.
 *
 * The request signing here mirrors services/relay/relayCore.ts byte-for-byte;
 * the relayTransport integration test exercises a real RelayCore + HTTP server
 * so any drift fails CI immediately.
 */
import { ByteReader, ByteWriter, toHex } from "./bytes.ts";
import { decodeFrame, encodeFrame } from "./codec.ts";
import type { CryptoProvider } from "./crypto/provider.ts";
import type { NodeId, SecretIdentity } from "./identity.ts";
import type { FrameHandler, NeighborHandler, PeerHandle, Transport } from "./transport.ts";
import { TransportTier, type Frame } from "./types.ts";

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
	ok: boolean;
	status: number;
	json: () => Promise<unknown>;
}>;

export interface RelayTransportOptions {
	/** Base URL of the relay, e.g. "https://relay.example.org". */
	relayUrl: string;
	identity: SecretIdentity;
	crypto: CryptoProvider;
	/** Defaults to the global fetch; injectable for tests. */
	fetchFn?: FetchLike;
	/** Poll cadence in ms. Set <= 0 to disable auto-polling (tests drive poll()). */
	pollIntervalMs?: number;
	/** Wall clock; injectable for tests. */
	now?: () => number;
	/** Whether the transport starts enabled. Defaults to true. */
	enabled?: boolean;
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Pure base64 (no Buffer / atob) so this stays portable to every runtime. */
function b64encode(bytes: Uint8Array): string {
	let out = "";
	let i = 0;
	for (; i + 2 < bytes.length; i += 3) {
		const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
		out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
	}
	if (i < bytes.length) {
		const rem = bytes.length - i;
		const n = (bytes[i]! << 16) | (rem > 1 ? bytes[i + 1]! << 8 : 0);
		out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!;
		out += rem > 1 ? B64[(n >> 6) & 63]! : "=";
		out += "=";
	}
	return out;
}

function b64decode(s: string): Uint8Array {
	const clean = s.replace(/[^A-Za-z0-9+/]/g, "");
	const len = Math.floor((clean.length * 3) / 4);
	const out = new Uint8Array(len);
	let o = 0;
	for (let i = 0; i < clean.length; i += 4) {
		const a = B64.indexOf(clean[i]!);
		const b = B64.indexOf(clean[i + 1]!);
		const c = i + 2 < clean.length ? B64.indexOf(clean[i + 2]!) : -1;
		const d = i + 3 < clean.length ? B64.indexOf(clean[i + 3]!) : -1;
		const n = (a << 18) | (b << 12) | ((c & 63) << 6) | (d & 63);
		if (o < len) out[o++] = (n >> 16) & 0xff;
		if (c >= 0 && o < len) out[o++] = (n >> 8) & 0xff;
		if (d >= 0 && o < len) out[o++] = n & 0xff;
	}
	return out;
}

const enc = new TextEncoder();

interface SignedAuthWire {
	nodeId: NodeId;
	ts: number;
	nonce: string;
	sig: string; // base64
}

export class RelayTransport implements Transport {
	readonly name = "relay-internet";
	readonly tier: TransportTier = TransportTier.Internet;

	private readonly base: string;
	private readonly identity: SecretIdentity;
	private readonly crypto: CryptoProvider;
	private readonly fetchFn: FetchLike;
	private readonly pollIntervalMs: number;
	private readonly now: () => number;

	private enabled: boolean;
	private started = false;
	private registered = false;
	private timer: ReturnType<typeof setInterval> | null = null;
	private polling = false;
	private frameHandler: FrameHandler | undefined;
	private neighborHandler: NeighborHandler | undefined;
	private readonly peers = new Set<PeerHandle>();
	private reachable = false;

	constructor(opts: RelayTransportOptions) {
		this.base = opts.relayUrl.replace(/\/+$/, "");
		this.identity = opts.identity;
		this.crypto = opts.crypto;
		const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
		const f = opts.fetchFn ?? globalFetch;
		if (!f) throw new Error("RelayTransport: no fetch available; pass opts.fetchFn");
		this.fetchFn = f;
		// Faster default presence/mailbox cadence (item #3): snappier discovery
		// and message pickup over the Internet tier. Tests inject their own value.
		this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
		this.now = opts.now ?? (() => Date.now());
		this.enabled = opts.enabled ?? true;
	}

	isAvailable(): boolean {
		return this.started && this.enabled && this.reachable;
	}

	/** Whether this mode's demo toggle is currently on (item #6). */
	isEnabledFlag(): boolean {
		return this.enabled;
	}

	/** Demo toggle (item #6). Disabling stops polling but keeps registration. */
	setEnabled(on: boolean): void {
		if (this.enabled === on) return;
		this.enabled = on;
		if (!on) {
			this.stopTimer();
			this.reachable = false;
			for (const p of [...this.peers]) this.dropPeer(p);
		} else if (this.started) {
			this.startTimer();
			void this.poll();
		}
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		if (!this.enabled) return;
		await this.ensureRegistered();
		await this.poll();
		this.startTimer();
	}

	stop(): void {
		this.started = false;
		this.reachable = false;
		this.stopTimer();
		for (const p of [...this.peers]) this.dropPeer(p);
	}

	neighbors(): PeerHandle[] {
		return [...this.peers];
	}

	onFrame(handler: FrameHandler): void {
		this.frameHandler = handler;
	}

	onNeighbor(handler: NeighborHandler): void {
		this.neighborHandler = handler;
	}

	async send(frame: Frame, peer?: PeerHandle): Promise<void> {
		if (!this.isAvailable()) return;
		const blob = this.wrap(frame);
		const targets = peer ? [peer] : [...this.peers];
		for (const dst of targets) await this.submit(dst, blob);
	}

	private wrap(frame: Frame): Uint8Array {
		return new ByteWriter().lpStr(this.identity.nodeId).bytes(encodeFrame(frame.type, frame.payload)).finish();
	}

	private startTimer(): void {
		if (this.timer || this.pollIntervalMs <= 0) return;
		this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
		(this.timer as { unref?: () => void }).unref?.();
	}

	private stopTimer(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	private addPeer(id: PeerHandle): void {
		if (this.peers.has(id)) return;
		this.peers.add(id);
		this.neighborHandler?.(id, true);
	}

	private dropPeer(id: PeerHandle): void {
		if (!this.peers.delete(id)) return;
		this.neighborHandler?.(id, false);
	}

	private async ensureRegistered(): Promise<void> {
		if (this.registered) return;
		await this.post("/register", {
			nodeId: this.identity.nodeId,
			signPub: b64encode(this.identity.signPub),
		});
		this.registered = true;
	}

	/** One discovery+delivery cycle. Public so tests can drive it deterministically. */
	async poll(): Promise<void> {
		if (!this.started || !this.enabled || this.polling) return;
		this.polling = true;
		try {
			await this.ensureRegistered();
			await this.refreshRoster();
			await this.drainMailbox();
			this.reachable = true;
		} catch {
			this.reachable = false;
		} finally {
			this.polling = false;
		}
	}

	private async refreshRoster(): Promise<void> {
		const auth = await this.auth("roster", await this.sha256Hex("roster"));
		const res = (await this.post("/roster", { auth })) as { ok: boolean; peers?: NodeId[] };
		if (!res.ok || !res.peers) return;
		const online = new Set(res.peers);
		for (const id of online) this.addPeer(id);
		for (const id of [...this.peers]) if (!online.has(id)) this.dropPeer(id);
	}

	private async drainMailbox(): Promise<void> {
		const limit = 64;
		const auth = await this.auth("pull", await this.sha256Hex(`pull|${limit}`));
		const res = (await this.post("/pull", { auth, limit })) as {
			ok: boolean;
			messages?: Array<{ id: string; blob: string }>;
		};
		if (!res.ok || !res.messages || res.messages.length === 0) return;
		const ids: string[] = [];
		for (const m of res.messages) {
			ids.push(m.id);
			try {
				this.deliver(b64decode(m.blob));
			} catch {
				// Skip undecodable blobs but still ack so they don't wedge the queue.
			}
		}
		const sorted = [...ids].sort();
		const ackAuth = await this.auth("ack", await this.sha256Hex(`ack|${sorted.join(",")}`));
		await this.post("/ack", { auth: ackAuth, ids });
	}

	private deliver(blob: Uint8Array): void {
		const r = new ByteReader(blob);
		const from = r.lpStr();
		const frame = decodeFrame(r.bytes(r.remaining));
		this.addPeer(from);
		this.frameHandler?.({ frame, from, transport: this.name });
	}

	private async submit(dst: PeerHandle, blob: Uint8Array): Promise<void> {
		const id = toHex(this.crypto.randomBytes(16));
		const prio = "normal";
		const bh = await this.sha256HexBytes(enc.encode(`${dst}|${id}|${prio}|`), blob);
		const auth = await this.auth("submit", bh);
		await this.post("/submit", { auth, dst, id, prio, blob: b64encode(blob) });
	}

	private async auth(op: string, bodyHashHex: string): Promise<SignedAuthWire> {
		const ts = this.now();
		const nonce = toHex(this.crypto.randomBytes(12));
		const msg = enc.encode([op, this.identity.nodeId, String(ts), nonce, bodyHashHex].join("\n"));
		const sig = await this.crypto.ed25519Sign(this.identity.signSeed, msg);
		return { nodeId: this.identity.nodeId, ts, nonce, sig: b64encode(sig) };
	}

	private async sha256Hex(s: string): Promise<string> {
		return toHex(await this.crypto.sha256(enc.encode(s)));
	}

	private async sha256HexBytes(prefix: Uint8Array, blob: Uint8Array): Promise<string> {
		const joined = new Uint8Array(prefix.length + blob.length);
		joined.set(prefix, 0);
		joined.set(blob, prefix.length);
		return toHex(await this.crypto.sha256(joined));
	}

	private async post(path: string, body: unknown): Promise<unknown> {
		const res = await this.fetchFn(`${this.base}${path}`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		return res.json();
	}
}
