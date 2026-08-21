/**
 * Runtime polyfills for the Hermes / React Native JS engine.
 * MUST be the first import in index.js so these globals exist before any
 * @adaptivemesh/core or @noble crypto code runs.
 *
 * 1. react-native-get-random-values installs crypto.getRandomValues from the
 *    platform CSPRNG. @noble/* draws ALL secure randomness from it and Hermes
 *    does not provide it, so this import MUST stay first.
 * 2. TextEncoder / TextDecoder: used by core/bytes.ts and the Double Ratchet
 *    HKDF info labels (UTF-8 only). Hermes does not ship them.
 * 3. Buffer: kept for any dependency that expects a Node Buffer global.
 */
import "react-native-get-random-values";
import { Buffer } from "buffer";

if (typeof global.Buffer === "undefined") {
	global.Buffer = Buffer;
}

if (typeof global.TextEncoder === "undefined") {
	global.TextEncoder = class TextEncoder {
		get encoding() {
			return "utf-8";
		}

		encode(input = "") {
			return new Uint8Array(Buffer.from(String(input), "utf-8"));
		}
	};
}

if (typeof global.TextDecoder === "undefined") {
	global.TextDecoder = class TextDecoder {
		constructor(label = "utf-8") {
			this.encoding = String(label || "utf-8").toLowerCase();
		}

		decode(input) {
			if (input == null) {
				return "";
			}
			return Buffer.from(input).toString("utf-8");
		}
	};
}
