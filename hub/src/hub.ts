import { type Envelope, validateEnvelope } from '@spirchat/protocol';
import type { Config } from './config.ts';
import { Store } from './store.ts';

export type AcceptResult = { ok: true; seq: number | null } | { ok: false; error: string };

type Listener = (seq: number, env: Envelope) => void;

/** Hub core: validates and stores envelopes and notifies live subscribers. */
export class Hub {
  readonly store: Store;
  readonly config: Config;
  private listeners = new Set<Listener>();

  constructor(config: Config, store?: Store) {
    this.config = config;
    this.store = store ?? new Store(`${config.dataDir}/hub.db`);
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
