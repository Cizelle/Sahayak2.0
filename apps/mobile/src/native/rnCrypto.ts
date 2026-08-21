/**
 * On-device CryptoProvider backed by the audited, pure-TypeScript @noble
 * libraries -- NO native crypto modules.
 *
 * WHY NOT react-native-quick-crypto: on-device, its Nitro/TurboModule native
 * chain (react-native-nitro-modules, QuickBase64, ...) repeatedly failed to
 * register in the app binary. @noble runs directly in Hermes with zero native
 * linking and implements the exact same standardized primitives:
 *   - Ed25519 (RFC 8032)               identity and signatures
 *   - X25519  (RFC 7748)               key agreement
 *   - HKDF-SHA256 (RFC 5869)           key schedule
 *   - AES-256-GCM / ChaCha20-Poly1305  (RFC 8439) AEAD
 * Because these are standardized algorithms the byte output is identical to
 * NodeCryptoProvider, so the wire format the 37 core tests pin is preserved and
 * a phone interoperates with the Node relay/simulator unchanged.
 *
 * Secure randomness: @noble draws from crypto.getRandomValues, which Hermes
 * does NOT provide. react-native-get-random-values (imported first in
 * polyfills.js) installs it from the platform CSPRNG. That is the ONLY native
 * dependency the crypto layer now needs, and it is a tiny, ubiquitous module.
 */
import { ed25519, x25519 } from "@noble/curves/ed25519";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { hkdf as nobleHkdf } from "@noble/hashes/hkdf";
import { randomBytes as nobleRandomBytes } from "@noble/hashes/utils";
import { gcm } from "@noble/ciphers/aes";
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import type { AeadAlgorithm, CryptoProvider, RawKeyPair } from "@adaptivemesh/core";
import { KEY_BYTES, TAG_BYTES } from "@adaptivemesh/core";

export class RnCryptoProvider implements CryptoProvider {
	readonly aead: AeadAlgorithm;

	constructor(aead: AeadAlgorithm = "AES-256-GCM") {
		this.aead = aead;
	}

	randomBytes(length: number): Uint8Array {
		return nobleRandomBytes(length);
	}

	async sha256(data: Uint8Array): Promise<Uint8Array> {
		return nobleSha256(data);
	}

	async ed25519Generate(seed?: Uint8Array): Promise<RawKeyPair> {
		const s = seed ?? this.randomBytes(KEY_BYTES);
		if (s.length !== KEY_BYTES) throw new Error("ed25519 seed must be 32 bytes");
		return { privateKey: s, publicKey: ed25519.getPublicKey(s) };
	}

	async ed25519Sign(privateSeed: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
		return ed25519.sign(message, privateSeed);
	}

	async ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
		try {
			return ed25519.verify(signature, message, publicKey);
		} catch {
			return false;
		}
	}

	async x25519Generate(scalar?: Uint8Array): Promise<RawKeyPair> {
		const s = scalar ?? this.randomBytes(KEY_BYTES);
		if (s.length !== KEY_BYTES) throw new Error("x25519 scalar must be 32 bytes");
		return { privateKey: s, publicKey: x25519.getPublicKey(s) };
	}

	async x25519SharedSecret(privateScalar: Uint8Array, peerPublicKey: Uint8Array): Promise<Uint8Array> {
		return x25519.getSharedSecret(privateScalar, peerPublicKey);
	}

	async hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
		return nobleHkdf(nobleSha256, ikm, salt, info, length);
	}

	async aeadSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
		const cipher = this.aead === "AES-256-GCM" ? gcm(key, nonce, aad) : chacha20poly1305(key, nonce, aad);
		return cipher.encrypt(plaintext);
	}

	async aeadOpen(
		key: Uint8Array,
		nonce: Uint8Array,
		ciphertext: Uint8Array,
		aad: Uint8Array,
	): Promise<Uint8Array | null> {
		if (ciphertext.length < TAG_BYTES) return null;
		try {
			const cipher = this.aead === "AES-256-GCM" ? gcm(key, nonce, aad) : chacha20poly1305(key, nonce, aad);
			return cipher.decrypt(ciphertext);
		} catch {
			return null;
		}
	}
}
