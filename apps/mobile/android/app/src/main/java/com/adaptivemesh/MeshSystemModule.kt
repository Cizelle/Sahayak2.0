package com.adaptivemesh

import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.Intent
import android.location.LocationManager
import android.net.wifi.WifiManager
import android.os.Build
import android.provider.Settings
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Queries and prompts the Bluetooth + Location *services* (NOT runtime
 * permissions — those go through PermissionsAndroid on the JS side).
 *
 * Android deliberately forbids an app from silently switching these on, so
 * promptEnable* launches the system enable dialog / settings screen and the JS
 * ReadinessGate re-checks is*Enabled afterward, staying blocking until both are
 * on. This is the closest honest equivalent to "force everything on".
 */
class MeshSystemModule(private val reactContext: ReactApplicationContext) :
	ReactContextBaseJavaModule(reactContext) {

	override fun getName(): String = "MeshSystem"

	private fun bluetoothAdapter(): BluetoothAdapter? {
		val mgr = reactContext.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager
		return mgr?.adapter
	}

	@ReactMethod
	fun isBluetoothEnabled(promise: Promise) {
		promise.resolve(bluetoothAdapter()?.isEnabled == true)
	}

	@ReactMethod
	fun isWifiEnabled(promise: Promise) {
		val wifi = reactContext.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
		promise.resolve(wifi?.isWifiEnabled == true)
	}

	@ReactMethod
	fun isLocationEnabled(promise: Promise) {
		val lm = reactContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
		val on = lm != null &&
			(lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ||
				lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER))
		promise.resolve(on)
	}

	@ReactMethod
	fun promptEnableBluetooth(promise: Promise) {
		try {
			val intent = Intent(BluetoothAdapter.ACTION_REQUEST_ENABLE)
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
			reactContext.startActivity(intent)
			promise.resolve(true)
		} catch (e: Exception) {
			promise.reject("bt_prompt_failed", e)
		}
	}

	@ReactMethod
	fun promptEnableWifi(promise: Promise) {
		try {
			val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
				Intent(Settings.Panel.ACTION_WIFI)
			} else {
				Intent(Settings.ACTION_WIFI_SETTINGS)
			}
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
			reactContext.startActivity(intent)
			promise.resolve(true)
		} catch (e: Exception) {
			promise.reject("wifi_prompt_failed", e)
		}
	}

	@ReactMethod
	fun promptEnableLocation(promise: Promise) {
		try {
			val intent = Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS)
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
			reactContext.startActivity(intent)
			promise.resolve(true)
		} catch (e: Exception) {
			promise.reject("loc_prompt_failed", e)
		}
	}
}
