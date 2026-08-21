package com.adaptivemesh

import android.content.Context
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Tiny, dependency-free key/value persistence backed by Android SharedPreferences.
 *
 * This intentionally REPLACES @react-native-async-storage/async-storage so the
 * build pulls in ZERO extra Gradle/Maven artifacts (no KSP symbol-processing
 * plugin, no extra kotlin-stdlib download) -- it relies only on the Android SDK
 * already present on the build machine. That makes the build resilient on
 * locked-down / offline networks, which is exactly the environment this
 * offline-first app targets.
 *
 * It stores precisely what the mesh runtime needs: the permanent identity seeds
 * (stable nodeId), the user-chosen device name, and the per-mode demo flags.
 *
 * commit() (not apply()) is used so the write is durable by the time the JS
 * promise resolves; the call already runs off the JS thread on the native
 * module's executor.
 */
class PrefsModule(private val reactContext: ReactApplicationContext) :
	ReactContextBaseJavaModule(reactContext) {

	private val prefs by lazy {
		reactContext.getSharedPreferences("adaptivemesh.prefs", Context.MODE_PRIVATE)
	}

	override fun getName(): String = "MeshPrefs"

	@ReactMethod
	fun getItem(key: String, promise: Promise) {
		try {
			promise.resolve(prefs.getString(key, null))
		} catch (e: Exception) {
			promise.reject("prefs_get_failed", e)
		}
	}

	@ReactMethod
	fun setItem(key: String, value: String, promise: Promise) {
		try {
			val ok = prefs.edit().putString(key, value).commit()
			promise.resolve(ok)
		} catch (e: Exception) {
			promise.reject("prefs_set_failed", e)
		}
	}

	@ReactMethod
	fun removeItem(key: String, promise: Promise) {
		try {
			val ok = prefs.edit().remove(key).commit()
			promise.resolve(ok)
		} catch (e: Exception) {
			promise.reject("prefs_remove_failed", e)
		}
	}
}
