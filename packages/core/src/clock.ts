/**
 * Clock abstraction. The engine never calls Date.now() or setTimeout directly;
 * it asks a Clock. This is what makes the whole protocol deterministically
 * simulatable: the simulator supplies a virtual clock with an event queue, so
 * thousands of timed routing decisions replay identically on every run.
 */
export interface TimerHandle {
	readonly id: number;
}

export interface Clock {
	now(): number;
	setTimer(delayMs: number, cb: () => void): TimerHandle;
	clearTimer(handle: TimerHandle): void;
}

/** Production clock backed by the host runtime. */
export class RealClock implements Clock {
	private seq = 0;
	private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();

	now(): number {
		return Date.now();
	}

	setTimer(delayMs: number, cb: () => void): TimerHandle {
		const id = ++this.seq;
		const t = setTimeout(
			() => {
				this.timers.delete(id);
				cb();
			},
			Math.max(0, delayMs),
		);
		// Don't keep the process alive solely for mesh timers.
		if (typeof (t as { unref?: () => void }).unref === "function") (t as { unref: () => void }).unref();
		this.timers.set(id, t);
		return { id };
	}

	clearTimer(handle: TimerHandle): void {
		const t = this.timers.get(handle.id);
		if (t) {
			clearTimeout(t);
			this.timers.delete(handle.id);
		}
	}
}
