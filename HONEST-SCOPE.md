# Honest scope: what is tested vs. scaffolded

This document exists because the project's stated bar is "research-grade,
production-quality, ~0-flaw, no fake logic." Honesty about boundaries is part of
meeting that bar.

## Fully implemented, typechecked, and tested offline (37 tests)

- **`packages/core` — the entire protocol brain.** Envelope encode/decode,
  ULID generation, managed-flooding router, dedup/replay LRU, congestion FSM,
  contention scheduler, virtual clock, identity (Ed25519/X25519 derivation,
  TOFU), persistence interface, and the **Double Ratchet** session layer. Crypto
  is real (`@noble`-style primitives behind a `CryptoProvider`, with Node's
  WebCrypto/`crypto` in tests). 25 tests, typechecks clean under strict TS
  (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, etc.).
- **`tools/sim` — deterministic network simulator + benchmark.** Drives the real
  engine over a `SimulatedTransport`. 5 tests; `bench` emits real numbers to
  `results.json`.
- **`services/relay` — zero-knowledge relay.** `node:http` reference server,
  TOFU registration, signed/nonce'd/skew-bounded auth, quotas, token-bucket rate
  limiting, SOS prioritization, idempotent ack. 7 tests including a
  zero-knowledge assertion and an end-to-end HTTP test via `fetch`.

## Real but scaffold-level (device-required, NOT compiled here)

- **`apps/mobile` Android native (Kotlin).** The structure, permissions,
  gradle flavors, native-module contracts, and the **foreground-service crash
  fix** are real and correct. The actual radio loops — BLE GATT read/write/notify
  and MTU negotiation, Nearby Connections advertise/discover/payload, the runtime
  permission flow — are marked `TODO(device)` because they cannot be compiled or
  exercised without the Android SDK/NDK and physical Bluetooth/Wi-Fi hardware.
- **`apps/mobile` React Native UI.** Chat/Peers/SOS screens render and animate;
  in this environment the native modules are absent, so the app runs in a
  "preview" mode with mock peers. Binding the UI to live engine state happens on
  a real build.
- **`services/relay/src/server.ts`** (Fastify + Postgres production adapter) is
  written and documented but `@ts-nocheck`'d and excluded from typecheck because
  `fastify`/`pg` cannot be installed offline. The tested reference server
  (`serverHttp.ts`) implements the same protocol with zero dependencies.

## Things we deliberately did NOT do

- We did **not** fake mesh-over-SMS. SMS is point-to-point SOS only.
- We did **not** stub crypto with no-ops or claim untested code as tested.
- We did **not** claim RF/field performance from software simulation.
- We did **not** ship one-shot placeholder routing; the router is the real
  algorithm exercised by the benchmark.

## One-line honest summary

The protocol and its guarantees are genuinely implemented and reproducibly
tested in software; the phone's radio drivers are a correct scaffold that needs
a device to come alive.

## Update — device automation layer (orchestration, gate, crypto adapter)

The app is now wired for the intended **"set up once, then automatic"** model
instead of running in passive preview. What changed and where the honest line
still sits:

**Now implemented (JS side fully written; runs the moment the native build is
present):**

- **Blocking readiness gate** (`src/ui/ReadinessGate.tsx`, `src/native/permissions.ts`,
  `src/native/system.ts` + `MeshSystemModule.kt`). On launch it demands every
  runtime permission, then prompts to turn **Bluetooth** and **Location/GPS** ON,
  re-checks, deep-links to App Settings on permanent denial, and **refuses to
  render the app until everything is granted and on.** This is the honest,
  Play-compliant equivalent of "force everything on" — see the next bullet.
- **Auto-orchestration** (`src/mesh/MeshController.ts` + `MeshContext`/`useMesh`).
  After the gate passes, the controller auto-starts the foreground service,
  generates an identity, builds the engine, and auto-advertises + auto-scans on
  **both** radios. Discovery → HELLO handshake → TOFU key-pin → auto-connect →
  auto-relay/store-and-forward all happen with **no user action**. The only
  manual surfaces are composing a message, picking a target peer, and pressing
  SOS — exactly as requested.
- **Real RN CryptoProvider** (`src/native/rnCrypto.ts`). A
  `react-native-quick-crypto` adapter that mirrors `NodeCryptoProvider`
  byte-for-byte, so the device runs the identical, test-pinned crypto/wire
  format. Marked VALIDATE-ON-DEVICE (run the core vectors on first bring-up).
- **Complete combined Transport** (`src/native/rnTransport.ts`) implementing the
  same `Transport` contract as the simulator: real length-prefixed codec on send,
  real `FrameReader` reassembly on receive, Wi-Fi(Nearby)→BLE fallback, and
  neighbor tracking from native `meshNeighbor` events.
- **Core introspection** (`MeshEngine.knownContacts()` / `reachableNodes()`) so
  the UI can list addressable peers. Core remains **37/37 green**.

**HONEST LIMITS — what "force" cannot mean on Android, and what is still device-only:**

- Android **does not allow any app to silently grant permissions or switch on
  GPS/Bluetooth.** The OS always shows its own dialog and the user must tap.
  Bypassing this is grounds for Play removal. The readiness gate is therefore the
  strongest possible "forced" UX: nothing works until the user enables everything.
- The Kotlin **radio loops are still `TODO(device)`** — BLE GATT advertise/scan/
  connect/notify + MTU, and Nearby advertise/discover/payload. They must call the
  now-present `emitFrame(peerId, base64)` and `emitNeighbor(peerId, up)` helpers
  on real radio events; until that native code runs on hardware, no real peers
  appear. This cannot be compiled or tested in the offline sandbox (no Android
  SDK/NDK/hardware).
- **Identity is ephemeral per launch.** Persisting the seed in secure storage
  (stable node id + pinned contacts across restarts) is marked `TODO(device)`.
- **Mesh SOS is E2E-sealed per recipient**, so it needs ≥1 discovered peer; with
  none in range the SOS button falls back to a plain cellular SMS (not
  mesh-routed) as the honest last resort.
