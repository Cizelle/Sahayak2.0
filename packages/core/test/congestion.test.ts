import { test } from "node:test";
import assert from "node:assert/strict";
import { CongestionController, admitsUnder, DEFAULT_CONGESTION } from "../src/congestion.ts";
import { backoffDelay, contentionDelay, DEFAULT_BACKOFF } from "../src/scheduler.ts";

test("congestion escalates immediately, relaxes with hysteresis", () => {
	const c = new CongestionController(DEFAULT_CONGESTION);
	assert.equal(c.update(0.1), "GREEN");
	assert.equal(c.update(0.95), "RED"); // jump straight up
	// Just below red threshold: hysteresis keeps us in RED.
	assert.equal(c.update(0.85), "RED");
	// Clearly below red - hysteresis: relax (to ORANGE, the target for 0.78).
	assert.equal(c.update(0.78), "ORANGE");
	assert.equal(c.update(0.0), "GREEN");
});

test("RED admits only sos/control; ORANGE drops bulk", () => {
	assert.equal(admitsUnder("RED", "sos"), true);
	assert.equal(admitsUnder("RED", "control"), true);
	assert.equal(admitsUnder("RED", "normal"), false);
	assert.equal(admitsUnder("RED", "bulk"), false);
	assert.equal(admitsUnder("ORANGE", "normal"), true);
	assert.equal(admitsUnder("ORANGE", "bulk"), false);
	assert.equal(admitsUnder("GREEN", "bulk"), true);
});

test("backoff grows exponentially and is bounded", () => {
	const noJitter = { ...DEFAULT_BACKOFF, jitter: 0 };
	assert.equal(
		backoffDelay(0, noJitter, () => 0.5),
		500,
	);
	assert.equal(
		backoffDelay(1, noJitter, () => 0.5),
		1000,
	);
	assert.equal(
		backoffDelay(2, noJitter, () => 0.5),
		2000,
	);
	// Capped at maxMs.
	assert.equal(
		backoffDelay(20, noJitter, () => 0.5),
		30_000,
	);
});

test("jitter stays within +/- band and never negative", () => {
	for (let i = 0; i < 100; i++) {
		const r = Math.random();
		const d = backoffDelay(1, DEFAULT_BACKOFF, () => r);
		assert.ok(d >= 700 && d <= 1300, `delay ${d} out of jitter band`);
	}
	assert.ok(backoffDelay(0, DEFAULT_BACKOFF, () => 0) >= 0);
});

test("contention delay is within the window", () => {
	for (let i = 0; i < 50; i++) {
		const d = contentionDelay(20, 80, Math.random);
		assert.ok(d >= 20 && d <= 80);
	}
});
