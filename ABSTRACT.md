# AdaptiveMesh: A Tiered Communication Protocol for Resilient Mobile Connectivity

**Abstract.** Mobile connectivity fails precisely when it is needed most —
during disasters, blackouts, protests, and in infrastructure-poor regions. We
present AdaptiveMesh, an offline-first messaging protocol that degrades
gracefully across four transport tiers (Internet, Wi-Fi, Bluetooth Low Energy,
and SMS) while preserving end-to-end confidentiality, authenticity, and forward
secrecy. Messages are carried in signed, length-prefixed binary envelopes whose
payloads are AEAD-encrypted and whose pairwise sessions use a Double Ratchet,
providing forward and post-compromise security over lossy, high-latency links.
Multi-hop delivery uses managed (controlled) flooding with randomized
contention, single rebroadcast, neighbor suppression, and direct-route
preference; duplicate and replay attacks are bounded by a TTL-keyed LRU, and
overload is handled by a four-state congestion controller that reserves capacity
for emergency traffic. To heal network partitions, a zero-knowledge relay buffers
opaque ciphertext blobs addressed by self-certifying node identifiers, enforcing
per-destination quotas, rate limits, and emergency prioritization without ever
holding keys. Crucially, SMS is treated as an honest point-to-point last resort
rather than a faked mesh hop.

Our central methodological contribution is that the entire protocol — routing,
cryptography, congestion control, and reassembly — is implemented as a portable,
dependency-injected, pure-TypeScript core. The same code that runs on the device
is exercised by a deterministic, seed-reproducible network simulator, making our
evaluation bit-for-bit replicable. Across line, dense-cluster, lossy-random, and
partition-healing topologies the protocol achieves 0.95–1.00 delivery ratios and,
in a 16-node dense cluster, delivers via a single air transmission —
empirically demonstrating that flood suppression and direct-route preference
work as designed. We provide a complete Android client scaffold (React Native +
Kotlin) including a corrected connectedDevice foreground service, and we state
explicitly which components are tested in software versus requiring device
validation.
