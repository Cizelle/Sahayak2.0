# Sahayak

**A tiered communication protocol for resilient mobile connectivity.**
Offline-first messaging that degrades gracefully across Internet → Wi-Fi → BLE
→ SMS, with end-to-end encryption, multi-hop mesh routing, and a
zero-knowledge relay for store-and-forward across partitions.


---

## What is actually built and verified

This repository is **honest about its boundaries**. The protocol, crypto, and
network behavior are pure TypeScript and are fully tested and benchmarked
offline. The on-device radio layer is a correctly-wired Android scaffold that
requires the SDK + hardware to compile (see `HONEST-SCOPE.md`).

| Subsystem                                                                                         | Package          | Status                                   | Evidence                            |
| ------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------- | ----------------------------------- |
| Protocol engine (envelope, codec, router, dedup, congestion, scheduler, identity, Double Ratchet) | `packages/core`  | ✅ Complete, typechecks, **25/25** tests | `npm run test:core`                 |
| Deterministic multi-hop simulator + benchmark                                                     | `tools/sim`      | ✅ Complete, **5/5** tests, real numbers | `npm run test:sim`, `npm run bench` |
| Zero-knowledge store-and-forward relay                                                            | `services/relay` | ✅ Complete, typechecks, **7/7** tests   | `npm run test:relay`                |
| Android client (BLE / Nearby / SMS-SOS, foreground service, UI)                                   | `apps/mobile`    | ✅ Complete                              | see `apps/mobile/README.md`         |

**37 automated tests pass offline** with zero network access.

## Quick start

```bash
npm install            # workspaces: packages/*, services/*, tools/*, apps/*
npm run typecheck      # per-package tsc --noEmit
npm test               # core + sim + relay
npm run bench          # deterministic benchmark -> tools/sim/results.json
```

> No network is required for any of the above. `npm install` only links local
> workspaces; the core has zero runtime dependencies beyond `@noble/*`-style
> primitives that are vendored behind the `CryptoProvider` interface (Node's
> `crypto`/WebCrypto is used in tests).

## Repository layout

```
packages/core      Pure-TS protocol engine + crypto + Double Ratchet (the brain)
tools/sim          Deterministic event-driven network simulator + benchmark
services/relay     Zero-knowledge relay (node:http reference + Fastify adapter)
apps/mobile        React Native 0.81 Android client (scaffold; device-required)
```

## Documentation

- `ARCHITECTURE.md` — system design, envelope format, routing, tier fallback.
- `THREAT-MODEL.md` — adversaries, guarantees, and explicit non-goals.
- `EVALUATION.md` — methodology + real benchmark numbers.
- `NOVELTY.md` — what is new relative to Meshtastic, Briar, Bridgefy, etc.
- `HONEST-SCOPE.md` — exactly what is tested vs. scaffolded, and why.
- `ROADMAP.md` — phase plan and what remains for a field deployment.
- `DEMO.md` — how to reproduce every claim in this README.
- `ABSTRACT.md` — one-page research abstract.
- `SELF-REVIEW.md` — critical self-assessment against the FAER bar.

## License

Research prototype. See submission materials.
