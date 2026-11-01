package org.spirchat.engine

/** A bidirectional text channel: a Nearby link to a phone or a WebSocket to a hub. */
fun interface Link {
    fun send(text: String)
}

private fun idList(ids: Collection<String>) = Json.Arr(ids.map(Json::Str))

private fun stringList(v: Json?): List<String> =
    (v as? Json.Arr)?.items?.mapNotNull { (it as? Json.Str)?.value }?.take(Protocol.MAX_HAVE_IDS) ?: emptyList()

private fun Engine.summary() = Summary.summarize(store.liveIdTs(clock()))

/**
 * Symmetric phone-to-phone sync (PeerMessage in packages/protocol/src/wire.ts): both sides send
 * a `sum` on connect, then `have` for the days that differ; the other answers `want`. New urgent
 * envelopes are pushed live. Images are exchanged on request (`bwant` / `blob`).
 */
class PeerSession(private val engine: Engine, val peerId: String, private val link: Link) {
    private val source = "peer:$peerId"

    private val gossip = Engine.Listener { _, env, json, from ->
        if (from != source && Engine.shouldGossip(env, engine.clock())) sendEnv(env.str("id")!!, env.str("kind"), json)
    }

    private val fetcher: (String) -> Unit = { id ->
        link.send(Json.obj("t" to Json.str("bwant"), "ids" to idList(listOf(id))).stringify())
    }

    private fun sendEnv(id: String, kind: String?, json: String) {
        if (kind == "dm" && !engine.takeDmCopy(id)) return
        link.send("""{"t":"env","env":$json}""")
    }

    fun open() {
        engine.addListener(gossip)
        engine.addBlobFetcher(fetcher)
        link.send(Json.obj("t" to Json.str("sum"), "buckets" to Summary.toJson(engine.summary())).stringify())
    }

    fun close() {
        engine.removeListener(gossip)
        engine.removeBlobFetcher(fetcher)
    }

    fun receive(text: String) {
        val m = try {
            Json.parse(text) as? Json.Obj
        } catch (_: IllegalArgumentException) {
            null
        } ?: return
        when (m.str("t")) {
            "sum" -> {
                val theirs = Summary.fromJson(m["buckets"]) ?: return
                val days = Summary.differingDays(engine.summary(), theirs)
                if (days.isEmpty()) return
                val ids = engine.store.idsOnDays(days, engine.clock()).take(Protocol.MAX_HAVE_IDS)
                link.send(Json.obj("t" to Json.str("have"), "ids" to idList(ids)).stringify())
            }
            "have" -> {
                val want = stringList(m["ids"]).filterNot(engine.store::contains)
                if (want.isNotEmpty()) link.send(Json.obj("t" to Json.str("want"), "ids" to idList(want)).stringify())
            }
            "want" -> for (id in stringList(m["ids"])) {
                val json = engine.store.get(id) ?: continue
                val kind = (Json.parse(json) as? Json.Obj)?.str("kind")
                sendEnv(id, kind, json)
            }
            "env" -> (m["env"] as? Json.Obj)?.let { engine.accept(it, source) }
            "bwant" -> for (id in stringList(m["ids"]).take(20)) {
                val (mime, data) = engine.store.getBlob(id) ?: continue
                link.send(
                    Json.obj(
                        "t" to Json.str("blob"),
                        "id" to Json.str(id),
                        "mime" to Json.str(mime),
                        "data" to Json.str(java.util.Base64.getEncoder().encodeToString(data)),
                    ).stringify(),
                )
            }
            "blob" -> {
                val id = m.str("id") ?: return
                val mime = m.str("mime") ?: return
                val data = m.str("data")?.let {
                    try {
                        java.util.Base64.getDecoder().decode(it)
                    } catch (_: IllegalArgumentException) {
                        null
                    }
                } ?: return
                engine.putBlob(id, mime, data)
            }
        }
    }
}

/**
 * Client side of the hub protocol (ClientMessage/HubMessage in wire.ts). Catches up from the
 * stored cursor for this hub, compares summaries, offers what the hub lacks, and forwards new
 * envelopes live.
 */
class HubSession(
    private val engine: Engine,
    val url: String,
    private val link: Link,
    private val onChange: (HubSession) -> Unit = {},
) {
    enum class State { CONNECTING, SYNCING, ONLINE }

    @Volatile var state = State.CONNECTING
        private set
    @Volatile var hubId: String? = null
        private set
    @Volatile var name: String? = null
        private set

    private val source = "hub:$url"
    private var offered: List<String> = emptyList()

    private val forward = Engine.Listener { _, _, json, from ->
        if (from != source) link.send("""{"t":"publish","env":$json}""")
    }

    private fun cursorKey() = "hubcursor:$url"

    fun open() {
        val saved = engine.store.getMeta(cursorKey())?.split('|')
        val hello = Json.obj("t" to Json.str("hello")).fields.toMutableMap()
        if (saved != null && saved.size == 2) {
            hello["hubId"] = Json.str(saved[0])
            saved[1].toLongOrNull()?.let { hello["since"] = Json.num(it) }
        }
        link.send(Json.Obj(hello).stringify())
    }

    fun close() {
        engine.removeListener(forward)
    }

    fun receive(text: String) {
        val m = try {
            Json.parse(text) as? Json.Obj
        } catch (_: IllegalArgumentException) {
            null
        } ?: return
        when (m.str("t")) {
            "welcome" -> {
                hubId = m.str("hubId")
                name = m.str("name")
                val keys = stringList(m["alertKeys"])
                if (keys.isNotEmpty()) {
                    val known = engine.store.getMeta("alertKeys")?.split(',')?.filter { it.isNotEmpty() }.orEmpty()
                    engine.store.setMeta("alertKeys", (known + keys).distinct().joinToString(","))
                }
                state = State.SYNCING
                onChange(this)
            }
            "env" -> (m["env"] as? Json.Obj)?.let { env ->
                env.str("id")?.let(engine.delivered::add)
                engine.accept(env, source)
            }
            "synced" -> {
                val seq = m.long("seq")
                if (hubId != null && seq != null) engine.store.setMeta(cursorKey(), "$hubId|$seq")
                state = State.ONLINE
                engine.noteHubContact()
                engine.addListener(forward)
                link.send(Json.obj("t" to Json.str("sum"), "buckets" to Summary.toJson(engine.summary())).stringify())
                onChange(this)
            }
            "sum" -> {
                val theirs = Summary.fromJson(m["buckets"]) ?: return
                val now = engine.clock()
                val days = Summary.differingDays(engine.summary(), theirs).toSet()
                // Days that match are fully held by the hub already.
                engine.store.liveIdTs(now).filter { Math.floorDiv(it.second, Summary.DAY) !in days }
                    .forEach { engine.delivered.add(it.first) }
                offered = engine.store.idsOnDays(days, now).take(Protocol.MAX_HAVE_IDS)
                if (offered.isNotEmpty()) link.send(Json.obj("t" to Json.str("have"), "ids" to idList(offered)).stringify())
                onChange(this)
            }
            "want" -> {
                val wanted = stringList(m["ids"]).toSet()
                engine.delivered.addAll(offered.filterNot(wanted::contains))
                for (id in wanted) engine.store.get(id)?.let { link.send("""{"t":"publish","env":$it}""") }
                onChange(this)
            }
            "ack" -> if (m["ok"] == Json.Bool(true)) {
                m.str("id")?.let(engine.delivered::add)
                onChange(this)
            }
        }
    }
}
