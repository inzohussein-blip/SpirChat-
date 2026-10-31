import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { type Envelope, envelopeBytes, priorityOf } from '@spirchat/protocol';

export interface StoredEnvelope {
  seq: number;
  env: Envelope;
}

interface Row {
  seq: number;
  json: string;
}

/** Durable envelope store. Each insert gets a hub-local sequence number used as a sync cursor. */
export class Store {
  readonly db: DatabaseSync;
  readonly hubId: string;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS envelopes (
        seq    INTEGER PRIMARY KEY AUTOINCREMENT,
        id     TEXT NOT NULL UNIQUE,
        kind   TEXT NOT NULL,
        author TEXT,
        tag    TEXT,
        prio   INTEGER NOT NULL,
        ts     INTEGER NOT NULL,
        exp    INTEGER NOT NULL,
        size   INTEGER NOT NULL,
        json   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS envelopes_exp ON envelopes(exp);
      CREATE INDEX IF NOT EXISTS envelopes_prio ON envelopes(prio, seq);
      CREATE INDEX IF NOT EXISTS envelopes_author ON envelopes(author, kind, ts);
      CREATE TABLE IF NOT EXISTS blobs (
        id   TEXT PRIMARY KEY,
        mime TEXT NOT NULL,
        size INTEGER NOT NULL,
        exp  INTEGER NOT NULL,
        data BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS peers (url TEXT PRIMARY KEY, hub_id TEXT, cursor INTEGER NOT NULL DEFAULT 0);
    `);
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'hub_id'`).get() as
      | { value: string }
      | undefined;
    this.hubId = row?.value ?? randomUUID();
    if (!row) this.db.prepare(`INSERT INTO meta (key, value) VALUES ('hub_id', ?)`).run(this.hubId);
  }

  /** Returns the new sequence number, or null if the envelope was already stored. */
  insert(env: Envelope): number | null {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO envelopes (id, kind, author, tag, prio, ts, exp, size, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        env.id,
        env.kind,
        env.author ?? null,
        env.to ?? null,
        priorityOf(env),
        env.ts,
        env.exp,
        envelopeBytes(env),
        JSON.stringify(env),
      );
    return res.changes ? Number(res.lastInsertRowid) : null;
  }

  missing(ids: string[]): string[] {
    const stmt = this.db.prepare(`SELECT 1 FROM envelopes WHERE id = ?`);
    return ids.filter((id) => !stmt.get(id));
  }

  /** Envelopes after `since`, optionally restricted to a priority range, in sequence order. */
  since(since: number, limit: number, prio: [number, number] = [0, 99]): StoredEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT seq, json FROM envelopes WHERE seq > ? AND prio BETWEEN ? AND ? AND exp > ?
         ORDER BY seq LIMIT ?`,
      )
      .all(since, prio[0], prio[1], Date.now(), limit) as unknown as Row[];
    return rows.map((r) => ({ seq: r.seq, env: JSON.parse(r.json) as Envelope }));
  }

  /** (id, ts) of live envelopes, for building a sync summary. */
  liveIds(now = Date.now()): { id: string; ts: number }[] {
    return this.db.prepare(`SELECT id, ts FROM envelopes WHERE exp > ?`).all(now) as unknown as {
      id: string;
      ts: number;
    }[];
  }

  /** Live envelope IDs created on the given UTC days, for answering a summary diff. */
  idsOnDays(days: number[], now = Date.now()): string[] {
    const stmt = this.db.prepare(`SELECT id FROM envelopes WHERE ts >= ? AND ts < ? AND exp > ?`);
    return days.flatMap((d) => (stmt.all(d * 86_400_000, (d + 1) * 86_400_000, now) as { id: string }[]).map((r) => r.id));
  }

  /** How many envelopes of `kind` the author created within [from, to). */
  countByAuthor(author: string, kind: string, from: number, to: number): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM envelopes WHERE author = ? AND kind = ? AND ts >= ? AND ts < ?`)
      .get(author, kind, from, to) as { c: number };
    return row.c;
  }

  deleteByAuthor(author: string): number {
    return Number(this.db.prepare(`DELETE FROM envelopes WHERE author = ?`).run(author).changes);
  }

  putBlob(id: string, mime: string, data: Uint8Array, exp: number): void {
    this.db
      .prepare(
        `INSERT INTO blobs (id, mime, size, exp, data) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET exp = MAX(exp, excluded.exp)`,
      )
      .run(id, mime, data.length, exp, data);
  }

  getBlob(id: string): { mime: string; data: Uint8Array } | undefined {
    return this.db.prepare(`SELECT mime, data FROM blobs WHERE id = ?`).get(id) as
      | { mime: string; data: Uint8Array }
      | undefined;
  }

  missingBlobs(ids: string[]): string[] {
    const stmt = this.db.prepare(`SELECT 1 FROM blobs WHERE id = ?`);
    return ids.filter((id) => !stmt.get(id));
  }

  maxSeq(): number {
    const row = this.db.prepare(`SELECT MAX(seq) AS m FROM envelopes`).get() as { m: number | null };
    return row.m ?? 0;
  }

  stats(): { count: number; bytes: number; byKind: Record<string, number> } {
    const total = this.db.prepare(`SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS b FROM envelopes`).get() as {
      c: number;
      b: number;
    };
    const kinds = this.db.prepare(`SELECT kind, COUNT(*) AS c FROM envelopes GROUP BY kind`).all() as unknown as {
      kind: string;
      c: number;
    }[];
    return { count: total.c, bytes: total.b, byKind: Object.fromEntries(kinds.map((k) => [k.kind, k.c])) };
  }

  /**
   * Drops expired envelopes, then, while over `maxBytes`, the least urgent
   * and oldest ones, so text and SOS survive when storage runs out.
   */
  prune(maxBytes: number, now = Date.now()): number {
    let removed = Number(this.db.prepare(`DELETE FROM envelopes WHERE exp <= ?`).run(now).changes);
    this.db.prepare(`DELETE FROM blobs WHERE exp <= ?`).run(now);
    // Images are the bulk of storage and can be re-fetched from phones that still hold them.
    const blobBytes = () =>
      (this.db.prepare(`SELECT COALESCE(SUM(size), 0) AS b FROM blobs`).get() as { b: number }).b;
    let total = this.stats().bytes + blobBytes();
    while (total > maxBytes) {
      const oldest = this.db.prepare(`SELECT id, size FROM blobs ORDER BY exp ASC LIMIT 100`).all() as {
        id: string;
        size: number;
      }[];
      if (!oldest.length) break;
      for (const b of oldest) {
        if (total <= maxBytes) break;
        this.db.prepare(`DELETE FROM blobs WHERE id = ?`).run(b.id);
        total -= b.size;
      }
    }
    let { bytes } = this.stats();
    const victims = this.db.prepare(`SELECT seq, size FROM envelopes ORDER BY prio DESC, seq ASC LIMIT 200`);
    const del = this.db.prepare(`DELETE FROM envelopes WHERE seq = ?`);
    while (bytes > maxBytes) {
      const batch = victims.all() as unknown as { seq: number; size: number }[];
      if (!batch.length) break;
      for (const v of batch) {
        if (bytes <= maxBytes) break;
        del.run(v.seq);
        bytes -= v.size;
        removed++;
      }
    }
    return removed;
  }

  peerCursor(url: string): { hubId: string | null; cursor: number } {
    const row = this.db.prepare(`SELECT hub_id, cursor FROM peers WHERE url = ?`).get(url) as
      | { hub_id: string | null; cursor: number }
      | undefined;
    return { hubId: row?.hub_id ?? null, cursor: row?.cursor ?? 0 };
  }

  setPeerCursor(url: string, hubId: string, cursor: number): void {
    this.db
      .prepare(
        `INSERT INTO peers (url, hub_id, cursor) VALUES (?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET hub_id = excluded.hub_id, cursor = excluded.cursor`,
      )
      .run(url, hubId, cursor);
  }

  close(): void {
    this.db.close();
  }
}
