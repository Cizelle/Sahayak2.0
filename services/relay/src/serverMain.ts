/**
 * PRODUCTION relay entrypoint — fully real and runnable with ZERO external
 * dependencies (node:http + node:sqlite only), so it runs offline and in CI.
 *
 *   RELAY_DB=./relay.db PORT=8787 node --import tsx services/relay/src/serverMain.ts
 *
 * It composes the three audited pieces:
 *   - RelayCore           (pure zero-knowledge store-and-forward logic, tested)
 *   - SqliteRelayStore    (durable embedded persistence, survives restart)
 *   - createRelayHttpServer (node:http wire server, tested over loopback)
 *
 * A background sweep prunes expired envelopes so the mailbox cannot grow
 * unbounded. SIGINT/SIGTERM flush the database cleanly.
 */
import { NodeCryptoProvider } from "../../../packages/core/src/crypto/nodeProvider.ts";
import { RelayCore, DEFAULT_RELAY_CONFIG } from "./relayCore.ts";
import { SqliteRelayStore } from "./sqliteStore.ts";
import { createRelayHttpServer } from "./serverHttp.ts";

export interface RelayServerHandle {
	port: number;
	close(): Promise<void>;
}

/**
 * Build and start a real relay server. Exposed as a function so tests can boot
 * it on an ephemeral port; main() below wires it to env + signals.
 */
export async function startRelayServer(opts: {
	dbPath?: string;
	port?: number;
	sweepMs?: number;
}): Promise<RelayServerHandle> {
	const crypto = new NodeCryptoProvider("AES-256-GCM");
	const store = new SqliteRelayStore(opts.dbPath ?? ":memory:");
	const core = new RelayCore(crypto, store, { now: () => Date.now() }, DEFAULT_RELAY_CONFIG);
	const server = createRelayHttpServer(core);

	const sweepMs = opts.sweepMs ?? 60_000;
	const sweep = setInterval(() => {
		try {
			store.pruneExpired(Date.now());
		} catch {
			// non-fatal; next sweep retries
		}
	}, sweepMs);
	if (typeof sweep.unref === "function") sweep.unref();

	const port: number = await new Promise((resolve, reject) => {
		server.on("error", reject);
		server.listen(opts.port ?? 0, () => {
			const addr = server.address();
			resolve(typeof addr === "object" && addr ? addr.port : (opts.port ?? 0));
		});
	});

	return {
		port,
		close: () =>
			new Promise<void>((resolve) => {
				clearInterval(sweep);
				server.close(() => {
					store.close();
					resolve();
				});
			}),
	};
}

async function main(): Promise<void> {
	const dbPath = process.env["RELAY_DB"] ?? "./relay.db";
	const port = Number(process.env["PORT"] ?? 8787);
	const handle = await startRelayServer({ dbPath, port });
	// eslint-disable-next-line no-console
	console.log(`AdaptiveMesh relay listening on :${handle.port} (db=${dbPath})`);
	const shutdown = (): void => {
		void handle.close().then(() => process.exit(0));
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);
}

// Run main() only when executed directly (not when imported by tests).
const invokedDirectly = process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
	void main();
}
