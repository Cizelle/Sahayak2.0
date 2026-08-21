/**
 * Retry / backoff math: exponential backoff WITH jitter, a hard attempt cap,
 * and expiry awareness. Jitter is essential in a broadcast medium — without it,
 * many nodes retry in lockstep and create synchronized collision storms.
 */
export interface BackoffConfig {
	baseMs: number;
	factor: number;
	maxMs: number;
	/** Fractional jitter in [0,1]; delay is multiplied by 1 +/- jitter. */
	jitter: number;
	maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
	baseMs: 500,
	factor: 2,
	maxMs: 30_000,
	jitter: 0.3,
	maxAttempts: 6,
};

/**
 * Delay before attempt number `attempt` (0-based: attempt 0 is the first retry
 * after the initial send). `rand` returns a value in [0,1); inject it so the
 * simulator stays deterministic.
 */
export function backoffDelay(attempt: number, cfg: BackoffConfig, rand: () => number): number {
	const raw = Math.min(cfg.maxMs, cfg.baseMs * Math.pow(cfg.factor, Math.max(0, attempt)));
	const spread = raw * cfg.jitter * (rand() * 2 - 1); // +/- jitter
	return Math.max(0, Math.round(raw + spread));
}

/** A small contention window (used before flood rebroadcast). */
export function contentionDelay(minMs: number, maxMs: number, rand: () => number): number {
	if (maxMs < minMs) throw new Error("contentionDelay: max < min");
	return Math.round(minMs + rand() * (maxMs - minMs));
}
