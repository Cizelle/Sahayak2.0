/**
 * Congestion control as an explicit 4-state machine with hysteresis.
 *
 *   GREEN  -> everything flows
 *   YELLOW -> everything flows, bulk is de-prioritized by the scheduler
 *   ORANGE -> bulk is dropped; normal/control/sos flow
 *   RED    -> only sos + control flow (lifeline mode)
 *
 * The load signal is a normalized 0..1 measure (e.g. outbound queue depth /
 * capacity, or recent airtime utilization). Hysteresis prevents flapping at a
 * threshold boundary, which would otherwise cause oscillating drop behavior.
 */
import type { Priority } from "./types.ts";

export type CongestionState = "GREEN" | "YELLOW" | "ORANGE" | "RED";

export interface CongestionConfig {
	/** Rising thresholds on the 0..1 load signal. */
	yellow: number;
	orange: number;
	red: number;
	/** A state only relaxes once load falls this far below the entry threshold. */
	hysteresis: number;
}

export const DEFAULT_CONGESTION: CongestionConfig = {
	yellow: 0.5,
	orange: 0.75,
	red: 0.9,
	hysteresis: 0.1,
};

const ORDER: CongestionState[] = ["GREEN", "YELLOW", "ORANGE", "RED"];

export class CongestionController {
	private _state: CongestionState = "GREEN";
	constructor(private readonly cfg: CongestionConfig = DEFAULT_CONGESTION) {}

	get state(): CongestionState {
		return this._state;
	}

	/** Feed a normalized load value (0..1) and get the (possibly new) state. */
	update(load: number): CongestionState {
		const target = this.targetFor(load);
		const cur = ORDER.indexOf(this._state);
		const tgt = ORDER.indexOf(target);
		if (tgt > cur) {
			// Escalate immediately (protect the network fast).
			this._state = target;
		} else if (tgt < cur) {
			// De-escalate only if we are clearly below the current entry threshold.
			const entry = this.entryThreshold(this._state);
			if (load < entry - this.cfg.hysteresis) this._state = target;
		}
		return this._state;
	}

	private targetFor(load: number): CongestionState {
		if (load >= this.cfg.red) return "RED";
		if (load >= this.cfg.orange) return "ORANGE";
		if (load >= this.cfg.yellow) return "YELLOW";
		return "GREEN";
	}

	private entryThreshold(s: CongestionState): number {
		switch (s) {
			case "RED":
				return this.cfg.red;
			case "ORANGE":
				return this.cfg.orange;
			case "YELLOW":
				return this.cfg.yellow;
			case "GREEN":
				return 0;
		}
	}

	/** Admission control: may a message of this priority be sent/relayed now? */
	admits(prio: Priority): boolean {
		return admitsUnder(this._state, prio);
	}
}

export function admitsUnder(state: CongestionState, prio: Priority): boolean {
	switch (state) {
		case "GREEN":
		case "YELLOW":
			return true;
		case "ORANGE":
			return prio !== "bulk";
		case "RED":
			return prio === "sos" || prio === "control";
	}
}
