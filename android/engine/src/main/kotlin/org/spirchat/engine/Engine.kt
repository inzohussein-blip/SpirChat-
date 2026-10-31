package org.spirchat.engine

import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

data class Stored(val seq: Long, val id: String, val json: String)

/** Durable envelope storage. SQLite on Android (app module), in memory for tests. */
interface EnvelopeStore {
    fun contains(id: String): Boolean
    fun get(id: String): String?

    /** Returns the new local sequence number, or null if already stored. */
    fun put(id: String, kind: String, priority: Int, ts: Long, exp: Long, json: String): Long?
    fun since(seq: Long, limit: Int): List<Stored>

    /** IDs of live envelopes, most urgent first, then newest first. */
    fun ids(now: Long, limit: Int): List<String>
    fun delete(ids: Collection<String>)

    /** Drops expired envelopes, then the least urgent until under [maxBytes]. */
    fun prune(maxBytes: Long, now: Long): Int
    fun getMeta(key: String): String?
    fun setMeta(key: String, value: String)
    fun clear()
}

sealed class Accept {
    data class Added(val seq: Long) : Accept()
    object Duplicate : Accept()
    data class Rejected(val reason: String) : Accept()
}

/**
 * The sync engine shared by every transport: validates envelopes, stores them, and tells
 * sessions (nearby phones, hubs) and the UI about new ones.
 */
class Engine(val store: EnvelopeStore, val clock: () -> Long = System::currentTimeMillis) {

    fun interface Listener {
        /** [source] identifies the session it came from (null when published on this device). */
        fun onEnvelope(seq: Long, env: Json.Obj, json: String, source: String?)
    }

    private val listeners = CopyOnWriteArrayList<Listener>()

    /** Envelopes a hub has confirmed it holds; drives the "delivered" tick in the UI. */
    val delivered: MutableSet<String> = ConcurrentHashMap.newKeySet()

    fun addListener(l: Listener) = listeners.add(l)
    fun removeListener(l: Listener) = listeners.remove(l)

    fun accept(json: String, source: String?): Accept {
        val env = try {
            Json.parse(json) as? Json.Obj ?: return Accept.Rejected("not an object")
        } catch (e: IllegalArgumentException) {
            return Accept.Rejected(e.message ?: "invalid JSON")
        }
        return accept(env, source)
    }

    fun accept(env: Json.Obj, source: String?): Accept {
        val id = env.str("id") ?: return Accept.Rejected("missing id")
        if (store.contains(id)) return Accept.Duplicate
        Protocol.validate(env, clock())?.let { return Accept.Rejected(it) }
        val json = env.stringify()
        val seq = synchronized(this) {
            store.put(id, env.str("kind")!!, Protocol.priorityOf(env), env.long("ts")!!, env.long("exp")!!, json)
        } ?: return Accept.Duplicate
        for (l in listeners) {
            try {
                l.onEnvelope(seq, env, json, source)
            } catch (e: Exception) {
                System.err.println("listener failed: $e")
            }
        }
        return Accept.Added(seq)
    }

    fun carriedIds(limit: Int = Protocol.MAX_HAVE_IDS): List<String> = store.ids(clock(), limit)

    companion object {
        private const val GOSSIP_MAX_AGE = 3_600_000L

        /** Urgent or recent envelopes are pushed to connected peers immediately. */
        fun shouldGossip(env: Json.Obj, now: Long): Boolean =
            Protocol.priorityOf(env) <= 2 || now - (env.long("ts") ?: 0) < GOSSIP_MAX_AGE
    }
}

class MemoryStore : EnvelopeStore {
    private class Row(val seq: Long, val id: String, val priority: Int, val ts: Long, val exp: Long, val json: String)

    private val rows = LinkedHashMap<String, Row>()
    private val meta = HashMap<String, String>()
    private var nextSeq = 1L

    @Synchronized override fun contains(id: String) = rows.containsKey(id)
    @Synchronized override fun get(id: String) = rows[id]?.json

    @Synchronized
    override fun put(id: String, kind: String, priority: Int, ts: Long, exp: Long, json: String): Long? {
        if (rows.containsKey(id)) return null
        val seq = nextSeq++
        rows[id] = Row(seq, id, priority, ts, exp, json)
        return seq
    }

    @Synchronized
    override fun since(seq: Long, limit: Int) =
        rows.values.filter { it.seq > seq }.sortedBy { it.seq }.take(limit).map { Stored(it.seq, it.id, it.json) }

    @Synchronized
    override fun ids(now: Long, limit: Int) = rows.values.filter { it.exp > now }
        .sortedWith(compareBy<Row> { it.priority }.thenByDescending { it.ts }).take(limit).map { it.id }

    @Synchronized override fun delete(ids: Collection<String>) = ids.forEach { rows.remove(it) }

    @Synchronized
    override fun prune(maxBytes: Long, now: Long): Int {
        val before = rows.size
        rows.values.removeIf { it.exp <= now }
        var bytes = rows.values.sumOf { it.json.length.toLong() }
        for (r in rows.values.sortedWith(compareByDescending<Row> { it.priority }.thenBy { it.seq })) {
            if (bytes <= maxBytes) break
            rows.remove(r.id)
            bytes -= r.json.length
        }
        return before - rows.size
    }

    @Synchronized override fun getMeta(key: String) = meta[key]
    @Synchronized override fun setMeta(key: String, value: String) {
        meta[key] = value
    }

    @Synchronized override fun clear() {
        rows.clear()
        meta.clear()
    }
}
