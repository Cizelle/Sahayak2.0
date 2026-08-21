# Threat model

## Assets

- **Message confidentiality** — plaintext content of messages.
- **Message integrity / authenticity** — messages are from who they claim.
- **Availability** — ability to deliver, especially SOS, under adverse networks.
- **Metadata minimization** — limiting what relays/observers learn about who
  talks to whom.

## Adversaries

1. **Passive network observer** (Wi-Fi/BLE sniffer, relay operator). Sees frames
   on the air or at the relay.
2. **Active on-path attacker** — can drop, replay, reorder, inject, or modify
   frames.
3. **Malicious relay** — honest-but-curious or actively malicious server.
4. **Compromised peer** — a node whose long-term key is later stolen.
5. **Resource-exhaustion attacker** — floods the mesh or relay to deny service.

## Guarantees and how they are achieved

| Threat                          | Mitigation                                                                                    | Verified by                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Read message content            | AEAD payload encryption (AES-256-GCM / ChaCha20-Poly1305); relay stores opaque blobs          | relay zero-knowledge test; ratchet tests      |
| Forge / tamper with messages    | Ed25519 signature over canonical header; AEAD tag; header bound as ratchet AAD                | ratchet AAD + tamper tests                    |
| Replay old frames               | `(src, id)` LRU dedup + TTL; relay nonce + timestamp-skew window                              | router dedup tests; relay replay test         |
| Key theft → decrypt past/future | Double Ratchet forward secrecy + post-compromise security                                     | ratchet in/out-of-order + DH-ratchet tests    |
| Impersonation                   | Node id = hash(signing pubkey); TOFU with key-change warnings                                 | identity derivation; relay `bad-node-id` test |
| Mesh/relay flooding (DoS)       | Congestion FSM (RED = SOS/control only); per-dst quota; token-bucket rate limit; payload caps | relay abuse test; congestion tests            |
| Clock skew abuse                | Bounded skew window on relay auth                                                             | relay stale-auth test                         |

## Explicit non-goals (honesty)

- **We do not hide that two node ids communicated via the relay.** A relay
  necessarily sees source-authenticated submissions and destination addressing.
  We minimize, not eliminate, metadata. Full traffic-analysis resistance (cover
  traffic, mixnets) is out of scope for this prototype — see `ROADMAP.md`.
- **SMS SOS is not confidential.** It traverses the carrier in cleartext by
  definition. It is a deliberate last-resort beacon, point-to-point to a known
  contact, never used for routed mesh traffic.
- **BLE/Wi-Fi physical-layer presence is observable.** Radio fingerprinting and
  jamming resistance are out of scope.
- **No Sybil resistance beyond TOFU.** An attacker can mint identities; rate
  limits and quotas bound the damage, but reputation/PoW is future work.

## Why these choices

The design optimizes for the realistic disaster/blackout scenario: infrastructure
is down, devices are heterogeneous, and the priority is getting an authenticated,
confidential message (especially an SOS) to its destination with bounded
resource use — not perfect anonymity. We state the limits plainly rather than
overclaim.
