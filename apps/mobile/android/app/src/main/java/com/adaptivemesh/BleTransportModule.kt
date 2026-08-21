package com.adaptivemesh

import android.annotation.SuppressLint
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.BluetoothLeAdvertiser
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.ParcelUuid
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * De-Googled, first-class BLE GATT mesh transport — REAL implementation.
 *
 * Every device plays BOTH roles simultaneously so the mesh is symmetric:
 *   - PERIPHERAL: advertises SERVICE_UUID and hosts a GATT server with one
 *     write+notify characteristic. Centrals write inbound frames to it and
 *     subscribe for outbound notifications.
 *   - CENTRAL: scans for SERVICE_UUID, connects, negotiates a large MTU,
 *     enables notifications, and writes outbound frames.
 *
 * It moves OPAQUE length-prefixed binary frames one hop between adjacent
 * devices. It does NOT understand the protocol — routing, crypto, dedup and
 * congestion all live in the pure-TS @adaptivemesh/core engine, exactly as in
 * the simulator. peerId is the remote BLE address (a link handle); real node
 * identity is established by HELLO frames inside the payload.
 *
 * FRAMING: each logical frame is written as [4-byte big-endian length][bytes],
 * then split into <=(mtu-3)-byte BLE packets. The receiver accumulates bytes
 * per link and re-slices complete frames from the length prefix. A per-link
 * outbound queue serializes writes/notifications (BLE allows one in flight).
 *
 * DEVICE-VALIDATION-PENDING: this compiles against the Android BLE APIs but
 * cannot be exercised in the SDK-less build sandbox; it requires on-device
 * (two-phone) validation. Permissions are gated up front by ReadinessGate, so
 * the @SuppressLint("MissingPermission") annotations are safe here.
 */
@SuppressLint("MissingPermission")
class BleTransportModule(private val reactContext: ReactApplicationContext) :
	ReactContextBaseJavaModule(reactContext) {

	override fun getName(): String = "BleTransport"

	companion object {
		const val SERVICE_UUID = "6d657368-0001-4a6d-9a3a-000000000001"
		const val TX_CHAR_UUID = "6d657368-0002-4a6d-9a3a-000000000002"
		/** Standard Client Characteristic Configuration Descriptor. */
		const val CCCD_UUID = "00002902-0000-1000-8000-00805f9b34fb"
		/** Worst-case usable bytes per BLE packet before MTU negotiation. */
		const val MIN_USABLE_MTU = 20
		const val PREFERRED_MTU = 517
		/** Backoff before retrying a write whose start the GATT stack refused. */
		const val RETRY_DELAY_MS = 40L
	}

	private val serviceUuid = UUID.fromString(SERVICE_UUID)
	private val txCharUuid = UUID.fromString(TX_CHAR_UUID)
	private val cccdUuid = UUID.fromString(CCCD_UUID)

	private val manager: BluetoothManager? by lazy {
		reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
	}

	private var advertiser: BluetoothLeAdvertiser? = null
	private var scanner: BluetoothLeScanner? = null
	private var gattServer: BluetoothGattServer? = null
	private var serverChar: BluetoothGattCharacteristic? = null

	/** One Link per remote BLE address; tracks role, MTU, rx buffer, tx queue. */
	private val links = ConcurrentHashMap<String, Link>()
	private val neighborsUp = ConcurrentHashMap.newKeySet<String>()
	/** Main-thread handler used to re-arm a stalled tx queue after a busy write. */
	private val mainHandler = Handler(Looper.getMainLooper())

	private inner class Link(val address: String) {
		@Volatile var clientGatt: BluetoothGatt? = null // set if WE connected out
		@Volatile var serverDevice: BluetoothDevice? = null // set if remote connected to our server
		@Volatile var serverSubscribed = false
		@Volatile var clientChar: BluetoothGattCharacteristic? = null
		@Volatile var mtu = MIN_USABLE_MTU
		val rx = ByteArrayOutputStream()
		val txQueue = ArrayDeque<ByteArray>()
		@Volatile var writing = false
		@Volatile var drainScheduled = false
		fun usable(): Int = (mtu - 3).coerceAtLeast(MIN_USABLE_MTU)
	}

	private fun linkFor(address: String): Link =
		links.getOrPut(address) { Link(address) }

	// ------------------------------------------------------------------
	// Peripheral role: advertise + GATT server
	// ------------------------------------------------------------------

	@ReactMethod
	fun startAdvertising(serviceId: String, promise: Promise) {
		try {
			val adapter = manager?.adapter ?: run {
				promise.reject("no_bt", "Bluetooth adapter unavailable"); return
			}
			openGattServer()
			val adv = adapter.bluetoothLeAdvertiser ?: run {
				promise.reject("no_adv", "BLE advertising unsupported on this device"); return
			}
			advertiser = adv
			val settings = AdvertiseSettings.Builder()
				.setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
				.setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
				.setConnectable(true)
				.build()
			val data = AdvertiseData.Builder()
				.setIncludeDeviceName(false)
				.addServiceUuid(ParcelUuid(serviceUuid))
				.build()
			adv.startAdvertising(settings, data, advCallback)
			promise.resolve(null)
		} catch (e: Exception) {
			promise.reject("adv_failed", e)
		}
	}

	private fun openGattServer() {
		if (gattServer != null) return
		val server = manager?.openGattServer(reactContext, gattServerCallback) ?: return
		val service = BluetoothGattService(serviceUuid, BluetoothGattService.SERVICE_TYPE_PRIMARY)
		val ch = BluetoothGattCharacteristic(
			txCharUuid,
			BluetoothGattCharacteristic.PROPERTY_WRITE or
				BluetoothGattCharacteristic.PROPERTY_WRITE_NO_RESPONSE or
				BluetoothGattCharacteristic.PROPERTY_NOTIFY,
			BluetoothGattCharacteristic.PERMISSION_WRITE,
		)
		val cccd = BluetoothGattDescriptor(
			cccdUuid,
			BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
		)
		ch.addDescriptor(cccd)
		service.addCharacteristic(ch)
		server.addService(service)
		serverChar = ch
		gattServer = server
	}

	private val advCallback = object : AdvertiseCallback() {
		override fun onStartFailure(errorCode: Int) {
			// Non-fatal: scanning/central role can still carry the mesh.
		}
	}

	private val gattServerCallback = object : BluetoothGattServerCallback() {
		override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
			val link = linkFor(device.address)
			if (newState == BluetoothProfile.STATE_CONNECTED) {
				link.serverDevice = device
				// Don't announce the neighbor yet: until the central subscribes to
				// our notify characteristic (onDescriptorWriteRequest) we have no way
				// to deliver frames back to it, so it isn't a usable mesh link.
			} else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
				link.serverDevice = null
				link.serverSubscribed = false
				maybeDown(link)
			}
		}

		override fun onMtuChanged(device: BluetoothDevice, mtu: Int) {
			linkFor(device.address).mtu = mtu
		}

		override fun onCharacteristicWriteRequest(
			device: BluetoothDevice,
			requestId: Int,
			characteristic: BluetoothGattCharacteristic,
			preparedWrite: Boolean,
			responseNeeded: Boolean,
			offset: Int,
			value: ByteArray,
		) {
			if (characteristic.uuid == txCharUuid) {
				onInboundBytes(device.address, value)
			}
			if (responseNeeded) {
				gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
			}
		}

		override fun onDescriptorWriteRequest(
			device: BluetoothDevice,
			requestId: Int,
			descriptor: BluetoothGattDescriptor,
			preparedWrite: Boolean,
			responseNeeded: Boolean,
			offset: Int,
			value: ByteArray,
		) {
			if (descriptor.uuid == cccdUuid) {
				val enable = value.isNotEmpty() && value[0].toInt() != 0
				val link = linkFor(device.address)
				link.serverSubscribed = enable
				if (responseNeeded) {
					gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
				}
				if (enable) {
					// The central can now receive notifications: this inbound link is
					// finally usable. Announce the neighbor and flush the HELLO/data that
					// queued while we had no deliverable channel.
					markNeighbor(device.address, true)
					drainTx(link)
				}
				return
			}
			if (responseNeeded) {
				gattServer?.sendResponse(device, requestId, BluetoothGatt.GATT_SUCCESS, offset, null)
			}
		}

		override fun onNotificationSent(device: BluetoothDevice, status: Int) {
			val link = links[device.address] ?: return
			link.writing = false
			drainTx(link)
		}
	}

	// ------------------------------------------------------------------
	// Central role: scan + GATT client
	// ------------------------------------------------------------------

	@ReactMethod
	fun startScanning(serviceId: String, promise: Promise) {
		try {
			val adapter = manager?.adapter ?: run {
				promise.reject("no_bt", "Bluetooth adapter unavailable"); return
			}
			val sc = adapter.bluetoothLeScanner ?: run {
				promise.reject("no_scan", "BLE scanning unsupported"); return
			}
			scanner = sc
			val filters = listOf(
				ScanFilter.Builder().setServiceUuid(ParcelUuid(serviceUuid)).build(),
			)
			val settings = ScanSettings.Builder()
				.setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
				.build()
			sc.startScan(filters, settings, scanCallback)
			promise.resolve(null)
		} catch (e: Exception) {
			promise.reject("scan_failed", e)
		}
	}

	private val scanCallback = object : ScanCallback() {
		override fun onScanResult(callbackType: Int, result: ScanResult) {
			val device = result.device ?: return
			val link = linkFor(device.address)
			// Only dial out once, and only if not already linked, to avoid races
			// where both sides connect (the engine dedups duplicate neighbors).
			if (link.clientGatt == null && link.serverDevice == null) {
				link.clientGatt = device.connectGatt(reactContext, false, gattClientCallback)
			}
		}
	}

	private val gattClientCallback = object : android.bluetooth.BluetoothGattCallback() {
		override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
			val link = linkFor(gatt.device.address)
			if (newState == BluetoothProfile.STATE_CONNECTED) {
				link.clientGatt = gatt
				gatt.requestMtu(PREFERRED_MTU)
			} else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
				link.clientGatt = null
				link.clientChar = null
				try { gatt.close() } catch (_: Exception) {}
				maybeDown(link)
			}
		}

		override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
			linkFor(gatt.device.address).mtu = mtu
			gatt.discoverServices()
		}

		override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
			if (status != BluetoothGatt.GATT_SUCCESS) return
			val ch = gatt.getService(serviceUuid)?.getCharacteristic(txCharUuid) ?: return
			val link = linkFor(gatt.device.address)
			link.clientChar = ch
			gatt.setCharacteristicNotification(ch, true)
			val cccd = ch.getDescriptor(cccdUuid)
			if (cccd != null) {
				@Suppress("DEPRECATION")
				cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
				@Suppress("DEPRECATION")
				val started = gatt.writeDescriptor(cccd)
				// Only one GATT op may be in flight: wait for onDescriptorWrite to
				// confirm the subscription before announcing the neighbor or sending
				// HELLO, otherwise that send would clobber this descriptor write.
				if (started) return
			}
			// No CCCD (notify unsupported) or the write couldn't even start: the
			// write channel still works, so treat the link as usable right now.
			markNeighbor(gatt.device.address, true)
			drainTx(link)
		}

		override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
			if (descriptor.uuid != cccdUuid) return
			// Notifications are live and the GATT is free again: announce the
			// neighbor and flush the queued HELLO/data (the engine sends HELLO the
			// instant a neighbor comes up).
			val link = linkFor(gatt.device.address)
			markNeighbor(gatt.device.address, true)
			drainTx(link)
		}

		@Suppress("DEPRECATION")
		override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
			if (characteristic.uuid == txCharUuid) {
				val v = characteristic.value ?: return
				onInboundBytes(gatt.device.address, v)
			}
		}

		override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
			val link = links[gatt.device.address] ?: return
			link.writing = false
			drainTx(link)
		}
	}

	// ------------------------------------------------------------------
	// MTU accessor
	// ------------------------------------------------------------------

	@ReactMethod
	fun negotiatedMtu(peerId: String, promise: Promise) {
		promise.resolve(links[peerId]?.mtu ?: MIN_USABLE_MTU)
	}

	// ------------------------------------------------------------------
	// Outbound: fragment + queue
	// ------------------------------------------------------------------

	@ReactMethod
	fun sendFrame(peerId: String, base64Frame: String, promise: Promise) {
		try {
			val frame = Base64.decode(base64Frame, Base64.NO_WRAP)
			val len = frame.size
			val wire = ByteArray(4 + len)
			wire[0] = (len ushr 24 and 0xFF).toByte()
			wire[1] = (len ushr 16 and 0xFF).toByte()
			wire[2] = (len ushr 8 and 0xFF).toByte()
			wire[3] = (len and 0xFF).toByte()
			System.arraycopy(frame, 0, wire, 4, len)

			val targets: List<Link> =
				if (peerId == "*") links.values.toList()
				else listOfNotNull(links[peerId])
			for (link in targets) enqueueWire(link, wire)
			promise.resolve(null)
		} catch (e: Exception) {
			promise.reject("send_failed", e)
		}
	}

	private fun enqueueWire(link: Link, wire: ByteArray) {
		val chunk = link.usable()
		synchronized(link.txQueue) {
			var off = 0
			while (off < wire.size) {
				val end = (off + chunk).coerceAtMost(wire.size)
				link.txQueue.add(wire.copyOfRange(off, end))
				off = end
			}
		}
		drainTx(link)
	}

	/** Re-arm a stalled tx queue after a transient busy-write, once, with backoff. */
	private fun scheduleDrain(link: Link) {
		if (link.drainScheduled) return
		link.drainScheduled = true
		mainHandler.postDelayed({
			link.drainScheduled = false
			drainTx(link)
		}, RETRY_DELAY_MS)
	}

	@Suppress("DEPRECATION")
	private fun drainTx(link: Link) {
		synchronized(link.txQueue) {
			if (link.writing) return
			val packet = link.txQueue.poll() ?: return
			link.writing = true
			val clientGatt = link.clientGatt
			val clientChar = link.clientChar
			val serverDevice = link.serverDevice
			val ch = serverChar
			when {
				clientGatt != null && clientChar != null -> {
					clientChar.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
					clientChar.value = packet
					val ok = clientGatt.writeCharacteristic(clientChar)
					if (!ok) {
						// Start refused (GATT busy): no write callback will fire, so put
						// the packet BACK and re-arm drainTx ourselves. Dropping it here
						// is what made the first HELLO vanish, leaving a connected link
						// with zero known nodes ("0 peers" despite an active radio).
						link.txQueue.addFirst(packet)
						link.writing = false
						scheduleDrain(link)
						return
					}
				}
				serverDevice != null && link.serverSubscribed && ch != null -> {
					ch.value = packet
					val ok = gattServer?.notifyCharacteristicChanged(serverDevice, ch, false) ?: false
					if (!ok) {
						link.txQueue.addFirst(packet)
						link.writing = false
						scheduleDrain(link)
						return
					}
				}
				else -> {
					// No usable channel yet; requeue and stop until a link is ready.
					link.txQueue.addFirst(packet)
					link.writing = false
					return
				}
			}
		}
	}

	// ------------------------------------------------------------------
	// Inbound: reassemble length-prefixed frames per link
	// ------------------------------------------------------------------

	private fun onInboundBytes(address: String, bytes: ByteArray) {
		val link = linkFor(address)
		synchronized(link.rx) {
			link.rx.write(bytes)
			var buf = link.rx.toByteArray()
			var consumed = 0
			while (buf.size - consumed >= 4) {
				val len = ((buf[consumed].toInt() and 0xFF) shl 24) or
					((buf[consumed + 1].toInt() and 0xFF) shl 16) or
					((buf[consumed + 2].toInt() and 0xFF) shl 8) or
					(buf[consumed + 3].toInt() and 0xFF)
				if (len < 0 || len > 512 * 1024) { consumed = buf.size; break } // corrupt; reset
				if (buf.size - consumed - 4 < len) break // wait for more
				val frame = buf.copyOfRange(consumed + 4, consumed + 4 + len)
				emitFrame(address, Base64.encodeToString(frame, Base64.NO_WRAP))
				consumed += 4 + len
			}
			link.rx.reset()
			if (consumed < buf.size) link.rx.write(buf, consumed, buf.size - consumed)
		}
	}

	// ------------------------------------------------------------------
	// Teardown
	// ------------------------------------------------------------------

	@ReactMethod
	fun stop(promise: Promise) {
		try {
			try { advertiser?.stopAdvertising(advCallback) } catch (_: Exception) {}
			try { scanner?.stopScan(scanCallback) } catch (_: Exception) {}
			for (link in links.values) {
				try { link.clientGatt?.disconnect(); link.clientGatt?.close() } catch (_: Exception) {}
			}
			try { gattServer?.close() } catch (_: Exception) {}
			links.clear()
			neighborsUp.clear()
			gattServer = null
			serverChar = null
			promise.resolve(null)
		} catch (e: Exception) {
			promise.reject("stop_failed", e)
		}
	}

	// ------------------------------------------------------------------
	// Neighbor + frame events to JS
	// ------------------------------------------------------------------

	private fun markNeighbor(address: String, up: Boolean) {
		if (up) {
			if (neighborsUp.add(address)) emitNeighbor(address, true)
		}
	}

	private fun maybeDown(link: Link) {
		if (link.clientGatt == null && link.serverDevice == null) {
			if (neighborsUp.remove(link.address)) emitNeighbor(link.address, false)
			links.remove(link.address)
		}
	}

	private fun emitFrame(peerId: String, base64Frame: String) {
		reactContext
			.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
			.emit("meshFrame", Arguments.createMap().apply {
				putString("peerId", peerId)
				putString("base64Frame", base64Frame)
				putString("tier", "ble")
			})
	}

	private fun emitNeighbor(peerId: String, up: Boolean) {
		reactContext
			.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
			.emit("meshNeighbor", Arguments.createMap().apply {
				putString("peerId", peerId)
				putString("tier", "ble")
				putBoolean("up", up)
			})
	}
}
