/**
 * Durable, embedded, zero-dependency RelayStore backed by node:sqlite
 * (DatabaseSync — synchronous, so it satisfies the RelayStore contract exactly
 * with no async shim).
 *
 * This is the production persistence the reference MemoryRelayStore could not
 * provide: queued store-and-forward envelopes SURVIVE A PROCESS RESTART, so a
 * relay reboot/crash no longer drops in-flight messages.
 *
 * ZERO-KNOWLEDGE: only the opaque AEAD ciphertext blob, the destination nodeId,
 * a client-chosen message id, priority and timestamps are persisted. Plaintext
 * and private keys never reach the relay (see relayCore.ts).
 *
 * Pass a file path for durability, or ":memory:" for an ephemeral instance.
 */
import { DatabaseSync } from "node:sqlite";
import type { NodeId } from "../../../packages/core/src/index.ts";
import type { RelayPriority, RelayStore, StoredMessage } from "./relayCore.ts";

export class SqliteRelayStore implements RelayStore {
	private readonly db: DatabaseSync;

	constructor(path = ":memory:") {
		this.db = new DatabaseSync(path);
		// WAL improves concurrent read/write durability for a long-lived relay.
		this.db.exec("PRAGMA journal_mode = WAL;");
		this.db.exec("PRAGMA synchronous = NORMAL;");
		this.db.exec(
			`CREATE TABLE IF NOT EXISTS relay_mailbox (
				id TEXT PRIMARY KEY,
				dst TEXT NOT NULL,
				prio TEXT NOT NULL,
				received_at INTEGER NOT NULL,
				expires_at INTEGER NOT NULL,
				blob BLOB NOT NULL
			);`,
		);
		this.db.exec("CREATE INDEX IF NOT EXISTS relay_mailbox_dst_idx ON relay_mailbox (dst, expires_at);");
	}

	/** Close the underlying database handle (flushes WAL). */
	close(): void {
		this.db.close();
	}

	put(msg: StoredMessage): void {
		const stmt = this.db.prepare(
			`INSERT OR REPLACE INTO relay_mailbox (id, dst, prio, received_at, expires_at, blob)
			 VALUES (?, ?, ?, ?, ?, ?);`,
		);
		stmt.run(msg.id, msg.dst, msg.prio, msg.receivedAt, msg.expiresAt, toBuffer(msg.blob));
	}

	has(id: string): boolean {
		const row = this.db.prepare("SELECT 1 AS hit FROM relay_mailbox WHERE id = ?;").get(id);
		return row !== undefined;
	}

	listFor(dst: NodeId, limit: number, now: number): StoredMessage[] {
		// SOS first, then oldest-first, with id as a deterministic tiebreaker —
		// identical ordering to MemoryRelayStore so behavior is store-agnostic.
		const rows = this.db
			.prepare(
				`SELECT id, dst, prio, received_at, expires_at, blob
				 FROM relay_mailbox
				 WHERE dst = ? AND expires_at > ?
				 ORDER BY CASE WHEN prio = 'sos' THEN 0 ELSE 1 END ASC, received_at ASC, id ASC
				 LIMIT ?;`,
			)
			.all(dst, now, limit) as unknown as Array<RawRow>;
		return rows.map(rowToStored);
	}

	deleteByIds(dst: NodeId, ids: readonly string[]): number {
		if (ids.length === 0) return 0;
		const placeholders = ids.map(() => "?").join(", ");
		const stmt = this.db.prepare(`DELETE FROM relay_mailbox WHERE dst = ? AND id IN (${placeholders});`);
		const info = stmt.run(dst, ...ids);
		return Number(info.changes);
	}

	countFor(dst: NodeId, now: number): number {
		const row = this.db
			.prepare("SELECT COUNT(*) AS n FROM relay_mailbox WHERE dst = ? AND expires_at > ?;")
			.get(dst, now) as { n: number };
		return Number(row.n);
	}

	pruneExpired(now: number): number {
		const info = this.db.prepare("DELETE FROM relay_mailbox WHERE expires_at <= ?;").run(now);
		return Number(info.changes);
	}

	total(): number {
		const row = this.db.prepare("SELECT COUNT(*) AS n FROM relay_mailbox;").get() as { n: number };
		return Number(row.n);
	}
}

interface RawRow {
	id: string;
	dst: string;
	prio: string;
	received_at: number;
	expires_at: number;
	blob: Uint8Array;
}

function rowToStored(r: RawRow): StoredMessage {
	return {
		id: r.id,
		dst: r.dst,
		prio: r.prio as RelayPriority,
		receivedAt: Number(r.received_at),
		expiresAt: Number(r.expires_at),
		blob: new Uint8Array(r.blob),
	};
}

/** node:sqlite accepts Uint8Array for BLOB params; normalize defensively. */
function toBuffer(u: Uint8Array): Uint8Array {
	return u instanceof Uint8Array ? u : new Uint8Array(u);
}
