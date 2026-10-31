import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { areaOf, areasOverlap, type Envelope, validateEnvelope } from '@spirchat/protocol';
import type { Config } from './config.ts';
import { Store } from './store.ts';

export type AcceptResult = { ok: true; seq: number | null } | { ok: false; error: string };

type Listener = (seq: number, env: Envelope) => void;

/** Hub core: validates and stores envelopes and notifies live subscribers. */
export class Hub {
  readonly store: Store;
  readonly config: Config;
  private listeners = new Set<Listener>();
  private denied = new Set<string>();
  private denyFileMtime = 0;

  constructor(config: Config, store?: Store) {
    this.config = config;
    this.store = store ?? new Store(`${config.dataDir}/hub.db`);
    this.reloadDenyList();
  }

  /**
   * Operators block authors through DENY_KEYS or DATA_DIR/deny.txt (one ID per line, '#'
   * comments). Edits to the file apply within a minute, and existing content is removed.
   */
  reloadDenyList(): void {
    const file = join(this.config.dataDir, 'deny.txt');
    const keys = new Set(this.config.denyKeys);
    if (existsSync(file)) {
      this.denyFileMtime = statSync(file).mtimeMs;
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        const k = line.replace(/#.*/, '').trim();
        if (k) keys.add(k);
      }
    }
    for (const k of keys) if (!this.denied.has(k)) this.store.deleteByAuthor(k);
    this.denied = keys;
  }

  denyFileChanged(): boolean {
    const file = join(this.config.dataDir, 'deny.txt');
    return existsSync(file) ? statSync(file).mtimeMs !== this.denyFileMtime : this.denyFileMtime !== 0;
  }

  get id(): string {
    return this.store.hubId;
  }

  /** `seq` is null when the envelope was a duplicate. */
  accept(input: unknown): AcceptResult {
    const v = validateEnvelope(input);
    if (!v.ok) return v;
    const env = input as Envelope;
    if (env.kind === 'alert' && !this.config.alertKeys.includes(env.author!)) {
      return { ok: false, error: 'author not allowed to publish alerts' };
    }
    if (env.author && this.denied.has(env.author)) return { ok: false, error: 'author blocked on this hub' };
    if (!areasOverlap(this.config.area || undefined, areaOf(env))) return { ok: false, error: 'outside this hub area' };
    const quota = this.config.quotas[env.kind];
    const isNew = this.store.missing([env.id]).length === 1;
    if (env.author && quota !== undefined && isNew) {
      // Count per UTC day of the envelope's own timestamp, so backdating does not dodge it.
      const day = Math.floor(env.ts / 86_400_000) * 86_400_000;
      if (this.store.countByAuthor(env.author, env.kind, day, day + 86_400_000) >= quota) {
        return { ok: false, error: 'daily quota reached' };
      }
    }
    const seq = this.store.insert(env);
    if (seq !== null) for (const l of this.listeners) l(seq, env);
    return { ok: true, seq };
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Fixed-window counter keyed by an arbitrary string (author ID, connection, IP). */
export class RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();
  private limit: number;
  private windowMs: number;

  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  allow(key: string, now = Date.now()): boolean {
    let w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      w = { start: now, count: 0 };
      this.windows.set(key, w);
      if (this.windows.size > 10_000) this.sweep(now);
    }
    return ++w.count <= this.limit;
  }

  private sweep(now: number) {
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}
