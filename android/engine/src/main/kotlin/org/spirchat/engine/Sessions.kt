package org.spirchat.engine

/** A bidirectional text channel: a Nearby link to a phone or a WebSocket to a hub. */
fun interface Link {
    fun send(text: String)
}

private fun idList(ids: List<String>) = Json.Arr(ids.map(Json::Str))

private fun stringList(v: Json?): List<String> =
    (v as? Json.Arr)?.items?.mapNotNull { (it as? Json.Str)?.value }?.take(Protocol.MAX_HAVE_IDS) ?: emptyList()

/**
 * Symmetric phone-to-phone sync (PeerMessage in packages/protocol/src/wire.ts): both sides
 * send `have` on connect, answer `want` with envelopes, and push new urgent envelopes live.
 */
class PeerSession(private val engine: Engine, val peerId: String, private val link: Link) {
    private val source = "peer:$peerId"

    private val gossip = Engine.Listener { _, env, json, from ->
        if (from != source && Engine.shouldGossip(env, engine.clock())) send("env", json)
    }

    private fun send(type: String, json: String) = link.send("""{"t":"$type","env":$json}""")

    fun open() {
        engine.addListener(gossip)
        link.send(Json.obj("t" to Json.str("have"), "ids" to idList(engine.carriedIds())).stringify())
    }

    fun close() {
        engine.removeListener(gossip)
    }

    fun receive(text: String) {
        val m = try {
            Json.parse(text) as? Json.Obj
        } catch (_: IllegalArgumentException) {
            null
        } ?: return
        when (m.str("t")) {
            "have" -> {
                val want = stringList(m["ids"]).filterNot(engine.store::contains)
                link.send(Json.obj("t" to Json.str("want"), "ids" to idList(want)).stringify())
            }
            "want" -> for (id in stringList(m["ids"])) engine.store.get(id)?.let { send("env", it) }
            "env" -> (m["env"] as? Json.Obj)?.let { engine.accept(it, source) }
        }
    }
}

/**
 * Client side of the hub protocol (ClientMessage/HubMessage in wire.ts). Catches up from the
 * stored cursor for this hub, offers everything carried, and forwards new envelopes live.
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
                engine.addListener(forward)
                offered = engine.carriedIds()
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
