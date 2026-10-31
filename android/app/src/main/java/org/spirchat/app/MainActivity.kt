package org.spirchat.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.ActivityNotFoundException
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import org.json.JSONObject
import java.io.File
import kotlin.concurrent.thread

/**
 * Hosts the bundled web app (the same UI hubs serve) and gives it what a browser cannot:
 * direct links to nearby phones, the Wi-Fi gateway address for finding hubs, and APK sharing.
 */
class MainActivity : ComponentActivity(), Mesh.Listener {

    private lateinit var web: WebView
    private lateinit var mesh: Mesh
    private lateinit var connectivity: ConnectivityManager

    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var pendingGeo: Pair<String, GeolocationPermissions.Callback>? = null

    private val pickImage = registerForActivityResult(ActivityResultContracts.GetContent()) { uri ->
        fileCallback?.onReceiveValue(uri?.let { arrayOf(it) })
        fileCallback = null
    }

    private val meshPermissions =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result.values.all { it }) {
                mesh.start()
            } else {
                Toast.makeText(this, R.string.mesh_permissions_denied, Toast.LENGTH_LONG).show()
                onMeshState(false)
            }
        }

    private val locationPermission =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
            pendingGeo?.let { (origin, callback) -> callback.invoke(origin, granted, false) }
            pendingGeo = null
        }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        mesh = Mesh(applicationContext, this)
        connectivity = getSystemService(ConnectivityManager::class.java)
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG)

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.allowFileAccess = false
            settings.setGeolocationEnabled(true)
            // The page is served from a local https origin; hubs are plain http on the LAN.
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW

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
                    pickImage.launch("image/*")
                    return true
                }

                override fun onGeolocationPermissionsShowPrompt(origin: String, callback: GeolocationPermissions.Callback) {
                    if (granted(Manifest.permission.ACCESS_FINE_LOCATION)) {
                        callback.invoke(origin, true, false)
                    } else {
                        pendingGeo = origin to callback
                        locationPermission.launch(Manifest.permission.ACCESS_FINE_LOCATION)
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
        watchWifi()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    override fun onDestroy() {
        connectivity.unregisterNetworkCallback(wifiCallback)
        connectivity.bindProcessToNetwork(null)
        mesh.stop()
        web.destroy()
        super.onDestroy()
    }

    // --- JavaScript bridge (see web/src/lib/native.ts) ------------------------------------

    inner class Bridge {
        @JavascriptInterface
        fun sendToPeer(endpointId: String, data: String) = mesh.send(endpointId, data)

        @JavascriptInterface
        fun startMesh() = runOnUiThread { requestMesh() }

        @JavascriptInterface
        fun stopMesh() = runOnUiThread { mesh.stop() }

        @JavascriptInterface
        fun isMeshRunning(): Boolean = mesh.running

        @JavascriptInterface
        fun gatewayIp(): String = currentGateway()

        @JavascriptInterface
        fun shareApp() = runOnUiThread { shareApk() }

        @JavascriptInterface
        fun openUrl(url: String) = runOnUiThread { openExternal(Uri.parse(url)) }
    }

    private fun callJs(function: String, vararg args: String) {
        val joined = args.joinToString(",") { JSONObject.quote(it) }
        web.post { web.evaluateJavascript("window.spirchatPeer && window.spirchatPeer.$function($joined)", null) }
    }

    override fun onPeerConnected(endpointId: String) = callJs("onConnected", endpointId)

    override fun onPeerDisconnected(endpointId: String) = callJs("onDisconnected", endpointId)

    override fun onPeerMessage(endpointId: String, data: String) = callJs("onMessage", endpointId, data)

    override fun onMeshState(running: Boolean) {
        web.post { web.evaluateJavascript("window.spirchatPeer && window.spirchatPeer.onMeshState($running)", null) }
    }

    // --- nearby phones ---------------------------------------------------------------------

    private fun meshPermissionList(): List<String> = buildList {
        if (Build.VERSION.SDK_INT >= 31) {
            add(Manifest.permission.BLUETOOTH_SCAN)
            add(Manifest.permission.BLUETOOTH_ADVERTISE)
            add(Manifest.permission.BLUETOOTH_CONNECT)
        }
        if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.NEARBY_WIFI_DEVICES)
        else add(Manifest.permission.ACCESS_FINE_LOCATION)
    }

    private fun requestMesh() {
        val missing = meshPermissionList().filterNot(::granted)
        if (missing.isEmpty()) mesh.start() else meshPermissions.launch(missing.toTypedArray())
    }

    private fun granted(permission: String) =
        ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED

    // --- hubs over Wi-Fi -------------------------------------------------------------------

    /**
     * Hub Wi-Fi has no internet, so Android would keep sending traffic over mobile data and
     * never reach the hub. While on Wi-Fi, bind the app to it, then tell the page to retry.
     */
    private val wifiCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            connectivity.bindProcessToNetwork(network)
            callJs("onNetworkChanged")
        }

        override fun onLost(network: Network) {
            if (connectivity.boundNetworkForProcess == network) connectivity.bindProcessToNetwork(null)
            callJs("onNetworkChanged")
        }
    }

    private fun watchWifi() {
        val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
        connectivity.registerNetworkCallback(request, wifiCallback)
    }

    private fun currentGateway(): String {
        val wifi = applicationContext.getSystemService(WifiManager::class.java) ?: return ""
        @Suppress("DEPRECATION")
        val gw = wifi.dhcpInfo?.gateway ?: 0
        if (gw == 0) return ""
        return listOf(gw and 0xff, gw shr 8 and 0xff, gw shr 16 and 0xff, gw ushr 24 and 0xff).joinToString(".")
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

    private fun openExternal(uri: Uri) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, uri))
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(this, uri.toString(), Toast.LENGTH_LONG).show()
        }
    }
}
