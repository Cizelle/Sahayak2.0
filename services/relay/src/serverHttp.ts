/**
 * Zero-dependency HTTP front-end for the relay, built on node:http so it runs
 * and is tested entirely offline. Binary fields (signatures, ciphertext blobs)
 * are base64 in JSON. This is the reference server; services/relay/src/server.ts
 * shows the Fastify + Postgres production variant.
 *
 * Endpoints (all JSON):
 *   POST /register  { nodeId, signPub(b64) }
 *   POST /submit    { auth, dst, id, prio?, blob(b64) }
 *   POST /pull      { auth, limit? }            -> { ok, messages:[{id,dst,prio,blob(b64),...}] }
 *   POST /ack       { auth, ids[] }
 * `auth` = { nodeId, ts, nonce, sig(b64) }.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AckRequest, PullRequest, RelayCore, RosterRequest, SignedAuth, SubmitRequest } from "./relayCore.ts";

const b64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");
const unb64 = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64"));

function parseAuth(raw: unknown): SignedAuth {
	const a = raw as { nodeId: string; ts: number; nonce: string; sig: string };
	return { nodeId: a.nodeId, ts: a.ts, nonce: a.nonce, sig: unb64(a.sig) };
}

async function readJson(req: IncomingMessage, maxBytes: number): Promise<unknown> {
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of req) {
		const buf = chunk as Buffer;
		total += buf.length;
		if (total > maxBytes) throw new Error("payload too large");
		chunks.push(buf);
	}
	if (total === 0) return {};
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function send(res: ServerResponse, status: number, payload: unknown): void {
	const body = JSON.stringify(payload);
	res.writeHead(status, { "content-type": "application/json" });
	res.end(body);
}

/** Build (but do not start) an HTTP server bound to a RelayCore instance. */
export function createRelayHttpServer(core: RelayCore, maxBodyBytes = 256 * 1024): Server {
	return createServer((req, res) => {
		void handle(req, res, core, maxBodyBytes).catch((err) => {
			send(res, 400, { ok: false, error: "invalid", detail: (err as Error).message });
		});
	});
}

async function handle(req: IncomingMessage, res: ServerResponse, core: RelayCore, maxBodyBytes: number): Promise<void> {
	if (req.method !== "POST") {
		send(res, 405, { ok: false, error: "invalid" });
		return;
	}
	const route = (req.url ?? "").split("?")[0];
	const body = (await readJson(req, maxBodyBytes)) as Record<string, unknown>;

	switch (route) {
		case "/register": {
			const r = await core.register({ nodeId: body["nodeId"] as string, signPub: unb64(body["signPub"] as string) });
			send(res, r.ok ? 200 : 400, r);
			return;
		}
		case "/submit": {
			const submit: SubmitRequest = {
				auth: parseAuth(body["auth"]),
				dst: body["dst"] as string,
				id: body["id"] as string,
				blob: unb64(body["blob"] as string),
				...(body["prio"] ? { prio: body["prio"] as "sos" | "normal" } : {}),
			};
			const r = await core.submit(submit);
			send(res, r.ok ? 200 : 400, r);
			return;
		}
		case "/pull": {
			const pull: PullRequest = {
				auth: parseAuth(body["auth"]),
				...(typeof body["limit"] === "number" ? { limit: body["limit"] as number } : {}),
			};
			const r = await core.pull(pull);
			if (!r.ok) {
				send(res, 400, r);
				return;
			}
			send(res, 200, {
				ok: true,
				messages: r.messages.map((m) => ({
					id: m.id,
					dst: m.dst,
					prio: m.prio,
					receivedAt: m.receivedAt,
					expiresAt: m.expiresAt,
					blob: b64(m.blob),
				})),
			});
			return;
		}
		case "/ack": {
			const ack: AckRequest = { auth: parseAuth(body["auth"]), ids: (body["ids"] as string[]) ?? [] };
			const r = await core.ack(ack);
			send(res, r.ok ? 200 : 400, r);
			return;
		}
		case "/roster": {
			const roster: RosterRequest = { auth: parseAuth(body["auth"]) };
			const r = await core.roster(roster);
			send(res, r.ok ? 200 : 400, r);
			return;
		}
		default:
			send(res, 404, { ok: false, error: "invalid" });
	}
}
