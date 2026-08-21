/**
 * CryptoProvider abstracts every primitive the engine needs so the pure-TS core
 * can run identically on Node (tests / relay / simulator), in React Native
 * (react-native-quick-crypto), or on top of @noble/* in a de-Googled build.
 *
 * The engine NEVER imports a concrete crypto library directly — only this
 * interface — which is what keeps `packages/core` portable and unit-testable.
 */

export type AeadAlgorithm = "AES-256-GCM" | "CHACHA20-POLY1305";

/** Raw key material. Public keys are 32 raw bytes; we store private keys as
 * 32-byte seeds (Ed25519) / 32-byte scalars (X25519) for portable persistence. */
export interface RawKeyPair {
	readonly publicKey: Uint8Array; // 32 bytes
	readonly privateKey: Uint8Array; // 32 bytes (seed / scalar)
}

export interface CryptoProvider {
	readonly aead: AeadAlgorithm;

	randomBytes(length: number): Uint8Array;
	sha256(data: Uint8Array): Promise<Uint8Array>;

	// Ed25519 — identity & signatures.
	ed25519Generate(seed?: Uint8Array): Promise<RawKeyPair>;
	ed25519Sign(privateSeed: Uint8Array, message: Uint8Array): Promise<Uint8Array>;
	ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean>;

	// X25519 — key agreement.
	x25519Generate(scalar?: Uint8Array): Promise<RawKeyPair>;
	x25519SharedSecret(privateScalar: Uint8Array, peerPublicKey: Uint8Array): Promise<Uint8Array>;

	hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array>;

	// AEAD — key is 32 bytes, nonce is 12 bytes for both supported algorithms.
	aeadSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array>;
	/** Returns plaintext, or null on auth failure (never throws on bad tag). */
	aeadOpen(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, aad: Uint8Array): Promise<Uint8Array | null>;
}

export const NONCE_BYTES = 12;
export const KEY_BYTES = 32;
export const TAG_BYTES = 16;
