package org.spirchat.engine

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Keeps the engine connected to hubs:
 *  - one **local** slot that cycles through candidate addresses on the current Wi-Fi
 *    (gateway, 10.42.0.1, spirchat.local, a manual address) until one answers;
 *  - one slot per configured **internet hub**, used whenever the internet is reachable.
 * Both run at the same time, so a phone bridges its neighbourhood and the internet.
 */
class HubManager(
    private val engine: Engine,
    /** Client for local hubs, e.g. bound to the Wi-Fi network; null while there is no Wi-Fi. */
    private val localClient: () -> OkHttpClient?,
    private val internetClient: OkHttpClient,
    private val onChange: () -> Unit = {},
) {
    data class Config(
        val localCandidates: List<String> = emptyList(),
        val internetHubs: List<String> = emptyList(),
        val internetEnabled: Boolean = true,
    )

    data class Status(val url: String, val internet: Boolean, val state: String, val name: String?)

    private val timer: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "hub-manager").apply { isDaemon = true }
    }

    @Volatile var config = Config()
        private set

    private inner class Slot(val internet: Boolean) {
        var socket: WebSocket? = null
        var session: HubSession? = null
        var client: OkHttpClient? = null
        var blobsSynced = false
        var url: String? = null
        var retryMs = 1000L
        var candidateIdx = 0
        var generation = 0
        var stopped = false

        fun candidates(): List<String> =
            if (internet) listOfNotNull(url) else config.localCandidates.map(::wsUrl).distinct()

        fun connect() {
            if (stopped) return
            val gen = ++generation
            val list = candidates()
            val client = if (internet) internetClient else localClient()
            if (list.isEmpty() || client == null) {
                onChange()
                return
            }
            val target = list[candidateIdx % list.size]
            url = if (internet) url else target
            this.client = client
            blobsSynced = false
            var opened = false
            val ws = client.newWebSocket(Request.Builder().url(target).build(), object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    timer.execute {
                        if (gen != generation) return@execute webSocket.cancel().let { }
                        opened = true
                        retryMs = 1000
                        val s = HubSession(engine, httpUrl(target), { webSocket.send(it) }) { session ->
                            if (session.state == HubSession.State.ONLINE && !blobsSynced) {
                                blobsSynced = true
                                http.execute { uploadBlobs(client, session.url) }
                            }
                            onChange()
                        }
                        session = s
                        s.open()
                        onChange()
                    }
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    timer.execute { if (gen == generation) session?.receive(text) }
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    webSocket.close(1000, null)
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = dropped()

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = dropped()

                private fun dropped() = timer.execute {
                    if (gen != generation) return@execute
                    session?.close()
                    session = null
                    socket = null
                    onChange()
                    var delay = 1000L
                    if (!opened) {
                        candidateIdx++
                        val wrapped = candidateIdx % maxOf(1, list.size) == 0
                        delay = if (wrapped) retryMs else 200
                        if (wrapped) retryMs = minOf(retryMs * 2, 60_000)
                    }
                    timer.schedule({ if (gen == generation) connect() }, delay, TimeUnit.MILLISECONDS)
                }
            })
            socket = ws
        }

        fun stop() {
            stopped = true
            generation++
            session?.close()
            session = null
            socket?.cancel()
            socket = null
        }

        fun restart() {
            generation++
            session?.close()
            session = null
            socket?.cancel()
            socket = null
            retryMs = 1000
            candidateIdx = 0
            stopped = false
            connect()
        }

        fun status() = Status(
            url = session?.url ?: url?.let(::httpUrl) ?: "",
            internet = internet,
            state = when (session?.state) {
                HubSession.State.ONLINE -> "online"
                HubSession.State.SYNCING -> "syncing"
                else -> if (socket != null) "connecting" else "offline"
            },
            name = session?.name,
        )
    }

    private val local = Slot(internet = false)
    private val internet = LinkedHashMap<String, Slot>()

    /** Image uploads and downloads, off the connection thread. */
    private val http = Executors.newFixedThreadPool(2) { r -> Thread(r, "hub-http").apply { isDaemon = true } }

    private val blobFetcher: (String) -> Unit = { id ->
        timer.execute {
            val online = (listOf(local) + internet.values).filter { it.session?.state == HubSession.State.ONLINE }
            for (slot in online) {
                val c = slot.client ?: continue
                val base = slot.session?.url ?: continue
                http.execute { fetchBlob(c, base, id) }
            }
        }
    }

    init {
        engine.addBlobFetcher(blobFetcher)
    }

    private val jsonType = "application/json".toMediaType()

    /** Uploads recent images the hub does not have yet, so others can fetch them on demand. */
    private fun uploadBlobs(client: OkHttpClient, base: String) {
        try {
            val ids = engine.store.blobIds(200)
            if (ids.isEmpty()) return
            val body = Json.obj("ids" to Json.Arr(ids.map(Json::Str))).stringify().toRequestBody(jsonType)
            val missing = client.newCall(Request.Builder().url("$base/api/blobs/missing").post(body).build()).execute().use { r ->
                if (!r.isSuccessful) return
                ((Json.parse(r.body!!.string()) as Json.Obj)["missing"] as? Json.Arr)?.items?.mapNotNull { (it as? Json.Str)?.value }
            } ?: return
            for (id in missing) {
                val (mime, data) = engine.store.getBlob(id) ?: continue
                client.newCall(Request.Builder().url("$base/api/blobs/$id").put(data.toRequestBody(mime.toMediaType())).build())
                    .execute().close()
            }
        } catch (e: Exception) {
            System.err.println("blob upload to $base failed: $e")
        }
    }

    private fun fetchBlob(client: OkHttpClient, base: String, id: String) {
        if (engine.store.hasBlob(id)) return
        try {
            client.newCall(Request.Builder().url("$base/api/blobs/$id").build()).execute().use { r ->
                if (!r.isSuccessful) return
                val mime = r.header("content-type")?.substringBefore(';')?.trim() ?: return
                engine.putBlob(id, mime, r.body!!.bytes())
            }
        } catch (e: Exception) {
            System.err.println("blob fetch from $base failed: $e")
        }
    }

    fun start(initial: Config) = timer.execute {
        config = initial
        local.restart()
        syncInternetSlots()
    }

    fun update(newConfig: Config) = timer.execute {
        val localChanged = newConfig.localCandidates != config.localCandidates
        config = newConfig
        if (localChanged || local.session == null) local.restart()
        syncInternetSlots()
        onChange()
    }

    /** Network changed (joined or left Wi-Fi): retry everything that is not connected now. */
    fun networkChanged() = timer.execute {
        if (local.session == null) local.restart()
        for (s in internet.values) if (s.session == null) s.restart()
    }

    private fun syncInternetSlots() {
        val wanted = if (config.internetEnabled) config.internetHubs.map(::wsUrl).toSet() else emptySet()
        for ((u, slot) in internet.toMap()) if (u !in wanted) {
            slot.stop()
            internet.remove(u)
        }
        for (u in wanted) if (u !in internet) {
            internet[u] = Slot(internet = true).also {
                it.url = u
                it.connect()
            }
        }
    }

    fun status(): List<Status> = (listOf(local) + internet.values).map { it.status() }

    fun shutdown() {
        engine.removeBlobFetcher(blobFetcher)
        http.shutdown()
        timer.execute {
            local.stop()
            internet.values.forEach { it.stop() }
        }
        timer.shutdown()
    }

    companion object {
        /** Accepts "host[:port]", "http(s)://host", or "ws(s)://host/ws". */
        fun wsUrl(addr: String): String {
            val a = addr.trim().trimEnd('/')
            return when {
                a.startsWith("ws://") || a.startsWith("wss://") -> if (a.endsWith("/ws")) a else "$a/ws"
                a.startsWith("https://") -> "wss://" + a.removePrefix("https://") + "/ws"
                a.startsWith("http://") -> "ws://" + a.removePrefix("http://") + "/ws"
                else -> "ws://$a/ws"
            }
        }

        fun httpUrl(ws: String): String =
            ws.removeSuffix("/ws").replaceFirst("wss://", "https://").replaceFirst("ws://", "http://")
    }
}
