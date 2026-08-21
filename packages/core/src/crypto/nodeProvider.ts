/**
 * Node-backed CryptoProvider used by tests, the simulator, and the relay.
 * Uses only Node's built-in `node:crypto` (no external deps), which natively
 * supports Ed25519, X25519, HKDF-SHA256, AES-256-GCM and ChaCha20-Poly1305.
 *
 * On-device the same interface is satisfied by react-native-quick-crypto; in a
 * de-Googled build by @noble/ed25519 + @noble/curves + @noble/hashes. The
 * wire format produced here is identical across providers.
 */
import {
	createPrivateKey,
	createPublicKey,
	createCipheriv,
	createDecipheriv,
	diffieHellman,
	generateKeyPairSync,
	hkdfSync,
	randomBytes as nodeRandomBytes,
	sign as edSign,
	verify as edVerify,
	createHash,
	type KeyObject,
} from "node:crypto";
import type { AeadAlgorithm, CryptoProvider, RawKeyPair } from "./provider.ts";
import { KEY_BYTES } from "./provider.ts";

function b64url(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64url");
}
function unb64url(s: string): Uint8Array {
	return new Uint8Array(Buffer.from(s, "base64url"));
}

// --- Ed25519 raw <-> KeyObject (via JWK, which exposes raw x/d) -------------
function edPrivFromSeed(seed: Uint8Array): KeyObject {
	// Reconstruct the matching public key from the seed deterministically.
	const pub = edPubFromSeed(seed);
	return createPrivateKey({
		format: "jwk",
		key: { kty: "OKP", crv: "Ed25519", d: b64url(seed), x: b64url(pub) },
	});
}
function edPubFromSeed(seed: Uint8Array): Uint8Array {
	// Derive the public key by importing the seed as a private key with a dummy
	// x, then exporting — but JWK import requires x. Instead generate via the
	// standard derivation: Node can build a private key from PKCS8 seed.
	const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.from(seed)]);
	const priv = createPrivateKey({ format: "der", type: "pkcs8", key: pkcs8 });
	const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string };
	return unb64url(jwk.x);
}
function edPubToKeyObject(pub: Uint8Array): KeyObject {
	return createPublicKey({
		format: "jwk",
		key: { kty: "OKP", crv: "Ed25519", x: b64url(pub) },
	});
}

// --- X25519 raw <-> KeyObject ----------------------------------------------
function xPrivFromScalar(scalar: Uint8Array): KeyObject {
	const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b656e04220420", "hex"), Buffer.from(scalar)]);
	return createPrivateKey({ format: "der", type: "pkcs8", key: pkcs8 });
}
function xPubFromScalar(scalar: Uint8Array): Uint8Array {
	const priv = xPrivFromScalar(scalar);
	const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string };
	return unb64url(jwk.x);
}
function xPubToKeyObject(pub: Uint8Array): KeyObject {
	return createPublicKey({
		format: "jwk",
		key: { kty: "OKP", crv: "X25519", x: b64url(pub) },
	});
}

export class NodeCryptoProvider implements CryptoProvider {
	readonly aead: AeadAlgorithm;
	constructor(aead: AeadAlgorithm = "AES-256-GCM") {
		this.aead = aead;
	}

	randomBytes(length: number): Uint8Array {
		return new Uint8Array(nodeRandomBytes(length));
	}

	async sha256(data: Uint8Array): Promise<Uint8Array> {
		return new Uint8Array(createHash("sha256").update(data).digest());
	}

	async ed25519Generate(seed?: Uint8Array): Promise<RawKeyPair> {
		const s = seed ?? this.randomBytes(KEY_BYTES);
		if (s.length !== KEY_BYTES) throw new Error("ed25519 seed must be 32 bytes");
		return { privateKey: s, publicKey: edPubFromSeed(s) };
	}

	async ed25519Sign(privateSeed: Uint8Array, message: Uint8Array): Promise<Uint8Array> {
		return new Uint8Array(edSign(null, message, edPrivFromSeed(privateSeed)));
	}

	async ed25519Verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
		try {
			return edVerify(null, message, edPubToKeyObject(publicKey), signature);
		} catch {
			return false;
		}
	}

	async x25519Generate(scalar?: Uint8Array): Promise<RawKeyPair> {
		if (scalar) return { privateKey: scalar, publicKey: xPubFromScalar(scalar) };
		const { privateKey, publicKey } = generateKeyPairSync("x25519");
		const privJwk = privateKey.export({ format: "jwk" }) as { d: string };
		const pubJwk = publicKey.export({ format: "jwk" }) as { x: string };
		return { privateKey: unb64url(privJwk.d), publicKey: unb64url(pubJwk.x) };
	}

	async x25519SharedSecret(privateScalar: Uint8Array, peerPublicKey: Uint8Array): Promise<Uint8Array> {
		return new Uint8Array(
			diffieHellman({ privateKey: xPrivFromScalar(privateScalar), publicKey: xPubToKeyObject(peerPublicKey) }),
		);
	}

	async hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
		return new Uint8Array(hkdfSync("sha256", ikm, salt, info, length));
	}

	async aeadSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array): Promise<Uint8Array> {
		const algo = this.aead === "AES-256-GCM" ? "aes-256-gcm" : "chacha20-poly1305";
		// `algo` is dynamic; the cast selects the GCM-style overload that accepts
		// authTagLength (also required/valid for chacha20-poly1305 at runtime).
		const cipher = createCipheriv(algo as "aes-256-gcm", key, nonce, { authTagLength: 16 });
		cipher.setAAD(aad, { plaintextLength: plaintext.length });
		const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		return new Uint8Array(Buffer.concat([ct, cipher.getAuthTag()]));
	}

	async aeadOpen(
		key: Uint8Array,
		nonce: Uint8Array,
		ciphertext: Uint8Array,
		aad: Uint8Array,
	): Promise<Uint8Array | null> {
		if (ciphertext.length < 16) return null;
		const algo = this.aead === "AES-256-GCM" ? "aes-256-gcm" : "chacha20-poly1305";
		const tag = ciphertext.subarray(ciphertext.length - 16);
		const ct = ciphertext.subarray(0, ciphertext.length - 16);
		try {
			const decipher = createDecipheriv(algo as "aes-256-gcm", key, nonce, { authTagLength: 16 });
			decipher.setAAD(aad, { plaintextLength: ct.length });
			decipher.setAuthTag(tag);
			return new Uint8Array(Buffer.concat([decipher.update(ct), decipher.final()]));
		} catch {
			return null;
		}
	}
}
