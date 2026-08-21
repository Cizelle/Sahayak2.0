/**
 * Shared mesh wiring constants for the on-device runtime. These mirror the
 * companion-object constants in the Kotlin transports so JS and native agree on
 * the discovery identifiers.
 */

/** Must equal NearbyTransportModule.SERVICE_ID. */
export const NEARBY_SERVICE_ID = "com.adaptivemesh.nearby";

/** Must equal BleTransportModule.SERVICE_UUID. */
export const BLE_SERVICE_UUID = "6d657368-0001-4a6d-9a3a-000000000001";

/**
 * Internet-tier relay base URL (the @adaptivemesh/relay server). When set, the
 * app runs a real RelayTransport: it registers, polls a roster to DISCOVER
 * other online nodes, and relays encrypted frames through the server. This is
 * the tier that makes peers appear immediately over the internet (the honest
 * fix for "always waiting for peer") and is exercised end-to-end by
 * services/relay/test/relayTransport.test.ts.
 *
 * Leave EMPTY to ship a pure offline build: the Internet mode then reports
 * "not configured" instead of pretending to work. Point it at your deployed
 * relay (e.g. "https://relay.example.com") or, for a LAN demo, the dev server
 * printed by `npm run -w @adaptivemesh/relay dev` (e.g. "http://192.168.1.42:8787").
 */
export const RELAY_URL = "";
