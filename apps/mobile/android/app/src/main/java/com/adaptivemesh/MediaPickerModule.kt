package com.adaptivemesh

import android.app.Activity
import android.content.ContentValues
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.OpenableColumns
import android.util.Base64
import androidx.core.content.FileProvider
import com.facebook.react.bridge.ActivityEventListener
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableMap
import java.io.ByteArrayOutputStream
import java.io.File

/**
 * Multimedia attachment picker (item #7). Uses the Android Storage Access
 * Framework (ACTION_GET_CONTENT) -- a pure-SDK system picker that needs NO
 * runtime permission and NO third-party Gradle dependency, so it builds offline
 * like the rest of the app.
 *
 * It returns the chosen file as base64 + mime + name + size. The JS layer wraps
 * those bytes in the core's tagged media payload and sends them through the
 * SAME encrypted, chunked, store-and-forward mesh engine as text, so multimedia
 * rides whichever tier is currently up (Internet/Wi-Fi/BLE). maxBytes is the
 * honest cap the caller derives from the active tier (BLE links are tiny, so
 * the UI passes a smaller cap there) -- we reject oversize files instead of
 * pretending a 50 MB video will cross a BLE link.
 */
class MediaPickerModule(private val reactContext: ReactApplicationContext) :
	ReactContextBaseJavaModule(reactContext), ActivityEventListener {

	private val requestCode = 0xAD7E
	private var pending: Promise? = null
	private var maxBytes: Long = 0

	// Absolute read ceiling (OOM guard). Images may be read up to this size and
	// then downscaled/compressed to fit the per-tier cap; non-images are capped
	// directly at maxBytes during the read.
	private val hardMax: Long = 32L * 1024L * 1024L

	init {
		reactContext.addActivityEventListener(this)
	}

	override fun getName(): String = "MeshMedia"

	@ReactMethod
	fun pick(maxBytes: Double, promise: Promise) {
		val activity = reactContext.currentActivity
		if (activity == null) {
			promise.reject("no_activity", "No foreground activity to launch the picker")
			return
		}
		if (pending != null) {
			promise.reject("busy", "A picker request is already in progress")
			return
		}
		this.maxBytes = maxBytes.toLong()
		pending = promise
		try {
			val intent = Intent(Intent.ACTION_GET_CONTENT)
			intent.type = "*/*"
			intent.addCategory(Intent.CATEGORY_OPENABLE)
			activity.startActivityForResult(Intent.createChooser(intent, "Select attachment"), requestCode)
		} catch (e: Exception) {
			pending = null
			promise.reject("picker_failed", e)
		}
	}

	override fun onActivityResult(activity: Activity, code: Int, resultCode: Int, data: Intent?) {
		if (code != requestCode) return
		val promise = pending ?: return
		pending = null

		if (resultCode != Activity.RESULT_OK || data == null || data.data == null) {
			promise.reject("cancelled", "No file selected")
			return
		}
		val uri = data.data!!
		val cap = maxBytes
		// Reading the file, base64-encoding it, and (for images) decoding +
		// recompressing the bitmap can touch tens of MB. onActivityResult is
		// delivered on the MAIN thread, so doing this inline froze the whole UI
		// (the reported "app hangs when sending media"). Do the heavy work on a
		// worker thread and resolve/reject the promise from there.
		Thread {
			try {
				val result = readUri(uri, cap)
				if (result == null) promise.reject("read_failed", "Could not read the selected file")
				else promise.resolve(result)
			} catch (e: TooLargeException) {
				promise.reject("too_large", e.message)
			} catch (e: Exception) {
				promise.reject("read_failed", e)
			}
		}.start()
	}

	override fun onNewIntent(intent: Intent) {}

	private class TooLargeException(msg: String) : Exception(msg)

	private fun queryNameAndSize(uri: Uri): Pair<String, Long> {
		var name = "attachment"
		var size = -1L
		try {
			reactContext.contentResolver.query(uri, null, null, null, null)?.use { c ->
				val nameIdx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
				val sizeIdx = c.getColumnIndex(OpenableColumns.SIZE)
				if (c.moveToFirst()) {
					if (nameIdx >= 0) c.getString(nameIdx)?.let { name = it }
					if (sizeIdx >= 0 && !c.isNull(sizeIdx)) size = c.getLong(sizeIdx)
				}
			}
		} catch (e: Exception) {
			/* keep defaults */
		}
		return Pair(name, size)
	}

	private fun readUri(uri: Uri, cap: Long): WritableMap? {
		val resolver = reactContext.contentResolver
		val mime = resolver.getType(uri) ?: "application/octet-stream"
		val (name, declaredSize) = queryNameAndSize(uri)
		val isImage = mime.startsWith("image/")
		// Non-images are hard-capped at the tier limit. Images are allowed up to the
		// absolute ceiling and then compressed below the tier limit afterwards.
		val readLimit = if (isImage) hardMax else if (cap > 0) cap else hardMax
		if (!isImage && cap > 0 && declaredSize in 1 until Long.MAX_VALUE && declaredSize > cap) {
			throw TooLargeException("File is " + declaredSize + " bytes; limit is " + cap)
		}

		val input = resolver.openInputStream(uri) ?: return null
		val buffer = ByteArrayOutputStream()
		input.use { stream ->
			val chunk = ByteArray(64 * 1024)
			var total = 0L
			while (true) {
				val read = stream.read(chunk)
				if (read < 0) break
				total += read
				if (total > readLimit) {
					throw TooLargeException("File exceeds limit of " + readLimit + " bytes")
				}
				buffer.write(chunk, 0, read)
			}
		}

		var bytes = buffer.toByteArray()
		var outMime = mime
		if (isImage) {
			val compressed = compressImage(bytes, cap)
			if (compressed != null) {
				bytes = compressed
				outMime = "image/jpeg"
			}
			if (cap > 0 && bytes.size.toLong() > cap) {
				throw TooLargeException(
					"Image is " + bytes.size + " bytes after compression; limit is " + cap,
				)
			}
		}

		val out = Arguments.createMap()
		out.putString("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
		out.putString("mime", outMime)
		out.putString("name", name)
		out.putDouble("size", bytes.size.toDouble())
		return out
	}

	/**
	 * Downscale + JPEG-compress an image so it fits under [limit] bytes (item #7).
	 * Pure Android SDK (BitmapFactory/Bitmap), no extra dependency, and it runs on
	 * the native-modules thread, off the UI/JS thread (no ANR / no hang). Returns
	 * null if the bytes are not a decodable image (caller keeps the original).
	 */
	private fun compressImage(bytes: ByteArray, limit: Long): ByteArray? {
		val bounds = BitmapFactory.Options()
		bounds.inJustDecodeBounds = true
		BitmapFactory.decodeByteArray(bytes, 0, bytes.size, bounds)
		if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null

		var sample = 1
		while (bounds.outWidth / sample > 1600 || bounds.outHeight / sample > 1600) {
			sample *= 2
		}
		val opts = BitmapFactory.Options()
		opts.inSampleSize = sample
		var bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts) ?: return null

		val target = if (limit > 0) limit else 512L * 1024L
		var quality = 85
		var data = encodeJpeg(bmp, quality)
		while (data.size.toLong() > target && quality > 30) {
			quality -= 15
			data = encodeJpeg(bmp, quality)
		}
		// Still too big? Halve the dimensions and re-encode until it fits or is tiny.
		while (data.size.toLong() > target && (bmp.width > 320 || bmp.height > 320)) {
			val nw = if (bmp.width / 2 < 1) 1 else bmp.width / 2
			val nh = if (bmp.height / 2 < 1) 1 else bmp.height / 2
			val scaled = Bitmap.createScaledBitmap(bmp, nw, nh, true)
			if (scaled != bmp) bmp.recycle()
			bmp = scaled
			data = encodeJpeg(bmp, 70)
		}
		bmp.recycle()
		return data
	}

	private fun encodeJpeg(bmp: Bitmap, quality: Int): ByteArray {
		val out = ByteArrayOutputStream()
		bmp.compress(Bitmap.CompressFormat.JPEG, quality, out)
		return out.toByteArray()
	}

	/**
	 * Save an attachment to the device's shared storage so it survives outside the
	 * app, exactly like a normal messenger's "Save" (item #7). Images land in
	 * Pictures/AdaptiveMesh, everything else in Download/AdaptiveMesh, written via
	 * MediaStore so NO storage permission is needed on API 29+. Runs off the main
	 * thread; resolves with the saved display name.
	 */
	@ReactMethod
	fun saveToGallery(base64: String, mime: String, name: String, promise: Promise) {
		Thread {
			try {
				val bytes = Base64.decode(base64, Base64.DEFAULT)
				val resolver = reactContext.contentResolver
				val isImage = mime.startsWith("image/")
				val safeName = sanitizeName(name, if (isImage) "jpg" else "bin")
				val values = ContentValues()
				values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName)
				values.put(MediaStore.MediaColumns.MIME_TYPE, mime)
				val collection: Uri
				if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
					val subDir = if (isImage) Environment.DIRECTORY_PICTURES else Environment.DIRECTORY_DOWNLOADS
					values.put(MediaStore.MediaColumns.RELATIVE_PATH, subDir + "/AdaptiveMesh")
					values.put(MediaStore.MediaColumns.IS_PENDING, 1)
					collection =
						if (isImage) MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
						else MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
				} else {
					collection =
						if (isImage) MediaStore.Images.Media.EXTERNAL_CONTENT_URI
						else MediaStore.Files.getContentUri("external")
				}
				val item = resolver.insert(collection, values) ?: throw Exception("MediaStore refused the insert")
				(resolver.openOutputStream(item) ?: throw Exception("Could not open output stream")).use { out ->
					out.write(bytes)
				}
				if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
					values.clear()
					values.put(MediaStore.MediaColumns.IS_PENDING, 0)
					resolver.update(item, values, null, null)
				}
				promise.resolve(safeName)
			} catch (e: Exception) {
				promise.reject("save_failed", e)
			}
		}.start()
	}

	/**
	 * Open an attachment in the user's preferred external app (gallery, PDF
	 * viewer, media player…) -- the messenger "Open" action (item #7). Bytes are
	 * written to the app cache and shared read-only through a FileProvider
	 * content:// URI, the only SDK-clean way to hand a file to another app on
	 * modern Android. Runs off the main thread.
	 */
	@ReactMethod
	fun openMedia(base64: String, mime: String, name: String, promise: Promise) {
		Thread {
			try {
				val bytes = Base64.decode(base64, Base64.DEFAULT)
				val dir = File(reactContext.cacheDir, "shared")
				dir.mkdirs()
				val file = File(dir, sanitizeName(name, "bin"))
				file.outputStream().use { out -> out.write(bytes) }
				val uri =
					FileProvider.getUriForFile(reactContext, reactContext.packageName + ".fileprovider", file)
				val view = Intent(Intent.ACTION_VIEW)
				view.setDataAndType(uri, mime)
				view.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
				val chooser = Intent.createChooser(view, "Open with")
				chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
				reactContext.startActivity(chooser)
				promise.resolve(true)
			} catch (e: Exception) {
				promise.reject("open_failed", e)
			}
		}.start()
	}

	/** Make a user-supplied file name safe for the filesystem / MediaStore. */
	private fun sanitizeName(name: String, fallbackExt: String): String {
		val cleaned = name.trim().replace(Regex("[^A-Za-z0-9._-]"), "_").take(120)
		if (cleaned.isEmpty() || cleaned == "_") return "attachment." + fallbackExt
		return if (cleaned.contains('.')) cleaned else cleaned + "." + fallbackExt
	}
}
