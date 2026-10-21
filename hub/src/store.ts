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
