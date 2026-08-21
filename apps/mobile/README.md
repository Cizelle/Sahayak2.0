# @adaptivemesh/mobile

React Native 0.81 (New Architecture) Android-first client for AdaptiveMesh.

> **DEVICE-REQUIRED / SCAFFOLD-LEVEL.** This package cannot be compiled or run
> in the offline build sandbox: it needs the Android SDK + NDK and a physical
> device with Bluetooth and Wi-Fi. What is provided here is a complete,
> correctly-wired scaffold — manifest, foreground service, native module
> contracts, gradle flavors, and the RN UI — with the device-only radio loops
> marked `TODO(device)`. The protocol brain it drives (`@adaptivemesh/core`) is
> 100% pure TypeScript and is fully unit-tested and benchmarked offline.

## Why the split matters

All routing, crypto (Ed25519 / X25519 / AEAD / Double Ratchet), dedup, replay
protection, congestion control, and chunk reassembly live in `@adaptivemesh/core`.
The native modules are **dumb frame pipes**. This is the same design that lets
the deterministic simulator (`tools/sim`) exercise byte-for-byte the same engine
logic that runs on the phone.

| Layer                            | Where                          | Tested offline?         |
| -------------------------------- | ------------------------------ | ----------------------- |
| Protocol engine, crypto, routing | `packages/core` (pure TS)      | ✅ 25/25 unit tests     |
| Multi-hop network behavior       | `tools/sim`                    | ✅ 5/5 + benchmark      |
| Zero-knowledge relay             | `services/relay`               | ✅ 7/7 tests            |
| BLE / Nearby / SMS radios        | `apps/mobile/android` (Kotlin) | ❌ device-only scaffold |

## The foreground-service crash fix

The MeshGuard reference app crashed on launch (API 34+):

```
java.lang.SecurityException: Starting FGS with type connectedDevice ...
requires permission FOREGROUND_SERVICE_CONNECTED_DEVICE
```

`MeshForegroundService.kt` fixes it with four coordinated changes — see the
class header and `AndroidManifest.xml` comments. Summary:

1. Manifest declares `FOREGROUND_SERVICE` **and** `FOREGROUND_SERVICE_CONNECTED_DEVICE`.
2. `<service android:foregroundServiceType="connectedDevice">`.
3. `ServiceCompat.startForeground(..., FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)`.
4. BLE runtime permissions are verified **before** `startForeground()`; if not
   granted the service stops itself cleanly instead of crashing.

## Dual-track SMS (last resort, never mesh-routed)

- **play** flavor: `smsto:` composer intent, no `SEND_SMS` permission.
- **sideload** flavor: real `SmsManager` direct send (`SEND_SMS` lives only in
  `src/sideload/AndroidManifest.xml`).

Controlled by `BuildConfig.ALLOW_DIRECT_SMS` (see `app/build.gradle`).

## Running on a device (once SDK is available)

```bash
npm install
npm run android        # play flavor by default
```
