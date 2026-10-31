package org.spirchat.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.spirchat.engine.Accept
import org.spirchat.engine.Json
import java.io.File
import kotlin.concurrent.thread

/**
 * Hosts the bundled web app (the same UI hubs serve). In the app, the web UI does not sync by
 * itself: it reads from and publishes to the native engine in [Core] through [Bridge].
 */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null
    private var pendingCamera: PermissionRequest? = null

    private val onChange: () -> Unit = {
        web.evaluateJavascript("window.spirchatEvents && window.spirchatEvents.onChanged()", null)
    }

    private val pickImage = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        fileCallback?.onReceiveValue(uri?.let { arrayOf(it) })
        fileCallback = null
    }

    private val meshPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result.values.all { it }) {
                Core.startMesh()
                SyncService.start(this)
            } else {
                Toast.makeText(this, R.string.mesh_permissions_denied, Toast.LENGTH_LONG).show()
            }
            Core.changed()
        }

    private val locationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pendingGeo?.let { (origin, callback) -> callback.invoke(origin, granted, false) }
            pendingGeo = null
        }

    private val cameraPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pendingCamera?.let { if (granted) it.grant(it.resources) else it.deny() }
            pendingCamera = null
        }

    private val notificationPermission = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Core.init(this)
        Notifier.install(this)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.mediaPlaybackRequiresUserGesture = false
            settings.setGeolocationEnabled(true)
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

            webViewClient = object : WebViewClientCompat() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)

                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    if (request.url.host == WebViewAssetLoader.DEFAULT_DOMAIN) return false
                    openExternal(request.url)
                    return true
                }
            }

            webChromeClient = object : WebChromeClient() {
                override fun onShowFileChooser(
                    view: WebView,
                    callback: ValueCallback<Array<Uri>>,
                    params: FileChooserParams,
                ): Boolean {
                    fileCallback?.onReceiveValue(null)
                    fileCallback = callback
                    pickImage.launch(params.acceptTypes.firstOrNull { it.isNotBlank() } ?: "image/*")
                    return true
                }

                override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                    if (Permissions.granted(this@MainActivity, Manifest.permission.ACCESS_FINE_LOCATION)) {
                        callback.invoke(origin, true, false)
                    } else {
                        pendingGeo = origin to callback
                        locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)
                    }
                }

                // Camera for scanning contact QR codes, microphone for voice messages.
                override fun onPermissionRequest(request: PermissionRequest) {
                    val needed = request.resources.mapNotNull {
                        when (it) {
                            PermissionRequest.RESOURCE_VIDEO_CAPTURE -> Manifest.permission.CAMERA
                            PermissionRequest.RESOURCE_AUDIO_CAPTURE -> Manifest.permission.RECORD_AUDIO
                            else -> null
                        }
                    }
                    val missing = needed.filterNot { Permissions.granted(this@MainActivity, it) }
                    if (missing.isEmpty()) {
                        request.grant(request.resources)
                    } else {
                        pendingCamera = request
                        cameraPermission.launch(missing.first())
                    }
                }
            }

            setDownloadListener { url, _, _, _, _ -> openExternal(Uri.parse(url)) }
            addJavascriptInterface(Bridge(), "SpirChatNative")
        }

        setContentView(web)
        if (savedInstanceState == null) {
            web.loadUrl("https://${WebViewAssetLoader.DEFAULT_DOMAIN}/assets/web/index.html")
        } else {
            web.restoreState(savedInstanceState)
        }
        Core.addChangeListener(onChange)
        if (Core.settings().background) SyncService.start(this)
        if (Build.VERSION.SDK_INT >= 33 && !Permissions.granted(this, Manifest.permission.POST_NOTIFICATIONS)) {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    override fun onResume() {
        super.onResume()
        Notifier.foreground = true
        Notifier.clear(this)
    }

    override fun onPause() {
        Notifier.foreground = false
        super.onPause()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        Core.removeChangeListener(onChange)
        web.destroy()
        super.onDestroy()
    }

    // --- JavaScript bridge (see web/src/lib/native.ts) ------------------------------------

    inner class Bridge {
        /** Envelopes stored after local sequence [since]: {"items":[{"seq":n,"env":{…}}],"last":n,"more":bool}. */
        @JavascriptInterface
        fun storeSince(since: String): String {
            val from = since.toLongOrNull() ?: 0
            val rows = Core.store.since(from, 301)
            val more = rows.size > 300
            val page = rows.take(300)
            val items = page.joinToString(",") { """{"seq":${it.seq},"env":${it.json}}""" }
            return """{"items":[$items],"last":${page.lastOrNull()?.seq ?: from},"more":$more}"""
        }

        /** Returns "" when accepted (or already known), otherwise the rejection reason. */
        @JavascriptInterface
        fun publish(json: String): String = when (val r = Core.engine.accept(json, null)) {
            is Accept.Rejected -> r.reason
            else -> ""
        }

        /** "mime;base64" if the image is here; otherwise "" and nearby phones and hubs are asked for it. */
        @JavascriptInterface
        fun getBlob(id: String): String {
            val (mime, data) = Core.store.getBlob(id) ?: run {
                Core.engine.requestBlob(id)
                return ""
            }
            return mime + ";" + android.util.Base64.encodeToString(data, android.util.Base64.NO_WRAP)
        }

        @JavascriptInterface
        fun putBlob(id: String, mime: String, base64: String): Boolean =
            Core.engine.putBlob(id, mime, android.util.Base64.decode(base64, android.util.Base64.DEFAULT))

        @JavascriptInterface
        fun delivered(idsJson: String): String {
            val ids = (Json.parse(idsJson) as? Json.Arr)?.items?.mapNotNull { (it as? Json.Str)?.value }.orEmpty()
            return Json.Arr(ids.filter(Core.engine.delivered::contains).map(Json::Str)).stringify()
        }

        @JavascriptInterface
        fun status(): String = Core.statusJson()

        @JavascriptInterface
        fun settings(): String = Core.settingsJson()

        @JavascriptInterface
        fun updateSettings(json: String): String {
            val s = Core.updateSettings(json)
            runOnUiThread {
                if (s.background) SyncService.start(this@MainActivity) else SyncService.stop(this@MainActivity)
            }
            return Core.settingsJson(s)
        }

        /** Mailbox tag of this device's identity, so DMs can raise notifications natively. */
        @JavascriptInterface
        fun setIdentity(tag: String, id: String) {
            Core.store.setMeta("myTag", tag)
            Core.store.setMeta("myId", id)
        }

        @JavascriptInterface
        fun startMesh() = runOnUiThread {
            val missing = Permissions.mesh().filterNot { Permissions.granted(this@MainActivity, it) }
            if (missing.isEmpty()) {
                Core.startMesh()
                SyncService.start(this@MainActivity)
            } else {
                meshPermissions.launch(missing.toTypedArray())
            }
        }

        @JavascriptInterface
        fun stopMesh() = runOnUiThread { Core.stopMesh() }

        @JavascriptInterface
        fun isMeshRunning(): Boolean = Core.mesh.running

        @JavascriptInterface
        fun shareApp() = runOnUiThread { shareApk() }

        @JavascriptInterface
        fun openUrl(url: String) = runOnUiThread { openExternal(Uri.parse(url)) }

        @JavascriptInterface
        fun wipe() = Core.wipe()

        /** Shares everything this phone carries as an NDJSON bundle (USB stick, Bluetooth, another hub). */
        @JavascriptInterface
        fun exportBundle() = runOnUiThread { shareBundle() }
    }

    // --- sharing ---------------------------------------------------------------------------

    /** Lets people pass the app on with Bluetooth or Nearby Share when there is no app store. */
    private fun shareApk() {
        thread(name = "share-apk") {
            val dir = File(cacheDir, "apk").apply { mkdirs() }
            val apk = File(dir, "SpirChat.apk")
            File(applicationInfo.sourceDir).copyTo(apk, overwrite = true)
            val uri = FileProvider.getUriForFile(this, "$packageName.files", apk)
            val send = Intent(Intent.ACTION_SEND)
                .setType("application/vnd.android.package-archive")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            runOnUiThread { startActivity(Intent.createChooser(send, getString(R.string.share_app))) }
        }
    }

    private fun shareBundle() {
        thread(name = "export") {
            val dir = File(cacheDir, "apk").apply { mkdirs() }
            val file = File(dir, "spirchat-${System.currentTimeMillis()}.ndjson")
            file.bufferedWriter().use { out ->
                var seq = 0L
                while (true) {
                    val page = Core.store.since(seq, 500)
                    if (page.isEmpty()) break
                    page.forEach { out.write(it.json); out.write("\n") }
                    seq = page.last().seq
                }
            }
            val uri = FileProvider.getUriForFile(this, "$packageName.files", file)
            val send = Intent(Intent.ACTION_SEND)
                .setType("application/x-ndjson")
                .putExtra(Intent.EXTRA_STREAM, uri)
                .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            runOnUiThread { startActivity(Intent.createChooser(send, getString(R.string.export_bundle))) }
        }
    }

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, uri.toString(), Toast.LENGTH_LONG).show()
        }
    }
}
