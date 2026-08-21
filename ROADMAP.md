# Roadmap

Phase status reflects what is in this repository.

## Phase 0 — Monorepo, CI, scaffold ✅

- Workspaces (`packages/*`, `services/*`, `tools/*`, `apps/*`), shared
  `tsconfig.base.json`, Prettier/ESLint, GitHub Actions CI.

## Phase 1 — Core engine + simulator + tests ✅

- Envelope codec, router (managed flooding), dedup/replay, congestion FSM,
  scheduler, identity, persistence, crypto provider abstraction.
- `SimulatedTransport`; 25 core tests; deterministic sim.

## Phase 2 — BLE + foreground service 🟡 scaffold (device-required)

- Kotlin `BleTransportModule` (GATT advertise/scan/notify), corrected
  `MeshForegroundService` (connectedDevice FGS crash fix).
- Remaining: implement the GATT read/write/notify + MTU loops on hardware.

## Phase 3 — Nearby/Wi-Fi + relay 🟡/✅

- ✅ Zero-knowledge relay (`node:http` reference + Fastify/Postgres adapter), 7
  tests.
- 🟡 `NearbyTransportModule` scaffold; remaining: Play Services Nearby wiring.

## Phase 4 — SMS-SOS dual-track + Double Ratchet + metadata minimization 🟡/✅

- ✅ Double Ratchet sessions (6 tests).
- ✅ Dual SMS flavors (play `smsto:` / sideload `SmsManager`).
- 🟡 Direct-send permission flow + location attachment on device.

## Phase 5 — Hardening + animations 🟡

- RN UI (Chat/Peers/SOS) with Reanimated/Moti present.
- Remaining: Skia radar from live HELLO beacons, Lottie SOS, fuzzing the codec,
  battery/airtime profiling on devices.

## Beyond the prototype (research extensions)

- Traffic-analysis resistance: cover traffic / mixnet-style relay batching.
- Sybil/abuse resistance beyond TOFU: rate-proofs or web-of-trust.
- iOS companion (degraded: BLE background constraints).
- Field trials with real RF measurements to validate the simulator's models.
- Formal verification of the envelope/handshake state machine.
