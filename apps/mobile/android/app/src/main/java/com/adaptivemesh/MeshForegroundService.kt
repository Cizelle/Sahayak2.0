package com.adaptivemesh

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat

/**
 * Long-lived foreground service that keeps the BLE/Nearby radios alive so the
 * device can relay for the mesh while backgrounded.
 *
 * This is the corrected version of the service that crashed in the MeshGuard
 * reference app. The original threw, on API 34+:
 *
 *   java.lang.SecurityException: Starting FGS with type connectedDevice ...
 *   requires permission FOREGROUND_SERVICE_CONNECTED_DEVICE
 *
 * The fix has FOUR parts (all required together):
 *   1. Declare FOREGROUND_SERVICE + FOREGROUND_SERVICE_CONNECTED_DEVICE in the
 *      manifest.
 *   2. Declare android:foregroundServiceType="connectedDevice" on the <service>.
 *   3. Pass FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE to startForeground().
 *   4. Ensure the BLE runtime permissions are GRANTED *before* we call
 *      startForeground(); if not, we stop ourselves cleanly instead of crashing.
 */
class MeshForegroundService : Service() {

	override fun onBind(intent: Intent?): IBinder? = null

	override fun onCreate() {
		super.onCreate()
		val mgr = getSystemService(NotificationManager::class.java)
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
			val channel = NotificationChannel(
				CHANNEL_ID,
				"Mesh connectivity",
				NotificationManager.IMPORTANCE_LOW,
			)
			channel.description = "Keeps mesh radios active so messages relay while the app is in the background."
			mgr.createNotificationChannel(channel)
		}
	}

	override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
		// Part 4: never call startForeground for a connectedDevice service unless
		// the platform-required BLE permissions are actually held.
		if (!hasConnectedDevicePermissions()) {
			stopSelf()
			return START_NOT_STICKY
		}

		val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
			.setContentTitle("AdaptiveMesh active")
			.setContentText("Relaying for nearby devices")
			.setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
			.setOngoing(true)
			.setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
			.build()

		val serviceType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
			ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE
		} else {
			0
		}

		// Part 3: ServiceCompat routes to the typed startForeground on every API
		// level and is the canonical safe call.
		ServiceCompat.startForeground(this, NOTIF_ID, notification, serviceType)

		// The radios (BleTransportModule advertise/scan + NearbyTransportModule
		// advertise/discover) are driven from JS by NativeRadioTransport once the
		// engine starts; this service's job is only to keep the process alive in
		// the background as a connectedDevice FGS so those loops are not killed.
		return START_STICKY
	}

	private fun hasConnectedDevicePermissions(): Boolean {
		if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true // pre-31 used legacy perms
		val needed = arrayOf(
			"android.permission.BLUETOOTH_CONNECT",
			"android.permission.BLUETOOTH_SCAN",
			"android.permission.BLUETOOTH_ADVERTISE",
		)
		return needed.all { ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED }
	}

	companion object {
		private const val CHANNEL_ID = "mesh_fgs"
		private const val NOTIF_ID = 1001
	}
}
