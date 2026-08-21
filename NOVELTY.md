# Novelty

AdaptiveMesh is not the first mesh messenger. Its contribution is a specific,
honestly-scoped combination that, to our knowledge, no single existing system
provides together, plus an engineering methodology that makes the protocol
fully reproducible.

## Relative to prior work

| System             | Multi-tier fallback        | E2E forward secrecy      | Zero-knowledge relay | Pure-portable, sim-verifiable core | Honest SMS handling           |
| ------------------ | -------------------------- | ------------------------ | -------------------- | ---------------------------------- | ----------------------------- |
| Meshtastic         | LoRa-only                  | Limited                  | No                   | Firmware-coupled                   | n/a                           |
| Briar              | Tor / BLE / Wi-Fi          | Yes (Bramble)            | No (uses Tor)        | Coupled to Android/JVM             | No SMS                        |
| Bridgefy           | BLE/Wi-Fi                  | Historically weak        | No                   | Closed                             | No                            |
| FireChat (defunct) | BLE/Wi-Fi                  | No                       | No                   | Closed                             | No                            |
| **AdaptiveMesh**   | **Internet/Wi-Fi/BLE/SMS** | **Yes (Double Ratchet)** | **Yes**              | **Yes**                            | **Yes, explicit last-resort** |

## The four contributions

1. **Capability-ordered tier fallback with an honest SMS last resort.** Most
   mesh apps pick one or two transports. AdaptiveMesh degrades across four,
   and — critically — refuses to fake mesh-over-SMS. SMS is a human-confirmed,
   point-to-point SOS beacon. This honesty is a design feature: it avoids
   silently destroying the user's SMS quota and avoids implying delivery
   guarantees the carrier cannot provide.

2. **A zero-knowledge store-and-forward relay for partition healing.** Unlike
   pure peer meshes that lose messages across disconnected islands, a relay (when
   any node has Internet) buffers opaque ciphertext blobs addressed by node id,
   with quotas/rate-limits/SOS-priority, while learning nothing it can decrypt.

3. **A protocol core that is 100% portable and deterministically simulatable.**
   Because routing, crypto, congestion, and reassembly are pure TypeScript with
   an injected `CryptoProvider` and `Transport`, the _same_ code that runs on the
   phone is exercised by a deterministic simulator. Benchmark claims are
   reproducible bit-for-bit — a rarity for mobile mesh research, where results
   are usually device-bound and hard to replicate.

4. **Managed flooding with demonstrated direct-route preference.** The 16-node
   benchmark shows a single air transmission when a direct route exists, proving
   the suppression logic empirically rather than by assertion.

## What is explicitly _not_ claimed as novel

- The Double Ratchet (Signal), managed flooding (Meshtastic), and TOFU (SSH) are
  established techniques. We integrate and harden them; we do not claim to have
  invented them.
- We do not claim anonymity or traffic-analysis resistance (see `THREAT-MODEL.md`).
