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

    /** (id, ts) of every live envelope, for sync summaries. */
    fun liveIdTs(now: Long): List<Pair<String, Long>>

    /** Live envelope IDs created on the given UTC days. */
    fun idsOnDays(days: Collection<Long>, now: Long): List<String>

    fun putBlob(id: String, mime: String, data: ByteArray)
    fun getBlob(id: String): Pair<String, ByteArray>?
    fun hasBlob(id: String): Boolean
    /** Most recently stored image IDs. */
    fun blobIds(limit: Int): List<String>
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

    /**
     * Spray-and-wait for private messages: each DM is handed to a limited number of nearby
     * phones (more if written here, fewer if relayed) instead of flooding every phone met.
     * Hubs always get it.
     */
    private val dmCopies = ConcurrentHashMap<String, Int>()

    /** Who asks for images this device lacks (nearby phones, hubs). */
    private val blobFetchers = CopyOnWriteArrayList<(String) -> Unit>()
    private val blobListeners = CopyOnWriteArrayList<(String) -> Unit>()

    fun addListener(l: Listener) = listeners.add(l)
    fun removeListener(l: Listener) = listeners.remove(l)
    fun addBlobFetcher(f: (String) -> Unit) = blobFetchers.add(f)
    fun removeBlobFetcher(f: (String) -> Unit) = blobFetchers.remove(f)
    fun addBlobListener(l: (String) -> Unit) = blobListeners.add(l)

    /** True if one more nearby phone may receive this DM (and counts it). */
    fun takeDmCopy(id: String): Boolean {
        var allowed = false
        dmCopies.compute(id) { _, left ->
            val n = left ?: RELAY_DM_COPIES
            allowed = n > 0
            if (allowed) n - 1 else 0
        }
        return allowed
    }

    /** Stores an image if its bytes hash to [id]; returns false otherwise. */
    fun putBlob(id: String, mime: String, data: ByteArray): Boolean {
        if (mime !in MEDIA_TYPES || data.size > MAX_MEDIA_BYTES) return false
        if (B64u.encode(Protocol.sha256(data)) != id) return false
        if (store.hasBlob(id)) return true
        store.putBlob(id, mime, data)
        blobListeners.forEach { it(id) }
        return true
    }

    /** Asks every connected phone and hub for an image this device does not have. */
    fun requestBlob(id: String) {
        if (!store.hasBlob(id)) blobFetchers.forEach { it(id) }
    }

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
        if (env.str("kind") == "dm") dmCopies[id] = if (source == null) OWN_DM_COPIES else RELAY_DM_COPIES
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
        const val OWN_DM_COPIES = 6
        const val RELAY_DM_COPIES = 2
        const val MAX_MEDIA_BYTES = 1_000_000
        val MEDIA_TYPES = setOf("image/webp", "image/jpeg")

        /** Urgent or recent envelopes are pushed to connected peers immediately. */
        fun shouldGossip(env: Json.Obj, now: Long): Boolean =
            Protocol.priorityOf(env) <= 2 || now - (env.long("ts") ?: 0) < GOSSIP_MAX_AGE
    }
}

class MemoryStore : EnvelopeStore {
    private class Row(val seq: Long, val id: String, val priority: Int, val ts: Long, val exp: Long, val json: String)

    private val rows = LinkedHashMap<String, Row>()
    private val blobs = LinkedHashMap<String, Pair<String, ByteArray>>()
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
    override fun liveIdTs(now: Long) = rows.values.filter { it.exp > now }.map { it.id to it.ts }

    @Synchronized
    override fun idsOnDays(days: Collection<Long>, now: Long) =
        rows.values.filter { it.exp > now && Math.floorDiv(it.ts, Summary.DAY) in days }.map { it.id }

    @Synchronized override fun putBlob(id: String, mime: String, data: ByteArray) {
        blobs[id] = mime to data
    }

    @Synchronized override fun getBlob(id: String) = blobs[id]
    @Synchronized override fun hasBlob(id: String) = blobs.containsKey(id)
    @Synchronized override fun blobIds(limit: Int) = blobs.keys.reversed().take(limit)

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
        blobs.clear()
    }
}
