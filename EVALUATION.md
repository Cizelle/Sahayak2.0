# Evaluation

All numbers below are produced by the deterministic simulator
(`tools/sim`) with a fixed seed and written to `tools/sim/results.json`.
Reproduce with:

```bash
npm run bench
```

## Methodology

- **Deterministic event-driven simulator.** A virtual `SimClock` orders all
  radio events; there is no wall-clock dependence, so runs are bit-reproducible.
- **Same engine as production.** The simulator drives the exact
  `@adaptivemesh/core` engine used on-device via a `SimulatedTransport` that
  implements the same `Transport` interface as the native radios. There is no
  separate "sim-only" protocol implementation.
- **Metrics.** Delivery ratio (delivered / intended), air transmissions per
  delivered message (overhead), and end-to-end latency (mean and p95) in
  simulated milliseconds.
- Link latency and loss are injected per-scenario; multi-hop scenarios pass an
  explicit `hopLimit` because the default limit (3) is intentionally
  conservative.

## Results

| Scenario                    | Topology               | Delivered | Ratio | Air tx / delivery | Latency mean | p95    |
| --------------------------- | ---------------------- | --------- | ----- | ----------------- | ------------ | ------ |
| Line, 7 hops, 0% loss       | 8-node line            | 8 / 8     | 1.00  | 8.75              | 446.9 ms     | 568 ms |
| Dense cluster, direct-route | 16-node clique         | 1 / 1     | 1.00  | **1.00**          | 10 ms        | —      |
| Lossy random graph          | 20-node, 15% link loss | 19 / 20   | 0.95  | 20.42             | 78.2 ms      | 162 ms |
| Partition heal              | 2 islands → bridged    | 3 / 3     | 1.00  | 9.33              | 341.3 ms     | 371 ms |

## What the numbers show

- **Multi-hop correctness.** The 8-node line delivers across all 7 hops with
  100% ratio, confirming hop-limited forwarding and reassembly work end to end.
- **Flood suppression actually works.** In the 16-node dense cluster, a message
  to a directly-reachable peer costs a **single air transmission** — the engine
  prefers the direct route instead of flooding all 15 neighbors. This is the
  core efficiency claim, demonstrated rather than asserted.
- **Graceful degradation under loss.** With 15% link loss on a 20-node random
  graph, delivery stays at 0.95 with bounded overhead, showing the
  rebroadcast/backoff logic recovers most drops without storming.
- **Partition healing.** When two disconnected islands are bridged, queued
  messages flow across and reach 100% delivery via store-and-forward + anti-
  entropy.

## Honest caveats

- These are **simulated** link models, not field RF measurements. Real BLE/Wi-Fi
  throughput, MTU negotiation, and connection churn will change absolute
  latencies. The simulator validates _protocol logic and relative behavior_, not
  RF performance.
- Latencies are in simulated time derived from injected per-link delays.
- The native radio layer is not exercised here (it is device-only); see
  `HONEST-SCOPE.md`.
