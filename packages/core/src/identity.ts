/**
 * Identity & trust.
 *
 * An identity is an Ed25519 signing keypair (proves authorship) plus an X25519
 * key-agreement keypair (lets peers encrypt to it). The durable node id is
 * `hash(ed25519 public key)` — NOT an IP, MAC, or phone number, all of which
 * are ephemeral, spoofable, or privacy-sensitive.
 *
 * Trust is TOFU (trust-on-first-use): the first time we see a node id we pin
 * its keys; if the keys later change for the same id we raise a LOUD warning
 * rather than silently accepting (defends against key-substitution / MITM).
 */
import { fromHex, toHex } from "./bytes.ts";
import type { CryptoProvider } from "./crypto/provider.ts";

export type NodeId = string; // hex of sha256(ed25519 pub); full 64 chars.

export interface PublicIdentity {
	readonly nodeId: NodeId;
	readonly signPub: Uint8Array; // Ed25519 public key (32 bytes)
	readonly kexPub: Uint8Array; // X25519 public key (32 bytes)
}

export interface SecretIdentity extends PublicIdentity {
	readonly signSeed: Uint8Array; // Ed25519 seed (keep secret)
	readonly kexScalar: Uint8Array; // X25519 scalar (keep secret)
}

export async function deriveNodeId(crypto: CryptoProvider, signPub: Uint8Array): Promise<NodeId> {
	return toHex(await crypto.sha256(signPub));
}

/** Short, human-facing fingerprint (first 8 hex) for UI/logs. Never used for routing. */
export function shortId(nodeId: NodeId): string {
	return nodeId.slice(0, 8);
}

export async function generateIdentity(
	crypto: CryptoProvider,
	seeds?: { signSeed?: Uint8Array; kexScalar?: Uint8Array },
): Promise<SecretIdentity> {
	const sign = await crypto.ed25519Generate(seeds?.signSeed);
	const kex = await crypto.x25519Generate(seeds?.kexScalar);
	const nodeId = await deriveNodeId(crypto, sign.publicKey);
	return {
		nodeId,
		signPub: sign.publicKey,
		kexPub: kex.publicKey,
		signSeed: sign.privateKey,
		kexScalar: kex.privateKey,
	};
}

export function toPublic(id: SecretIdentity): PublicIdentity {
	return { nodeId: id.nodeId, signPub: id.signPub, kexPub: id.kexPub };
}

/**
 * Persisted form of a secret identity. We only store the two seeds (hex); the
 * public keys and nodeId are deterministically re-derived from them via
 * `generateIdentity`, so the permanent hash (nodeId) is stable across launches
 * as long as the seeds survive. Never log or transmit this blob.
 */
export interface IdentitySeeds {
	readonly v: 1;
	readonly signSeed: string; // hex
	readonly kexScalar: string; // hex
}

/** Serialize the secret seeds of an identity for on-device persistence. */
export function exportIdentitySeeds(id: SecretIdentity): IdentitySeeds {
	return { v: 1, signSeed: toHex(id.signSeed), kexScalar: toHex(id.kexScalar) };
}

/**
 * Re-create a full identity from persisted seeds. The resulting nodeId is
 * guaranteed identical to the original because both keypairs are derived
 * deterministically from these seeds.
 */
export async function importIdentitySeeds(crypto: CryptoProvider, seeds: IdentitySeeds): Promise<SecretIdentity> {
	if (seeds.v !== 1) throw new Error(`importIdentitySeeds: unsupported version ${String(seeds.v)}`);
	return generateIdentity(crypto, {
		signSeed: fromHex(seeds.signSeed),
		kexScalar: fromHex(seeds.kexScalar),
	});
}

export type TrustDecision =
	| { kind: "new"; identity: PublicIdentity }
	| { kind: "known"; identity: PublicIdentity }
	| { kind: "key-change"; previous: PublicIdentity; presented: PublicIdentity };

/**
 * TOFU trust store. Pins (nodeId -> keys) on first sight and flags changes.
 * The engine surfaces `key-change` to the UI as an explicit, scary warning and
 * never auto-accepts the new key.
 */
export class TrustStore {
	private readonly pinned = new Map<NodeId, PublicIdentity>();

	constructor(initial?: Iterable<PublicIdentity>) {
		if (initial) for (const id of initial) this.pinned.set(id.nodeId, id);
	}

	get(nodeId: NodeId): PublicIdentity | undefined {
		return this.pinned.get(nodeId);
	}

	observe(identity: PublicIdentity): TrustDecision {
		const existing = this.pinned.get(identity.nodeId);
		if (!existing) {
			this.pinned.set(identity.nodeId, identity);
			return { kind: "new", identity };
		}
		const same =
			toHex(existing.signPub) === toHex(identity.signPub) && toHex(existing.kexPub) === toHex(identity.kexPub);
		if (same) return { kind: "known", identity: existing };
		return { kind: "key-change", previous: existing, presented: identity };
	}

	/** Explicit user action required to accept a rotated key. */
	acceptKeyChange(identity: PublicIdentity): void {
		this.pinned.set(identity.nodeId, identity);
	}

	snapshot(): PublicIdentity[] {
		return [...this.pinned.values()];
	}
}
