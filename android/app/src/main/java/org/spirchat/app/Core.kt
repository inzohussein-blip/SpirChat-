package org.spirchat.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper
import okhttp3.Dns
import okhttp3.OkHttpClient
import org.spirchat.engine.Engine
import org.spirchat.engine.HubManager
import org.spirchat.engine.Json
import org.spirchat.engine.PeerSession
import java.net.Inet4Address
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Process-wide sync engine. Lives as long as the process: the activity shows it, the
 * foreground service keeps the process (and so the engine) alive with the screen off.
 */
object Core : Mesh.Listener {
    private const val MAX_STORE_BYTES = 512L * 1024 * 1024

    lateinit var store: SqliteStore
        private set
    lateinit var engine: Engine
        private set
    lateinit var hubs: HubManager
        private set
    lateinit var mesh: Mesh
        private set

    private lateinit var connectivity: ConnectivityManager
    private val peers = ConcurrentHashMap<String, PeerSession>()
    private val worker = Executors.newSingleThreadScheduledExecutor { r -> Thread(r, "core").apply { isDaemon = true } }
    private val main = Handler(Looper.getMainLooper())
    private val listeners = CopyOnWriteArraySet<() -> Unit>()
    private val envelopeListeners = CopyOnWriteArraySet<(Json.Obj, String?) -> Unit>()

    @Volatile private var wifi: Network? = null
    @Volatile private var wifiClient: OkHttpClient? = null
    private val internetClient by lazy { OkHttpClient.Builder().pingInterval(30, TimeUnit.SECONDS).build() }
    private var notifyScheduled = false

    val peerCount get() = peers.size

    @Synchronized
    fun init(context: Context) {
        if (::engine.isInitialized) return
        val app = context.applicationContext
        store = SqliteStore(app)
        engine = Engine(store)
        mesh = Mesh(app, this)
        connectivity = app.getSystemService(ConnectivityManager::class.java)
        engine.addListener { _, env, _, source ->
            envelopeListeners.forEach { it(env, source) }
            changed()
        }
        engine.addBlobListener { changed() }
        hubs = HubManager(engine, { wifiClient }, internetClient, ::changed)
        watchWifi()
        hubs.start(hubConfig())
        worker.scheduleWithFixedDelay({ store.prune(MAX_STORE_BYTES, System.currentTimeMillis()) }, 0, 10, TimeUnit.MINUTES)
    }

    fun addChangeListener(l: () -> Unit) = listeners.add(l)
    fun removeChangeListener(l: () -> Unit) = listeners.remove(l)
    fun addEnvelopeListener(l: (Json.Obj, String?) -> Unit) = envelopeListeners.add(l)

    /** Coalesces bursts (a hub catch-up can deliver thousands of envelopes) into one UI refresh. */
    fun changed() {
        main.post {
            if (notifyScheduled) return@post
            notifyScheduled = true
            main.postDelayed({
                notifyScheduled = false
                listeners.forEach { it() }
            }, 300)
        }
    }

    // --- settings ---------------------------------------------------------------------------

    data class Settings(
        val manualHub: String = "",
        val internetHubs: List<String> = BuildConfig.INTERNET_HUBS.split(',').map { it.trim() }.filter { it.isNotEmpty() },
        val internetEnabled: Boolean = true,
        val background: Boolean = true,
        val mesh: Boolean = false,
    )

    fun settings(): Settings {
        val raw = store.getMeta("settings") ?: return Settings()
        val o = Json.parse(raw) as Json.Obj
        val d = Settings()
        return Settings(
            manualHub = o.str("manualHub") ?: d.manualHub,
            internetHubs = (o["internetHubs"] as? Json.Arr)?.items?.mapNotNull { (it as? Json.Str)?.value } ?: d.internetHubs,
            internetEnabled = (o["internetEnabled"] as? Json.Bool)?.value ?: d.internetEnabled,
            background = (o["background"] as? Json.Bool)?.value ?: d.background,
            mesh = (o["mesh"] as? Json.Bool)?.value ?: d.mesh,
        )
    }

    fun settingsJson(s: Settings = settings()): String = Json.obj(
        "manualHub" to Json.str(s.manualHub),
        "internetHubs" to Json.Arr(s.internetHubs.map(Json::Str)),
        "internetEnabled" to Json.Bool(s.internetEnabled),
        "background" to Json.Bool(s.background),
        "mesh" to Json.Bool(s.mesh),
    ).stringify()

    fun saveSettings(s: Settings) {
        store.setMeta("settings", settingsJson(s))
        hubs.update(hubConfig())
        changed()
    }

    /** Merges the fields present in [json] into the saved settings. */
    fun updateSettings(json: String): Settings {
        val o = Json.parse(json) as Json.Obj
        val cur = settings()
        val next = cur.copy(
            manualHub = o.str("manualHub")?.trim() ?: cur.manualHub,
            internetHubs = (o["internetHubs"] as? Json.Arr)?.items?.mapNotNull { (it as? Json.Str)?.value?.trim() }
                ?.filter { it.isNotEmpty() } ?: cur.internetHubs,
            internetEnabled = (o["internetEnabled"] as? Json.Bool)?.value ?: cur.internetEnabled,
            background = (o["background"] as? Json.Bool)?.value ?: cur.background,
            mesh = (o["mesh"] as? Json.Bool)?.value ?: cur.mesh,
        )
        saveSettings(next)
        return next
    }

    private fun hubConfig(): HubManager.Config {
        val s = settings()
        val local = listOf(s.manualHub, gateway() ?: "", "10.42.0.1", "spirchat.local").filter { it.isNotEmpty() }.distinct()
        return HubManager.Config(local, s.internetHubs, s.internetEnabled)
    }

    // --- Wi-Fi: local hubs are reached over the Wi-Fi network even when it has no internet ---

    private fun watchWifi() {
        val request = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
        connectivity.registerNetworkCallback(request, object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) = useWifi(network)

            override fun onLinkPropertiesChanged(network: Network, lp: LinkProperties) {
                if (network == wifi) hubs.update(hubConfig())
            }

            override fun onLost(network: Network) {
                if (network != wifi) return
                wifi = null
                wifiClient = null
                hubs.update(hubConfig())
                hubs.networkChanged()
            }
        })
    }

    private fun useWifi(network: Network) {
        wifi = network
        // Sockets bound to the Wi-Fi network, so a hub without internet is reachable even
        // while mobile data stays the default route for internet hubs.
        wifiClient = OkHttpClient.Builder()
            .socketFactory(network.socketFactory)
            .dns(object : Dns {
                override fun lookup(hostname: String) = network.getAllByName(hostname).toList()
            })
            .connectTimeout(5, TimeUnit.SECONDS)
            .pingInterval(30, TimeUnit.SECONDS)
            .build()
        hubs.update(hubConfig())
        hubs.networkChanged()
    }

    private fun gateway(): String? {
        val net = wifi ?: return null
        val lp = connectivity.getLinkProperties(net) ?: return null
        return lp.routes.firstOrNull { it.isDefaultRoute && it.gateway is Inet4Address }?.gateway?.hostAddress
    }

    // --- nearby phones --------------------------------------------------------------------

    fun startMesh() {
        mesh.start()
        saveSettings(settings().copy(mesh = true))
    }

    fun stopMesh() {
        mesh.stop()
        saveSettings(settings().copy(mesh = false))
    }

    override fun onPeerConnected(endpointId: String) {
        worker.execute {
            val s = PeerSession(engine, endpointId) { mesh.send(endpointId, it) }
            peers[endpointId] = s
            s.open()
            changed()
        }
    }

    override fun onPeerDisconnected(endpointId: String) {
        worker.execute {
            peers.remove(endpointId)?.close()
            changed()
        }
    }

    override fun onPeerMessage(endpointId: String, data: String) {
        worker.execute { peers[endpointId]?.receive(data) }
    }

    override fun onMeshState(running: Boolean) {
        if (!running) worker.execute { peers.values.forEach(PeerSession::close); peers.clear() }
        changed()
    }

    // --- for the UI bridge ----------------------------------------------------------------

    fun statusJson(): String = Json.obj(
        "hubs" to Json.Arr(
            hubs.status().map {
                Json.obj(
                    "url" to Json.str(it.url),
                    "internet" to Json.Bool(it.internet),
                    "state" to Json.str(it.state),
                    "name" to (it.name?.let(Json::Str) ?: Json.Null),
                )
            },
        ),
        "peers" to Json.num(peers.size),
        "mesh" to Json.Bool(mesh.running),
        "alertKeys" to Json.Arr((store.getMeta("alertKeys") ?: "").split(',').filter { it.isNotEmpty() }.map(Json::Str)),
    ).stringify()

    fun wipe() {
        mesh.stop()
        store.clear()
        engine.delivered.clear()
        hubs.update(hubConfig())
    }
}
