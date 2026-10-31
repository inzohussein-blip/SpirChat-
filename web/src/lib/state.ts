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
  type PeerMessage,
  priorityOf,
  type ProfileBody,
  type SignedKind,
  validateEnvelope,
} from '@spirchat/protocol';
import * as db from './db.ts';
import { native } from './native.ts';

/** Envelopes worth pushing to nearby phones immediately rather than at the next full sync. */
const GOSSIP_MAX_AGE = 3600_000;
const shouldGossip = (env: Envelope) => priorityOf(env) <= 2 || Date.now() - env.ts < GOSSIP_MAX_AGE;

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
  /** HTTP base URL of the connected hub ('' when served by the hub itself). */
  hubBase = '';
  /** Manually entered hub address (host[:port]), tried first. */
  manualHub = '';
  /** Nearby phones connected over Bluetooth / Wi-Fi Direct (Android app only). */
  peers = new Set<string>();
  meshRunning = false;
  version = 0;

  private listeners = new Set<() => void>();
  private ws: WebSocket | null = null;
  private pending: Envelope[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private retryMs = 1000;
  private offered: string[] = [];
  private candidateIdx = 0;
  /** After every address has failed once, keep retrying without flashing "connecting". */
  private quietRetry = false;

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
    this.manualHub = (await db.getMeta<string>('manualHub')) ?? '';
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
    this.bindNative();
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

  private receive(env: Envelope, fromPeer?: string) {
    if (this.envelopes.has(env.id) || !validateEnvelope(env).ok) return;
    this.ingest(env);
    this.gossip(env, fromPeer);
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
    this.gossip(env);
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

  private hubCandidates(): string[] {
    const list = this.manualHub ? [this.manualHub] : [];
    if (native) {
      const gw = native.gatewayIp();
      if (gw) list.push(gw);
      list.push('10.42.0.1', 'spirchat.local');
    } else {
      list.push(location.host);
    }
    return [...new Set(list)];
  }

  connect() {
    if (this.ws) return;
    const candidates = this.hubCandidates();
    const host = candidates[this.candidateIdx % candidates.length]!;
    // Inside the Android app the page is served locally, so hubs are always plain http on the LAN.
    const secure = !native && location.protocol === 'https:';
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${secure ? 'wss' : 'ws'}://${host}/ws`);
    } catch {
      this.candidateIdx++;
      setTimeout(() => this.connect(), 200);
      return;
    }
    this.ws = ws;
    let opened = false;
    if (!this.quietRetry) this.setHub({ status: 'connecting' });

    ws.onopen = async () => {
      opened = true;
      this.retryMs = 1000;
      this.quietRetry = false;
      this.setHub({ status: 'connecting' });
      this.hubBase = native || host !== location.host ? `${secure ? 'https' : 'http'}://${host}` : '';
      const cursor = await db.getMeta<{ hubId: string; seq: number }>('cursor');
      ws.send(JSON.stringify({ t: 'hello', hubId: cursor?.hubId, since: cursor?.seq }));
    };
    ws.onmessage = (e) => this.onHubMessage(JSON.parse(String(e.data)) as HubMessage);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.atHub.clear();
      this.setHub({ status: 'offline', name: undefined });
      let delay = 1000;
      if (!opened) {
        // Try the next candidate address quickly; back off once all have failed.
        this.candidateIdx++;
        const wrapped = this.candidateIdx % candidates.length === 0;
        delay = wrapped ? this.retryMs : 200;
        if (wrapped) {
          this.retryMs = Math.min(this.retryMs * 2, 30_000);
          this.quietRetry = true;
        }
      }
      setTimeout(() => this.connect(), delay);
    };
  }

  /** Drop the current attempt and retry every address now (e.g. after joining a new Wi-Fi). */
  reconnectNow() {
    this.retryMs = 1000;
    this.candidateIdx = 0;
    this.quietRetry = false;
    if (this.hub.status === 'online' || this.hub.status === 'syncing') return;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.connect();
  }

  async setManualHub(addr: string) {
    this.manualHub = addr.trim().replace(/^\w+:\/\//, '').replace(/\/.*$/, '');
    await db.setMeta('manualHub', this.manualHub);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.candidateIdx = 0;
    this.connect();
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

  /** IDs of everything we carry, urgent first. */
  private carriedIds(): string[] {
    const now = Date.now();
    return [...this.envelopes.values()]
      .filter((e) => e.exp > now)
      .sort((a, b) => priorityOf(a) - priorityOf(b) || b.ts - a.ts)
      .slice(0, MAX_HAVE_IDS)
      .map((e) => e.id);
  }

  /** Offer everything we carry; the hub asks for what it lacks. */
  private offerCarried() {
    const ids = this.carriedIds();
    this.offered = ids;
    if (ids.length) this.send({ t: 'have', ids });
  }

  // --- nearby phones (Android app) ---------------------------------------

  private sendPeer(id: string, m: PeerMessage) {
    native?.sendToPeer(id, JSON.stringify(m));
  }

  private gossip(env: Envelope, except?: string) {
    if (!shouldGossip(env)) return;
    for (const p of this.peers) if (p !== except) this.sendPeer(p, { t: 'env', env });
  }

  private onPeerMessage(peer: string, m: PeerMessage) {
    switch (m.t) {
      case 'have': {
        const ids = Array.isArray(m.ids) ? m.ids.slice(0, MAX_HAVE_IDS) : [];
        this.sendPeer(peer, { t: 'want', ids: ids.filter((id) => !this.envelopes.has(id)) });
        return;
      }
      case 'want':
        for (const id of Array.isArray(m.ids) ? m.ids : []) {
          const env = this.envelopes.get(id);
          if (env) this.sendPeer(peer, { t: 'env', env });
        }
        return;
      case 'env':
        this.receive(m.env, peer);
        return;
    }
  }

  private bindNative() {
    if (!native) return;
    this.meshRunning = native.isMeshRunning();
    window.spirchatPeer = {
      onConnected: (id) => {
        this.peers.add(id);
        this.sendPeer(id, { t: 'have', ids: this.carriedIds() });
        this.changed();
      },
      onDisconnected: (id) => {
        this.peers.delete(id);
        this.changed();
      },
      onMessage: (id, data) => {
        try {
          this.onPeerMessage(id, JSON.parse(data) as PeerMessage);
        } catch (e) {
          console.warn('bad peer message', e);
        }
      },
      onMeshState: (running) => {
        this.meshRunning = running;
        if (!running) this.peers.clear();
        this.changed();
      },
      onNetworkChanged: () => this.reconnectNow(),
    };
  }

  setMesh(on: boolean) {
    if (on) native?.startMesh();
    else native?.stopMesh();
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
