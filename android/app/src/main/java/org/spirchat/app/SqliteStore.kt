package org.spirchat.app

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.spirchat.engine.EnvelopeStore
import org.spirchat.engine.Stored

/** EnvelopeStore on SQLite: the phone's copy of everything it carries. */
class SqliteStore(context: Context) : SQLiteOpenHelper(context, "engine.db", null, 1), EnvelopeStore {

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
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {}

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
        writableDatabase.delete("envelopes", null, null)
        writableDatabase.delete("meta", null, null)
    }
}
