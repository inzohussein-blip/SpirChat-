package org.spirchat.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.spirchat.engine.EnvelopeStore
import org.spirchat.engine.Stored

/** EnvelopeStore on SQLite: the phone's copy of everything it carries. */
class SqliteStore(context: Context) : SQLiteOpenHelper(context, "engine.db", null, 2), EnvelopeStore {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """CREATE TABLE envelopes (
                 seq INTEGER PRIMARY KEY AUTOINCREMENT,
                 id TEXT NOT NULL UNIQUE,
                 kind TEXT NOT NULL,
                 prio INTEGER NOT NULL,
                 ts INTEGER NOT NULL,
                 exp INTEGER NOT NULL,
                 size INTEGER NOT NULL,
                 json TEXT NOT NULL)""",
        )
        db.execSQL("CREATE INDEX envelopes_exp ON envelopes(exp)")
        db.execSQL("CREATE INDEX envelopes_prio ON envelopes(prio, ts)")
        db.execSQL("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        createBlobs(db)
    }

    private fun createBlobs(db: SQLiteDatabase) {
        db.execSQL(
            "CREATE TABLE blobs (id TEXT PRIMARY KEY, mime TEXT NOT NULL, size INTEGER NOT NULL, added INTEGER NOT NULL, data BLOB NOT NULL)",
        )
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        if (oldVersion < 2) createBlobs(db)
    }

    override fun contains(id: String): Boolean =
        readableDatabase.rawQuery("SELECT 1 FROM envelopes WHERE id = ?", arrayOf(id)).use { it.moveToFirst() }

    override fun get(id: String): String? =
        readableDatabase.rawQuery("SELECT json FROM envelopes WHERE id = ?", arrayOf(id)).use {
            if (it.moveToFirst()) it.getString(0) else null
        }

    override fun put(id: String, kind: String, priority: Int, ts: Long, exp: Long, json: String): Long? {
        val values = ContentValues().apply {
            put("id", id)
            put("kind", kind)
            put("prio", priority)
            put("ts", ts)
            put("exp", exp)
            put("size", json.length)
            put("json", json)
        }
        val seq = writableDatabase.insertWithOnConflict("envelopes", null, values, SQLiteDatabase.CONFLICT_IGNORE)
        return if (seq == -1L) null else seq
    }

    override fun since(seq: Long, limit: Int): List<Stored> =
        readableDatabase.rawQuery(
            "SELECT seq, id, json FROM envelopes WHERE seq > ? ORDER BY seq LIMIT ?",
            arrayOf(seq.toString(), limit.toString()),
        ).use { c ->
            buildList { while (c.moveToNext()) add(Stored(c.getLong(0), c.getString(1), c.getString(2))) }
        }

    override fun ids(now: Long, limit: Int): List<String> =
        readableDatabase.rawQuery(
            "SELECT id FROM envelopes WHERE exp > ? ORDER BY prio ASC, ts DESC LIMIT ?",
            arrayOf(now.toString(), limit.toString()),
        ).use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }

    override fun liveIdTs(now: Long): List<Pair<String, Long>> =
        readableDatabase.rawQuery("SELECT id, ts FROM envelopes WHERE exp > ?", arrayOf(now.toString())).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0) to c.getLong(1)) }
        }

    override fun idsOnDays(days: Collection<Long>, now: Long): List<String> = days.flatMap { d ->
        readableDatabase.rawQuery(
            "SELECT id FROM envelopes WHERE ts >= ? AND ts < ? AND exp > ?",
            arrayOf((d * 86_400_000L).toString(), ((d + 1) * 86_400_000L).toString(), now.toString()),
        ).use { c -> buildList { while (c.moveToNext()) add(c.getString(0)) } }
    }

    override fun putBlob(id: String, mime: String, data: ByteArray) {
        writableDatabase.insertWithOnConflict(
            "blobs", null,
            ContentValues().apply {
                put("id", id)
                put("mime", mime)
                put("size", data.size)
                put("added", System.currentTimeMillis())
                put("data", data)
            },
            SQLiteDatabase.CONFLICT_IGNORE,
        )
    }

    override fun getBlob(id: String): Pair<String, ByteArray>? =
        readableDatabase.rawQuery("SELECT mime, data FROM blobs WHERE id = ?", arrayOf(id)).use {
            if (it.moveToFirst()) it.getString(0) to it.getBlob(1) else null
        }

    override fun hasBlob(id: String): Boolean =
        readableDatabase.rawQuery("SELECT 1 FROM blobs WHERE id = ?", arrayOf(id)).use { it.moveToFirst() }

    override fun blobIds(limit: Int): List<String> =
        readableDatabase.rawQuery("SELECT id FROM blobs ORDER BY added DESC LIMIT ?", arrayOf(limit.toString())).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }

    override fun delete(ids: Collection<String>) {
        val db = writableDatabase
        db.beginTransaction()
        try {
            ids.forEach { db.delete("envelopes", "id = ?", arrayOf(it)) }
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
    }

    override fun prune(maxBytes: Long, now: Long): Int {
        val db = writableDatabase
        var removed = db.delete("envelopes", "exp <= ?", arrayOf(now.toString()))
        // Keep images within a quarter of the budget; they can be fetched again on demand.
        val blobBudget = maxBytes / 4
        var blobBytes = db.rawQuery("SELECT COALESCE(SUM(size), 0) FROM blobs", null).use { it.moveToFirst(); it.getLong(0) }
        while (blobBytes > blobBudget) {
            val oldest = db.rawQuery("SELECT id, size FROM blobs ORDER BY added ASC LIMIT 50", null).use { c ->
                buildList { while (c.moveToNext()) add(c.getString(0) to c.getLong(1)) }
            }
            if (oldest.isEmpty()) break
            for ((id, size) in oldest) {
                if (blobBytes <= blobBudget) break
                db.delete("blobs", "id = ?", arrayOf(id))
                blobBytes -= size
            }
        }
        var bytes = db.rawQuery("SELECT COALESCE(SUM(size), 0) FROM envelopes", null).use { it.moveToFirst(); it.getLong(0) }
        while (bytes > maxBytes) {
            val batch = db.rawQuery("SELECT seq, size FROM envelopes ORDER BY prio DESC, seq ASC LIMIT 200", null).use { c ->
                buildList { while (c.moveToNext()) add(c.getLong(0) to c.getLong(1)) }
            }
            if (batch.isEmpty()) break
            for ((seq, size) in batch) {
                if (bytes <= maxBytes) break
                db.delete("envelopes", "seq = ?", arrayOf(seq.toString()))
                bytes -= size
                removed++
            }
        }
        return removed
    }

    override fun getMeta(key: String): String? =
        readableDatabase.rawQuery("SELECT value FROM meta WHERE key = ?", arrayOf(key)).use {
            if (it.moveToFirst()) it.getString(0) else null
        }

    override fun setMeta(key: String, value: String) {
        writableDatabase.insertWithOnConflict(
            "meta", null,
            ContentValues().apply {
                put("key", key)
                put("value", value)
            },
            SQLiteDatabase.CONFLICT_REPLACE,
        )
    }

    override fun clear() {
        writableDatabase.delete("blobs", null, null)
        writableDatabase.delete("envelopes", null, null)
        writableDatabase.delete("meta", null, null)
    }
}
