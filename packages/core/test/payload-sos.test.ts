import { test } from "node:test";
import assert from "node:assert/strict";
import {
	encodeText,
	encodeMedia,
	encodeLocation,
	encodePayload,
	decodePayload,
	type LocationInfo,
} from "../src/messagePayload.ts";
import { buildSosMessage } from "../src/sos.ts";
import { utf8 } from "../src/bytes.ts";

test("text payload round-trips", () => {
	const wire = encodeText("hello mesh \uD83D\uDC4B");
	const p = decodePayload(wire);
	assert.equal(p.kind, "text");
	assert.equal(p.text, "hello mesh \uD83D\uDC4B");
});

test("media payload round-trips with exact bytes", () => {
	const data = new Uint8Array([0, 1, 2, 250, 251, 255, 128, 64]);
	const wire = encodeMedia({ mime: "image/png", name: "pic.png", size: data.length }, data, "a caption");
	const p = decodePayload(wire);
	assert.equal(p.kind, "media");
	assert.equal(p.media?.mime, "image/png");
	assert.equal(p.media?.name, "pic.png");
	assert.equal(p.media?.size, data.length);
	assert.equal(p.text, "a caption");
	assert.deepEqual(Array.from(p.data ?? new Uint8Array()), Array.from(data));
});

test("media with no caption decodes without text", () => {
	const data = new Uint8Array([9, 9, 9]);
	const p = decodePayload(encodeMedia({ mime: "application/pdf", name: "d.pdf", size: 3 }, data));
	assert.equal(p.kind, "media");
	assert.equal(p.text, undefined);
});

test("location payload round-trips", () => {
	const loc: LocationInfo = { lat: 12.34567, lon: 76.54321, accuracyM: 8, tsMs: 1000, source: "gps" };
	const p = decodePayload(encodeLocation(loc));
	assert.equal(p.kind, "location");
	assert.equal(p.location?.lat, 12.34567);
	assert.equal(p.location?.source, "gps");
});

test("encodePayload dispatches by kind", () => {
	assert.equal(decodePayload(encodePayload({ kind: "text", text: "x" })).kind, "text");
	const d = new Uint8Array([1]);
	assert.equal(decodePayload(encodePayload({ kind: "media", media: { mime: "a/b", name: "n", size: 1 }, data: d })).kind, "media");
});

test("legacy plain-text body decodes as text (backward compatible)", () => {
	const legacy = utf8("old client message");
	const p = decodePayload(legacy);
	assert.equal(p.kind, "text");
	assert.equal(p.text, "old client message");
});

test("SOS with GPS includes coords, maps link and source", () => {
	const msg = buildSosMessage({
		deviceName: "Aria",
		shortId: "K7Q2",
		nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
		location: { lat: 12.97, lon: 77.59, accuracyM: 6, tsMs: Date.parse("2026-06-19T00:00:00.000Z"), source: "gps" },
		note: "trapped near tower",
		batteryPct: 41,
	});
	assert.match(msg, /EMERGENCY SOS/);
	assert.match(msg, /Aria \(K7Q2\)/);
	assert.match(msg, /12\.97000, 77\.59000/);
	assert.match(msg, /maps\.google\.com\/\?q=12\.97000,77\.59000/);
	assert.match(msg, /GPS/);
	assert.match(msg, /Battery: 41%/);
	assert.match(msg, /trapped near tower/);
});

test("SOS borrowed from peer is flagged approximate", () => {
	const msg = buildSosMessage({
		deviceName: "Aria",
		shortId: "K7Q2",
		nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
		location: { lat: 1, lon: 2, tsMs: Date.parse("2026-06-19T00:00:00.000Z"), source: "peer", fromDevice: "Rohan" },
	});
	assert.match(msg, /via nearby device Rohan/);
	assert.match(msg, /approximate/);
});

test("SOS with no location says unavailable but still sends", () => {
	const msg = buildSosMessage({
		deviceName: "Aria",
		shortId: "K7Q2",
		nowMs: Date.parse("2026-06-19T00:00:00.000Z"),
		location: null,
	});
	assert.match(msg, /UNAVAILABLE/);
	assert.match(msg, /EMERGENCY SOS/);
});
