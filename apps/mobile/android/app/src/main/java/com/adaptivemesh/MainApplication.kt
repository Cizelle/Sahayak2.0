package com.adaptivemesh

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactHost
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.load
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader

class MainApplication : Application(), ReactApplication {

	override val reactNativeHost: ReactNativeHost =
		object : DefaultReactNativeHost(this) {
			override fun getPackages(): List<ReactPackage> {
				// Autolinked packages + our AdaptiveMesh native modules.
				val packages = PackageList(this).packages
				packages.add(MeshPackage())
				return packages
			}

			override fun getJSMainModuleName(): String = "index"
			override fun getUseDeveloperSupport(): Boolean = BuildConfig.DEBUG
			override val isNewArchEnabled: Boolean = true
			override val isHermesEnabled: Boolean = true
		}

	override val reactHost: ReactHost
		get() = com.facebook.react.defaults.DefaultReactHost.getDefaultReactHost(applicationContext, reactNativeHost)

	override fun onCreate() {
		super.onCreate()
		// RN 0.81 merges most native libs (e.g. react_featureflagsjni) into a single
		// libreactnative.so. SoLoader needs OpenSourceMergedSoMapping to resolve those
		// merged libraries; the old `init(this, false)` skips it and crashes at launch
		// with UnsatisfiedLinkError: library "libreact_featureflagsjni.so" not found.
		SoLoader.init(this, OpenSourceMergedSoMapping)
		if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
			load()
		}
	}
}
