/**
 * SOS message composition (item #2).
 *
 * A pure, dependency-free, deterministic builder so it can be unit-tested and
 * reused identically by the mesh path (sealed broadcast over every active
 * tier) and the SMS path (SmsManager / smsto: composer). It encodes the
 * location-priority rule the user asked for:
 *
 *   1. own GPS / network fix   (best)
 *   2. a nearby device's fix   (borrowed via a mesh location beacon)
 *   3. no fix                  (explicitly say so; still send the SOS)
 *
 * The caller decides WHICH location to pass (it applies the fallback order);
 * this module only formats whatever it is given into the clearest possible
 * human-readable distress message, with a tappable maps link for responders.
 */
import type { LocationInfo } from "./messagePayload.ts";

export interface SosContext {
	/** Sender's chosen alias (non-unique display name). */
	deviceName: string;
	/** Sender's permanent short id (stable hash of identity). */
	shortId: string;
	/** Now, epoch ms (injected for deterministic tests). */
	nowMs: number;
	/** Best available location per the 1->2->3 fallback, or null/undefined if none. */
	location?: LocationInfo | null;
	/** Optional free-text note from the user. */
	note?: string;
	/** Battery percentage 0..100 if cheaply available. */
	batteryPct?: number | null;
}

function fmtCoord(n: number): string {
	return n.toFixed(5);
}

function mapsLink(lat: number, lon: number): string {
	return "https://maps.google.com/?q=" + fmtCoord(lat) + "," + fmtCoord(lon);
}

function sourceLabel(loc: LocationInfo): string {
	if (loc.source === "peer") {
		return loc.fromDevice ? `via nearby device ${loc.fromDevice}` : "via nearby device";
	}
	if (loc.source === "network") return "network fix";
	return "GPS";
}

function ageLabel(loc: LocationInfo, nowMs: number): string {
	const sec = Math.max(0, Math.round((nowMs - loc.tsMs) / 1000));
	if (sec < 5) return "just now";
	if (sec < 90) return `${sec}s ago`;
	const min = Math.round(sec / 60);
	return `${min}m ago`;
}

/**
 * Build the human-readable SOS body. Designed to be useful both as a mesh
 * message and as an SMS (multipart handles >160 chars).
 */
export function buildSosMessage(ctx: SosContext): string {
	const lines: string[] = [];
	const who = ctx.deviceName && ctx.deviceName.trim().length > 0 ? ctx.deviceName.trim() : "Unknown device";
	lines.push("\uD83C\uDD98 EMERGENCY SOS — I need help.");
	lines.push(`From: ${who} (${ctx.shortId})`);
	lines.push(`Time: ${new Date(ctx.nowMs).toISOString()}`);

	if (ctx.location) {
		const loc = ctx.location;
		const acc = typeof loc.accuracyM === "number" ? ` (±${Math.round(loc.accuracyM)} m)` : "";
		lines.push(`Location: ${fmtCoord(loc.lat)}, ${fmtCoord(loc.lon)}${acc} — ${sourceLabel(loc)}, ${ageLabel(loc, ctx.nowMs)}`);
		lines.push(`Map: ${mapsLink(loc.lat, loc.lon)}`);
		if (loc.source === "peer") {
			lines.push("(Position is approximate — borrowed from a nearby device; my own GPS was unavailable.)");
		}
	} else {
		lines.push("Location: UNAVAILABLE — no GPS fix and no nearby device location. Last-known whereabouts unknown.");
	}

	if (typeof ctx.batteryPct === "number") {
		lines.push(`Battery: ${Math.round(ctx.batteryPct)}%`);
	}
	if (ctx.note && ctx.note.trim().length > 0) {
		lines.push(`Note: ${ctx.note.trim()}`);
	}
	lines.push("Sent via AdaptiveMesh offline mesh relay. Please respond or alert emergency services.");
	return lines.join("\n");
}
