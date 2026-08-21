# Demo & reproduction

Every claim in `README.md` and `EVALUATION.md` is reproducible offline with
Node ≥ 22. No network access is required.

## 0. Prerequisites

```bash
node --version   # expect v22+ (developed/verified on v24)
npm install      # links local workspaces only
```

## 1. Typecheck every TS package

```bash
cd packages/core   && npx tsc -p tsconfig.json --noEmit && cd -
cd tools/sim       && npx tsc -p tsconfig.json --noEmit && cd -
cd services/relay  && npx tsc -p tsconfig.json --noEmit && cd -
```

## 2. Run all test suites (37 tests)

```bash
# Core engine + crypto + Double Ratchet (25 tests)
cd packages/core && node --import tsx --test "src/**/*.test.ts" "test/**/*.test.ts" && cd -

# Deterministic simulator (5 tests)
cd tools/sim && node --import tsx --test "test/**/*.test.ts" && cd -

# Zero-knowledge relay (7 tests)
cd services/relay && node --import tsx --test "test/**/*.test.ts" && cd -
```

Or from the repo root:

```bash
npm test
```

## 3. Reproduce the benchmark numbers

```bash
npm run bench          # writes tools/sim/results.json
cat tools/sim/results.json
```

The four scenarios (line/7-hop, dense-cluster, lossy-random, partition-heal)
and their metrics are documented in `EVALUATION.md`.

## 4. Inspect the zero-knowledge property

The relay test suite includes a test that:

- submits an encrypted blob, pulls it back, and asserts byte-for-byte equality;
- serializes the relay's internal state and asserts it contains no key material.

```bash
cd services/relay && node --import tsx --test "test/**/*.test.ts"
```

## 5. The mobile app (device-required)

The Android client cannot build in this environment (needs the Android SDK + a
physical device). Its structure, the foreground-service crash fix, and the dual
SMS flavors are documented in `apps/mobile/README.md`. On a configured machine:

```bash
cd apps/mobile && npm install && npm run android
```

## Two-minute live narrative (for reviewers)

1. `npm test` — show 37 green tests including Double Ratchet out-of-order.
2. `npm run bench` — show the 16-node dense cluster delivering in **1** air tx.
3. Open `apps/mobile/android/.../MeshForegroundService.kt` — walk through the
   four-part connectedDevice FGS fix that resolves the MeshGuard crash.
4. Open `services/relay/src/relayCore.ts` — show that the store holds only blobs.
