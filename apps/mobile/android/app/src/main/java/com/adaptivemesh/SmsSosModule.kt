package com.adaptivemesh

import android.content.Intent
import android.net.Uri
import android.os.Build
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

/**
 * Dual-track SMS SOS — the honest "last resort" tier. SMS is NOT mesh-routed;
 * it is point-to-point to an emergency contact when no mesh neighbor exists.
 *
 *  - Play build  : composeSos() opens the system SMS composer via an
 *                  ACTION_SENDTO "smsto:" intent. No SEND_SMS permission, user
 *                  taps send. Policy-clean for Google Play.
 *  - Sideload build (flavor "sideload"): sendSosDirect() uses SmsManager to send
 *                  without user interaction. Requires the SEND_SMS permission,
 *                  which only the sideload manifest declares. We detect that at
 *                  runtime via isDirectSendAvailable().
 *
 * BuildConfig.ALLOW_DIRECT_SMS is set per flavor in build.gradle.
 */
class SmsSosModule(reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {

	override fun getName(): String = "SmsSos"

	@ReactMethod
	fun isDirectSendAvailable(promise: Promise) {
		promise.resolve(BuildConfig.ALLOW_DIRECT_SMS)
	}

	@ReactMethod
	fun composeSos(phone: String, body: String, promise: Promise) {
		try {
			val intent = Intent(Intent.ACTION_SENDTO, Uri.parse("smsto:$phone"))
			intent.putExtra("sms_body", body)
			intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
			reactApplicationContext.startActivity(intent)
			promise.resolve(null)
		} catch (e: Exception) {
			promise.reject("sms_compose_failed", e)
		}
	}

	@ReactMethod
	fun sendSosDirect(phone: String, body: String, promise: Promise) {
		if (!BuildConfig.ALLOW_DIRECT_SMS) {
			promise.reject("not_supported", "Direct SMS is only available in the sideload build")
			return
		}
		try {
			// SmsManager is resolved reflectively-by-API to avoid a hard compile
			// dependency in flavors that strip telephony.
			val smsManager = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
				reactApplicationContext.getSystemService(android.telephony.SmsManager::class.java)
			} else {
				@Suppress("DEPRECATION")
				android.telephony.SmsManager.getDefault()
			}
			val parts = smsManager.divideMessage(body)
			smsManager.sendMultipartTextMessage(phone, null, parts, null, null)
			promise.resolve(true)
		} catch (e: Exception) {
			promise.reject("sms_send_failed", e)
		}
	}
}
