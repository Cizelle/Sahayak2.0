export * from "./provider.ts";
// NodeCryptoProvider is deliberately NOT re-exported from this barrel: it imports
// `node:crypto`, which the React Native (Metro) bundler cannot resolve on-device.
// Keeping the core barrel platform-free lets `@adaptivemesh/core` bundle cleanly in
// the mobile app, which supplies its own RnQuickCryptoProvider. Node-only consumers
// (unit tests, the simulator, the relay) import NodeCryptoProvider directly from
// "./crypto/nodeProvider.ts".
