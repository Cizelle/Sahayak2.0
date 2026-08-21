# Self-review against the FAER bar

A candid critique of this submission — strengths, weaknesses, and what a reviewer
should push on.

## Where it is strong

- **Reproducibility.** The pure-TS, dependency-injected core driven by a
  deterministic simulator is genuinely unusual for mobile mesh work and makes
  every benchmark claim replicable. This is the strongest part of the
  submission.
- **Security depth.** Real Double Ratchet with forward + post-compromise
  security, signed self-certifying identities, replay/skew protection, and a
  relay that provably cannot read content. Tests target the adversarial cases
  (tamper, replay, out-of-order, abuse), not just the happy path.
- **Honesty as a feature.** The SMS-as-last-resort decision and the explicit
  tested-vs-scaffolded boundary make the work trustworthy rather than
  over-claimed.
- **Demonstrated, not asserted, efficiency.** The single-air-transmission result
  in the dense cluster is concrete evidence the flood-suppression works.

## Where it is weak (and honestly so)

- **No on-device RF validation.** The biggest gap. Simulated link models are not
  field measurements; BLE connection churn, real MTUs, and battery cost are
  unverified. The native layer is a scaffold. A reviewer should weight this
  heavily.
- **Metadata privacy is partial.** The relay sees src/dst node ids and timing.
  No cover traffic or mixing. We disclose this; we do not solve it.
- **TOFU only.** No Sybil resistance beyond rate/quota limits.
- **Single simulator author of truth.** Because the sim and the device share the
  engine, a bug in the engine would pass tests and also ship to the device. The
  mitigation is adversarial unit tests and (future) field trials, not a second
  independent implementation.
- **iOS absent.** Android-first; iOS background BLE constraints are non-trivial.

## Questions I would expect from reviewers

1. "Your latencies are simulated — what happens on real BLE?" — Fair; that is the
   Phase 2/5 device work. The protocol logic, not RF numbers, is what we
   validate here.
2. "Is the relay really zero-knowledge?" — It cannot read payloads (no keys), but
   it observes routing metadata. We claim content-blindness, not anonymity.
3. "How is this different from Briar?" — Four-tier fallback incl. honest SMS, a
   content-blind relay for partition healing, and a fully simulatable core. See
   `NOVELTY.md`.

## Verdict

A credible, honest research prototype with a reproducible protocol contribution
and a clearly-scoped path to field validation. It does not claim to be a
finished product, and it should not be evaluated as one.

## Update — automation layer added

The device app now implements the intended "configure once, then automatic"
behavior: a **blocking readiness gate** forces all permissions + Bluetooth +
Location on (the honest Android-compliant maximum — silent enabling is
impossible and Play-prohibited), after which a single **MeshController** runs the
engine and auto-advertises/scans/handshakes/connects/relays with no user action.
Manual surfaces are intentionally limited to compose, target-select, and SOS. A
real `react-native-quick-crypto` provider and a complete combined Transport
(real codec + `FrameReader`, Wi-Fi→BLE fallback, neighbor events) are wired so
the device runs the same test-pinned logic as the simulator.

The weakness ranking is unchanged and, if anything, sharper: the JS orchestration
is complete, but the **Kotlin radio loops remain `TODO(device)`**, so on-device
behavior is still unproven on real RF. A reviewer should read the automation as
"correctly architected and fully wired up to the native boundary," not "validated
on hardware." The crypto adapter is also marked VALIDATE-ON-DEVICE pending a run
of the core vectors under quick-crypto.
