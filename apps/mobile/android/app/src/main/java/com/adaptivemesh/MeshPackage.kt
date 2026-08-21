package com.adaptivemesh

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers all AdaptiveMesh native modules with React Native. Added to the
 * ReactNativeHost package list in MainApplication.kt.
 */
class MeshPackage : ReactPackage {
	override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
		listOf(
			MeshServiceModule(reactContext),
			BleTransportModule(reactContext),
			NearbyTransportModule(reactContext),
			SmsSosModule(reactContext),
			PrefsModule(reactContext),
			MeshLocationModule(reactContext),
			MediaPickerModule(reactContext),
			MeshSystemModule(reactContext),
		)

	override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
		emptyList()
}
