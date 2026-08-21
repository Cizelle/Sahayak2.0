package com.adaptivemesh

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import androidx.core.content.ContextCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Real device GPS for the SOS feature (item #2). Pure Android SDK
 * (LocationManager) -- no Google Play Services dependency, so it builds in the
 * locked-down/offline environment this app targets and works on de-Googled
 * devices too.
 *
 * Strategy (honest best-effort, GPS-first):
 *   1. Take the freshest last-known fix across GPS + network providers. If it
 *      is fresher than maxAgeMs, resolve immediately (instant, no battery cost).
 *   2. Otherwise request a SINGLE live update from every enabled provider and
 *      resolve the first fix that arrives, preferring GPS.
 *   3. If nothing arrives within timeoutMs, fall back to the best last-known
 *      fix (even if stale) so the SOS still carries coordinates; only reject
 *      when there is genuinely nothing and no provider is enabled.
 *
 * The caller (MeshController) layers the further fallback: GPS -> a location a
 * nearby peer shared over the mesh -> none. This module only owns THIS device.
 */
class MeshLocationModule(private val reactContext: ReactApplicationContext) :
	ReactContextBaseJavaModule(reactContext) {

	override fun getName(): String = "MeshLocation"

	private fun hasPermission(): Boolean {
		val fine = ContextCompat.checkSelfPermission(reactContext, Manifest.permission.ACCESS_FINE_LOCATION)
		val coarse = ContextCompat.checkSelfPermission(reactContext, Manifest.permission.ACCESS_COARSE_LOCATION)
		return fine == PackageManager.PERMISSION_GRANTED || coarse == PackageManager.PERMISSION_GRANTED
	}

	private fun providerSource(provider: String?): String =
		if (provider == LocationManager.GPS_PROVIDER) "gps" else "network"

	private fun toMap(loc: Location): WritableMap {
		val m = Arguments.createMap()
		m.putDouble("lat", loc.latitude)
		m.putDouble("lon", loc.longitude)
		m.putDouble("accuracyM", if (loc.hasAccuracy()) loc.accuracy.toDouble() else 0.0)
		m.putDouble("tsMs", loc.time.toDouble())
		m.putString("source", providerSource(loc.provider))
		return m
	}

	private fun bestLastKnown(lm: LocationManager): Location? {
		if (!hasPermission()) return null
		var best: Location? = null
		try {
			for (provider in lm.getProviders(true)) {
				val loc = try {
					lm.getLastKnownLocation(provider)
				} catch (e: SecurityException) {
					null
				}
				if (loc == null) continue
				if (best == null || loc.time > best!!.time) best = loc
			}
		} catch (e: Exception) {
			return best
		}
		return best
	}

	@ReactMethod
	fun getLocation(maxAgeMs: Double, timeoutMs: Double, promise: Promise) {
		if (!hasPermission()) {
			promise.reject("no_permission", "Location permission not granted")
			return
		}
		val lm = reactContext.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
		if (lm == null) {
			promise.reject("unavailable", "LocationManager unavailable")
			return
		}

		val now = System.currentTimeMillis()
		val fresh = bestLastKnown(lm)
		if (fresh != null && now - fresh.time <= maxAgeMs.toLong()) {
			promise.resolve(toMap(fresh))
			return
		}

		// Need a live fix. Listeners + timeout must run on a Looper thread.
		val main = Handler(Looper.getMainLooper())
		val settled = AtomicBoolean(false)
		val providers = try {
			lm.getProviders(true)
		} catch (e: Exception) {
			emptyList<String>()
		}

		if (providers.isEmpty()) {
			if (fresh != null) promise.resolve(toMap(fresh))
			else promise.reject("location_off", "No location provider is enabled")
			return
		}

		val listeners = ArrayList<LocationListener>()
		fun cleanup() {
			for (l in listeners) {
				try {
					lm.removeUpdates(l)
				} catch (e: Exception) {
					/* ignore */
				}
			}
			listeners.clear()
		}

		main.post {
			try {
				for (provider in providers) {
					val listener = object : LocationListener {
						override fun onLocationChanged(location: Location) {
							if (settled.compareAndSet(false, true)) {
								cleanup()
							promise.resolve(toMap(location))
						}
					}

					override fun onProviderEnabled(provider: String) {}
					override fun onProviderDisabled(provider: String) {}

					@Deprecated("Required by older API levels")
					override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
				}
				listeners.add(listener)
				try {
					lm.requestLocationUpdates(provider, 0L, 0f, listener, Looper.getMainLooper())
				} catch (e: SecurityException) {
					/* permission revoked mid-flight */
				} catch (e: IllegalArgumentException) {
					/* provider vanished */
				}
			}
		} catch (e: Exception) {
			/* fall through to timeout handling */
		}
		}

		main.postDelayed({
			if (settled.compareAndSet(false, true)) {
				cleanup()
				val fallback = bestLastKnown(lm)
				if (fallback != null) promise.resolve(toMap(fallback))
				else promise.reject("timeout", "No location fix within timeout")
			}
		}, timeoutMs.toLong())
	}
}
