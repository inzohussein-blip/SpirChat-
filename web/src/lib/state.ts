import { useEffect, useState } from 'preact/hooks';
import {
  type BodyByKind,
  createDirect,
  createSigned,
  type DirectMessage,
  type Envelope,
  fromB64u,
  b64u,
  type HubMessage,
  type Identity,
  identityFromSeed,
  mailboxTag,
  MAX_HAVE_IDS,
  newIdentity,
  openDirect,
  priorityOf,
  type ProfileBody,
  type SignedKind,
  validateEnvelope,
} from '@spirchat/protocol';
import * as db from './db.ts';

export type HubStatus = 'offline' | 'connecting' | 'syncing' | 'online';

export interface ChatMessage extends DirectMessage {
  id: string;
  mine: boolean;
}

class AppState {
  me: Identity | null = null;
  myTag = '';
  envelopes = new Map<string, Envelope>();
  /** Decrypted DMs to and from me, keyed by envelope id. */
  messages = new Map<string, ChatMessage>();
  alertKeys = new Set<string>();
  /** Envelope IDs the current hub has confirmed it holds. */
  atHub = new Set<string>();
  hub: { status: HubStatus; name?: string; hubId?: string } = { status: 'offline' };
  version = 0;

  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private pending: Envelope[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 1000;
  private offered: string[] = [];

  changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async load() {
    const seed = await db.getMeta<string>('seed');
    if (seed) this.setIdentity(identityFromSeed(fromB64u(seed)));
    this.alertKeys = new Set((await db.getMeta<string[]>('alertKeys')) ?? []);
    const now = Date.now();
    const expired: string[] = [];
    for (const env of await db.allEnvelopes()) {
      if (env.exp <= now) expired.push(env.id);
      else this.ingest(env);
    }
    if (expired.length) void db.deleteEnvelopes(expired);
    for (const s of await db.allSent()) this.messages.set(s.id, { ...s, mine: true });
    this.changed();
    this.connect();
  }

  private setIdentity(id: Identity) {
    this.me = id;
    this.myTag = mailboxTag(id.id);
  }

  async createAccount(name: string, seed?: Uint8Array) {
    const id = seed ? identityFromSeed(seed) : newIdentity();
    await db.setMeta('seed', b64u(id.seed));
    this.setIdentity(id);
    // Re-scan held envelopes: a restored identity may already have mail waiting.
    for (const env of this.envelopes.values()) this.ingest(env);
    if (name) this.publishSigned('profile', { name });
    this.changed();
  }

  backupCode(): string {
    return this.me ? b64u(this.me.seed) : '';
  }

  async wipe() {
    this.ws?.close();
    await db.wipeAll();
    location.reload();
  }

  /** Adds an already-validated envelope to memory. Returns false if known. */
  private ingest(env: Envelope): boolean {
    if (this.envelopes.has(env.id)) return false;
    this.envelopes.set(env.id, env);
    if (this.me && env.kind === 'dm' && env.to === this.myTag) {
      const m = openDirect(this.me, env);
      if (m) this.messages.set(env.id, { ...m, id: env.id, mine: false });
    }
    return true;
  }

  private receive(env: Envelope) {
    if (this.envelopes.has(env.id) || !validateEnvelope(env).ok) return;
    this.ingest(env);
    this.pending.push(env);
    this.flushTimer ??= setTimeout(() => {
      this.flushTimer = null;
      const batch = this.pending;
      this.pending = [];
      void db.putEnvelopes(batch);
      this.changed();
    }, 200);
  }

  private async publish(env: Envelope) {
    this.ingest(env);
    await db.putEnvelopes([env]);
    this.send({ t: 'publish', env });
    this.changed();
  }

  publishSigned<K extends SignedKind>(kind: K, body: BodyByKind[K]) {
    if (!this.me) throw new Error('no identity');
    return this.publish(createSigned(this.me, kind, body));
  }

  async sendDirect(to: string, content: { text: string; image?: string }) {
    if (!this.me) throw new Error('no identity');
    const env = createDirect(this.me, to, content);
    const sent: db.SentMessage = { id: env.id, from: this.me.id, to, ts: env.ts, ...content };
    this.messages.set(env.id, { ...sent, mine: true });
    await db.putSent(sent);
    await this.publish(env);
  }

  // --- hub connection ---------------------------------------------------

  private send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private setHub(h: Partial<AppState['hub']>) {
    this.hub = { ...this.hub, ...h };
    this.changed();
  }

  connect() {
    if (this.ws) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    this.setHub({ status: 'connecting' });

    ws.onopen = async () => {
      this.retryMs = 1000;
      const cursor = await db.getMeta<{ hubId: string; seq: number }>('cursor');
      ws.send(JSON.stringify({ t: 'hello', hubId: cursor?.hubId, since: cursor?.seq }));
    };
    ws.onmessage = (e) => this.onHubMessage(JSON.parse(String(e.data)) as HubMessage);
    ws.onclose = () => {
      this.ws = null;
      this.atHub.clear();
      this.setHub({ status: 'offline' });
      setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
    };
  }

  private onHubMessage(m: HubMessage) {
    switch (m.t) {
      case 'welcome':
        for (const k of m.alertKeys) this.alertKeys.add(k);
        void db.setMeta('alertKeys', [...this.alertKeys]);
        this.setHub({ status: 'syncing', name: m.name, hubId: m.hubId });
        return;
      case 'env':
        this.atHub.add(m.env.id);
        this.receive(m.env);
        return;
      case 'synced':
        if (this.hub.hubId) void db.setMeta('cursor', { hubId: this.hub.hubId, seq: m.seq });
        this.setHub({ status: 'online' });
        this.offerCarried();
        return;
      case 'want': {
        const wanted = new Set(m.ids);
        for (const id of this.offered) if (!wanted.has(id)) this.atHub.add(id);
        this.changed();
        for (const id of m.ids) {
          const env = this.envelopes.get(id);
          if (env) this.send({ t: 'publish', env });
        }
        return;
      }
      case 'ack':
        if (m.ok) {
          this.atHub.add(m.id);
          this.changed();
        } else console.warn('hub rejected', m.id, m.error);
        return;
    }
  }

  /** Offer everything we carry (urgent first); the hub asks for what it lacks. */
  private offerCarried() {
    const now = Date.now();
    const ids = [...this.envelopes.values()]
      .filter((e) => e.exp > now)
      .sort((a, b) => priorityOf(a) - priorityOf(b) || b.ts - a.ts)
      .slice(0, MAX_HAVE_IDS)
      .map((e) => e.id);
    this.offered = ids;
    if (ids.length) this.send({ t: 'have', ids });
  }

  // --- derived views ------------------------------------------------------

  ofKind<K extends Envelope['kind']>(kind: K): Envelope[] {
    return [...this.envelopes.values()].filter((e) => e.kind === kind).sort((a, b) => b.ts - a.ts);
  }

  profiles(): Map<string, ProfileBody & { ts: number }> {
    const out = new Map<string, ProfileBody & { ts: number }>();
    for (const e of this.envelopes.values()) {
      if (e.kind !== 'profile') continue;
      const prev = out.get(e.author!);
      if (!prev || prev.ts < e.ts) out.set(e.author!, { ...(e.body as ProfileBody), ts: e.ts });
    }
    return out;
  }

  nameOf(id: string): string {
    return this.profiles().get(id)?.name ?? `${id.slice(0, 6)}…`;
  }

  /** Conversations keyed by the other person's ID, newest message last. */
  conversations(): Map<string, ChatMessage[]> {
    const out = new Map<string, ChatMessage[]>();
    for (const m of this.messages.values()) {
      const other = m.mine ? m.to : m.from;
      const list = out.get(other) ?? [];
      list.push(m);
      out.set(other, list);
    }
    for (const list of out.values()) list.sort((a, b) => a.ts - b.ts);
    return out;
  }

  isOfficial(env: Envelope): boolean {
    return env.kind === 'alert' && this.alertKeys.has(env.author!);
  }
}

export const app = new AppState();

/** Re-render the calling component whenever app state changes. */
export function useApp(): AppState {
  const [, setV] = useState(0);
  useEffect(() => app.subscribe(() => setV(app.version)), []);
  return app;
}
