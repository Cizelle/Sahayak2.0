/**
 * Virtual, event-queue Clock. The engine schedules every timer through the
 * Clock interface, so swapping RealClock for SimClock lets thousands of timed
 * routing decisions (contention windows, rebroadcast delays, backoff) execute
 * in deterministic virtual time — instantly and reproducibly, with no wall-clock
 * flakiness. Ordering ties break by insertion sequence for full determinism.
 */
import type { Clock, TimerHandle } from "../../../packages/core/src/index.ts";

interface SimEvent {
	time: number;
	seq: number;
	cb: () => void;
	cancelled: boolean;
}

export class SimClock implements Clock {
	private t = 0;
	private seq = 0;
	private readonly queue: SimEvent[] = [];
	private readonly byId = new Map<number, SimEvent>();
	// In-flight async engine work (decrypt/verify/deliver) registered via
	// trackAsync(); run() awaits these before advancing virtual time.
	private readonly pending: Array<Promise<unknown>> = [];

	now(): number {
		return this.t;
	}

	setTimer(delayMs: number, cb: () => void): TimerHandle {
		const id = ++this.seq;
		// Quantize to integer milliseconds: real wall clocks expose integer ms, and
		// envelope timestamps are varuint-encoded (integers only). Rounding here keeps
		// virtual time integral end-to-end while preserving event ordering.
		const delay = Math.max(0, Math.round(delayMs));
		const ev: SimEvent = { time: this.t + delay, seq: id, cb, cancelled: false };
		this.insert(ev);
		this.byId.set(id, ev);
		return { id };
	}

	clearTimer(handle: TimerHandle): void {
		const ev = this.byId.get(handle.id);
		if (ev) ev.cancelled = true;
	}

	private insert(ev: SimEvent): void {
		// Binary search for the insertion point (queue kept sorted by time, seq).
		let lo = 0;
		let hi = this.queue.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			const e = this.queue[mid]!;
			if (e.time < ev.time || (e.time === ev.time && e.seq < ev.seq)) lo = mid + 1;
			else hi = mid;
		}
		this.queue.splice(lo, 0, ev);
	}

	/**
	 * Drain the queue (optionally until `maxTime`). Returns events fired.
	 *
	 * This is async on purpose. The engine's receive path (decrypt, verify,
	 * reassemble) is genuinely asynchronous because the CryptoProvider is async.
	 * A fired timer (e.g. a radio delivery) synchronously hands bytes to the
	 * engine, but the resulting decrypt/deliver completes on the microtask queue.
	 * After each event we therefore yield to a macrotask (`setImmediate`), which
	 * lets the entire pending microtask chain settle — and lets any follow-on
	 * timers it scheduled (rebroadcast contention, backoff) enqueue — before we
	 * advance virtual time. The work itself is deterministic (no real I/O), so
	 * draining this way preserves full reproducibility.
	 */
	async run(maxTime = Number.POSITIVE_INFINITY): Promise<number> {
		let fired = 0;
		// Settle any async work kicked off synchronously before the first event
		// (e.g. a HELLO triggered by a linkUp).
		await this.settle();
		while (this.queue.length > 0) {
			const ev = this.queue[0]!;
			if (ev.time > maxTime) break;
			this.queue.shift();
			this.byId.delete(ev.seq);
			if (ev.cancelled) continue;
			this.t = ev.time;
			ev.cb();
			fired++;
			// Deterministically await the FULL async consequence of this event — the
			// engine's decrypt/verify/deliver chain, tracked via trackAsync() — rather
			// than guessing with a single macrotask yield. A lone setImmediate
			// previously raced WebCrypto's threadpool completion, so on some hosts the
			// loop exited before delivery, yielding 0 deliveries. Awaiting the real
			// promise makes delivery reproducible on every host and Node version.
			await this.settle();
		}
		if (maxTime !== Number.POSITIVE_INFINITY && this.t < maxTime) this.t = maxTime;
		return fired;
	}

	/**
	 * Register an async operation (e.g. the engine's async receive) so run() can
	 * await it before advancing virtual time. This is what keeps the simulation
	 * deterministic across hosts even though the CryptoProvider is genuinely async.
	 */
	trackAsync(p: Promise<unknown>): void {
		this.pending.push(p);
	}

	/** Drain all tracked async engine work to completion. */
	private async settle(): Promise<void> {
		// Loop because awaited work can enqueue further async work; the trailing
		// macrotask yield lets threadpool-backed crypto callbacks be observed.
		while (this.pending.length > 0) {
			const batch = this.pending.splice(0, this.pending.length);
			await Promise.all(batch);
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	}

	get pendingTimers(): number {
		return this.queue.length;
	}
}
