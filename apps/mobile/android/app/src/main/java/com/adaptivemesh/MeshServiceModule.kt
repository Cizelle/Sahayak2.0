package com.adaptivemesh

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * JS-facing control for the foreground service. start() is only ever called by
 * the app AFTER ensurePermissions() resolves true, which guarantees the
 * connectedDevice FGS will not crash on launch (the MeshGuard failure mode).
 */
class MeshServiceModule(private val reactContext: ReactApplicationContext) :
	ReactContextBaseJavaModule(reactContext) {

	override fun getName(): String = "MeshService"

	@ReactMethod
	fun start(promise: Promise) {
		try {
			val intent = Intent(reactContext, MeshForegroundService::class.java)
			if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
				reactContext.startForegroundService(intent)
			} else {
				reactContext.startService(intent)
			}
			promise.resolve(null)
		} catch (e: Exception) {
			promise.reject("fgs_start_failed", e)
		}
	}

	@ReactMethod
	fun stop(promise: Promise) {
		reactContext.stopService(Intent(reactContext, MeshForegroundService::class.java))
		promise.resolve(null)
	}

	/**
	 * Honestly REPORTS whether every runtime permission the radios need is
	 * currently granted. The interactive request flow is owned by JS
	 * (ReadinessGate + permissions.ts via PermissionsAndroid), which is the
	 * Play-compliant place to show system dialogs; this native check is the
	 * source of truth the FGS also uses before going foreground.
	 */
	@ReactMethod
	fun ensurePermissions(promise: Promise) {
		val needed = mutableListOf<String>()
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
			needed.add("android.permission.BLUETOOTH_CONNECT")
			needed.add("android.permission.BLUETOOTH_SCAN")
			needed.add("android.permission.BLUETOOTH_ADVERTISE")
		} else {
			needed.add("android.permission.ACCESS_FINE_LOCATION")
		}
		if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
			needed.add("android.permission.NEARBY_WIFI_DEVICES")
		}
		val granted = needed.all {
			ContextCompat.checkSelfPermission(reactContext, it) == PackageManager.PERMISSION_GRANTED
		}
		promise.resolve(granted)
	}
}
