package com.adaptivemesh

import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsClient
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import java.util.Collections
import java.util.UUID

/**
 * REAL offline transport (play flavor): Google Nearby Connections in
 * P2P_CLUSTER strategy. Nearby opportunistically uses Wi-Fi Direct / Wi-Fi
 * hotspot for throughput and BLE for discovery + low-bandwidth links, with no
 * internet or access point required. This is the "Wi-Fi" tier surfaced in the
 * app.
 *
 * This module is a dumb, opaque frame pipe: the pure-TS @adaptivemesh/core
 * engine owns all routing, crypto, dedup and congestion. We only advertise,
 * discover, accept connections, and move raw bytes one hop, emitting
 * meshNeighbor (up/down) and meshFrame (inbound bytes) to JS.
 *
 * The de-Googled "sideload" flavor ships a no-op version of this class (it has
 * no Play Services); that build relies on the BLE GATT transport instead.
 */
class NearbyTransportModule(private val reactContext: ReactApplicationContext) :
	ReactContextBaseJavaModule(reactContext) {

	override fun getName(): String = "NearbyTransport"

	private val client: ConnectionsClient = Nearby.getConnectionsClient(reactContext)
	/** Random per-launch advertised name; used only for the connect tie-break. */
	private val localName: String = UUID.randomUUID().toString()
	private val connected = Collections.synchronizedSet(HashSet<String>())

	companion object {
		const val SERVICE_ID = "com.adaptivemesh.nearby"
		private val STRATEGY = Strategy.P2P_CLUSTER
	}

	@ReactMethod
	fun startAdvertising(serviceId: String, promise: Promise) {
		val options = AdvertisingOptions.Builder().setStrategy(STRATEGY).build()
		client.startAdvertising(localName, serviceId, lifecycleCallback, options)
			.addOnSuccessListener { promise.resolve(null) }
			.addOnFailureListener { e -> promise.reject("advertise_failed", e) }
	}

	@ReactMethod
	fun startDiscovery(serviceId: String, promise: Promise) {
		val options = DiscoveryOptions.Builder().setStrategy(STRATEGY).build()
		client.startDiscovery(serviceId, discoveryCallback, options)
			.addOnSuccessListener { promise.resolve(null) }
			.addOnFailureListener { e -> promise.reject("discovery_failed", e) }
	}

	@ReactMethod
	fun sendFrame(peerId: String, base64Frame: String, promise: Promise) {
		try {
			val bytes = Base64.decode(base64Frame, Base64.NO_WRAP)
			val payload = Payload.fromBytes(bytes)
			if (peerId == "*") {
				val targets = synchronized(connected) { connected.toList() }
				if (targets.isNotEmpty()) {
					client.sendPayload(targets, payload)
				}
			} else {
				client.sendPayload(peerId, payload)
			}
			promise.resolve(null)
		} catch (e: Exception) {
			promise.reject("send_failed", e)
		}
	}

	@ReactMethod
	fun stop(promise: Promise) {
		client.stopAdvertising()
		client.stopDiscovery()
		client.stopAllEndpoints()
		synchronized(connected) { connected.clear() }
		promise.resolve(null)
	}

	private val discoveryCallback = object : EndpointDiscoveryCallback() {
		override fun onEndpointFound(endpointId: String, info: DiscoveredEndpointInfo) {
			// Both peers advertise AND discover; only the lexicographically smaller
			// name initiates so the two sides don't request each other and collide.
			if (localName < info.endpointName) {
				client.requestConnection(localName, endpointId, lifecycleCallback)
			}
		}

		override fun onEndpointLost(endpointId: String) {
			// Connection teardown is reported via onDisconnected.
		}
	}

	private val lifecycleCallback = object : ConnectionLifecycleCallback() {
		override fun onConnectionInitiated(endpointId: String, info: ConnectionInfo) {
			client.acceptConnection(endpointId, payloadCallback)
		}

		override fun onConnectionResult(endpointId: String, resolution: ConnectionResolution) {
			if (resolution.status.statusCode == ConnectionsStatusCodes.STATUS_OK) {
				synchronized(connected) { connected.add(endpointId) }
				emitNeighbor(endpointId, true)
			}
		}

		override fun onDisconnected(endpointId: String) {
			synchronized(connected) { connected.remove(endpointId) }
			emitNeighbor(endpointId, false)
		}
	}

	private val payloadCallback = object : PayloadCallback() {
		override fun onPayloadReceived(endpointId: String, payload: Payload) {
			val bytes = payload.asBytes() ?: return
			val b64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
			emitFrame(endpointId, b64)
		}

		override fun onPayloadTransferUpdate(endpointId: String, update: PayloadTransferUpdate) {
			// BYTES payloads arrive whole in onPayloadReceived; nothing to track.
		}
	}

	private fun emitFrame(peerId: String, base64Frame: String) {
		val map = Arguments.createMap()
		map.putString("peerId", peerId)
		map.putString("base64Frame", base64Frame)
		map.putString("tier", "wifi")
		reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
			.emit("meshFrame", map)
	}

	private fun emitNeighbor(peerId: String, up: Boolean) {
		val map = Arguments.createMap()
		map.putString("peerId", peerId)
		map.putString("tier", "wifi")
		map.putBoolean("up", up)
		reactContext.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
			.emit("meshNeighbor", map)
	}
}
