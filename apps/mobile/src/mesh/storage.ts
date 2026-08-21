/**
 * On-device persistence for the mesh runtime.
 *
 * Persists exactly what item #2 asks for: the node's PERMANENT identity (the
 * ed25519 seeds that deterministically reproduce the same nodeId hash every
 * launch), the user-chosen device NAME (the non-unique alias broadcast to the
 * network), and the per-mode enable flags used for demos (item #6).
 *
 * Backed by the in-app MeshPrefs native module (Android SharedPreferences) --
 * NOT a third-party library. This keeps the Android build free of extra
 * Gradle/Maven artifacts (no KSP) so it builds on locked-down / offline
 * networks. Every call is wrapped so a missing native module (sandbox / Jest)
 * degrades to an in-memory cache: the UI stays fully usable, it just won't
 * survive a cold start there. On a real device the values are written to disk
 * and reload on the next launch, giving a stable identity + saved name.
 */
import type { IdentitySeeds } from "@adaptivemesh/core";
import { MeshPrefs } from "../native/MeshNative.ts";

const KEY = {
	seeds: "adaptivemesh.identitySeeds.v1",
	name: "adaptivemesh.deviceName.v1",
	modes: "adaptivemesh.modeFlags.v1",
	relayUrl: "adaptivemesh.relayUrl.v1",
	emergency: "adaptivemesh.emergencyNumber.v1",
	saved: "adaptivemesh.savedPeers.v1",
} as const;

export interface PersistedModeFlags {
	internet: boolean;
	wifi: boolean;
	ble: boolean;
	sms: boolean;
}

/** A device the user explicitly saved to chat with (item #4). */
export interface SavedPeer {
	nodeId: string;
	name: string;
	savedAt: number;
	/**
	 * Optional SOS phone number for this nearby device (item #4). This is strictly
	 * an SMS transport endpoint — NEVER the device's identity (identity stays the
	 * permanent ed25519 key/hash). Used only as an emergency SMS fallback target.
	 */
	phone?: string;
}

class MeshStore {
	private readonly mem = new Map<string, string>();

	private async read(key: string): Promise<string | null> {
		try {
			if (MeshPrefs) {
				const v = await MeshPrefs.getItem(key);
				if (v != null) return v;
			}
		} catch {
			/* fall through to in-memory */
		}
		return this.mem.get(key) ?? null;
	}

	private async write(key: string, value: string): Promise<void> {
		this.mem.set(key, value);
		try {
			if (MeshPrefs) await MeshPrefs.setItem(key, value);
		} catch {
			/* in-memory cache already holds it */
		}
	}

	async loadSeeds(): Promise<IdentitySeeds | null> {
		const raw = await this.read(KEY.seeds);
		if (!raw) return null;
		try {
			const parsed = JSON.parse(raw) as IdentitySeeds;
			if (parsed && parsed.v === 1 && parsed.signSeed && parsed.kexScalar) return parsed;
		} catch {
			/* corrupt -> regenerate */
		}
		return null;
	}

	async saveSeeds(seeds: IdentitySeeds): Promise<void> {
		await this.write(KEY.seeds, JSON.stringify(seeds));
	}

	async loadName(): Promise<string> {
		return (await this.read(KEY.name)) ?? "";
	}

	async saveName(name: string): Promise<void> {
		await this.write(KEY.name, name);
	}

	async loadModeFlags(): Promise<Partial<PersistedModeFlags>> {
		const raw = await this.read(KEY.modes);
		if (!raw) return {};
		try {
			return JSON.parse(raw) as Partial<PersistedModeFlags>;
		} catch {
			return {};
		}
	}

	async saveModeFlags(flags: PersistedModeFlags): Promise<void> {
		await this.write(KEY.modes, JSON.stringify(flags));
	}

	// ---- (5) Internet relay base URL --------------------------------------

	async loadRelayUrl(): Promise<string> {
		return (await this.read(KEY.relayUrl)) ?? "";
	}

	async saveRelayUrl(url: string): Promise<void> {
		await this.write(KEY.relayUrl, url.trim());
	}

	// ---- (2) Emergency SMS recipients -------------------------------------

	async loadEmergencyNumbers(): Promise<string[]> {
		const raw = await this.read(KEY.emergency);
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw) as unknown;
			if (Array.isArray(parsed)) {
				return parsed.filter((n): n is string => typeof n === "string" && n.trim().length > 0);
			}
		} catch {
			/* not JSON — fall through to the legacy single-number format below */
		}
		// Legacy: a single plain number was stored before multi-number support.
		const legacy = raw.trim();
		return legacy ? [legacy] : [];
	}

	async saveEmergencyNumbers(nums: string[]): Promise<void> {
		const clean = nums.map((n) => n.trim()).filter((n) => n.length > 0);
		await this.write(KEY.emergency, JSON.stringify(clean));
	}

	// ---- (4) Saved / favorite peers ---------------------------------------

	async loadSavedPeers(): Promise<SavedPeer[]> {
		const raw = await this.read(KEY.saved);
		if (!raw) return [];
		try {
			const parsed = JSON.parse(raw) as SavedPeer[];
			return Array.isArray(parsed) ? parsed.filter((p) => p && typeof p.nodeId === "string") : [];
		} catch {
			return [];
		}
	}

	async saveSavedPeers(peers: SavedPeer[]): Promise<void> {
		await this.write(KEY.saved, JSON.stringify(peers));
	}
}

/** App-wide singleton store. */
export const meshStore = new MeshStore();
