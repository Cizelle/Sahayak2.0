package com.adaptivemesh

import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * De-Googled (sideload flavor) no-op Nearby transport.
 *
 * The sideload build deliberately omits Google Play Services, so Nearby
 * Connections is unavailable here. This stub keeps the JS NativeModules surface
 * identical across flavors; on this build the BLE GATT transport carries the
 * offline mesh instead. Every method resolves without doing radio work and the
 * module never emits meshFrame/meshNeighbor, so the JS NativeRadioTransport for
 * the Wi-Fi tier simply reports zero neighbors (the "Wi-Fi" mode shows as
 * unavailable in this build).
 */
class NearbyTransportModule(reactContext: ReactApplicationContext) :
	ReactContextBaseJavaModule(reactContext) {

	override fun getName(): String = "NearbyTransport"

	@ReactMethod
	fun startAdvertising(serviceId: String, promise: Promise) {
		promise.resolve(null)
	}

	@ReactMethod
	fun startDiscovery(serviceId: String, promise: Promise) {
		promise.resolve(null)
	}

	@ReactMethod
	fun sendFrame(peerId: String, base64Frame: String, promise: Promise) {
		promise.resolve(null)
	}

	@ReactMethod
	fun stop(promise: Promise) {
		promise.resolve(null)
	}
}
