import { useEffect, useState } from 'preact/hooks';
import {
  type Area,
  areaOf,
  areasOverlap,
  type BodyByKind,
  dayOf,
  createDirect,
  createSigned,
  type DirectMessage,
  type Envelope,
  fromB64u,
  b64u,
  type Identity,
  identityFromSeed,
  mailboxTag,
  MAX_HAVE_IDS,
  newIdentity,
  openDirect,
  priorityOf,
  type ProfileBody,
  type SignedKind,
  summarize,
  validateEnvelope,
} from '@spirchat/protocol';
import * as db from './db.ts';
import { HubConn, type HubView, wsUrl } from './hubconn.ts';
import type { Compressed } from './image.ts';
import { saveMedia, uploadMissing } from './media.ts';
import { native } from './native.ts';

export type HubStatus = 'offline' | 'connecting' | 'syncing' | 'online';

export interface ChatMessage extends DirectMessage {
  id: string;
  mine: boolean;
}

export interface Settings {
  /** Internet hubs (https://…) used whenever the internet is reachable. */
  internetHubs: string[];
  internetEnabled: boolean;
  /** Local hub address to try first (app only). */
  manualHub: string;
  /** Keep relaying with the screen off (app only). */
  background: boolean;
  mesh: boolean;
}

/** Who sees a post: the neighbourhood, the governorate, or everyone. */
export type Scope = 'hood' | 'gov' | 'all';

const BUILD_INTERNET_HUBS: string[] = ((import.meta.env.VITE_INTERNET_HUBS as string | undefined) ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const DEFAULT_SETTINGS: Settings = {
  internetHubs: BUILD_INTERNET_HUBS,
  internetEnabled: true,
  manualHub: '',
  background: true,
  mesh: false,
};

class AppState {
  me: Identity | null = null;
  myTag = '';
  envelopes = new Map<string, Envelope>();
  /** Decrypted DMs to and from me, keyed by envelope id. */
  messages = new Map<string, ChatMessage>();
  alertKeys = new Set<string>();
  /** Envelope IDs some hub has confirmed it holds. */
  atHub = new Set<string>();
  hubs: HubView[] = [];
  peers = 0;
  meshRunning = false;
  settings: Settings = DEFAULT_SETTINGS;
  /** The user's area, e.g. "baghdad/الكرادة"; '' if not set. */
  area: Area = '';
  /** Authors whose content this device hides. */
  blocked = new Set<string>();
  version = 0;

  private listeners = new Set<() => void>();
  private conns: HubConn[] = [];
  private pending: Envelope[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private nativeSeq = 0;
  private pulling = false;

  changed() {
    this.version++;
    for (const l of this.listeners) l();
  }

  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  /** The local (non-internet) hub. */
  get hub(): { status: HubStatus; name?: string } {
    const local = this.hubs.find((h) => !h.internet);
    return { status: local?.state ?? 'offline', name: local?.name };
  }

  get internetOnline(): boolean {
    return this.hubs.some((h) => h.internet && h.state === 'online');
  }

  async load() {
    const seed = await db.getMeta<string>('seed');
    if (seed) this.setIdentity(identityFromSeed(fromB64u(seed)));
    this.alertKeys = new Set((await db.getMeta<string[]>('alertKeys')) ?? []);
    this.area = (await db.getMeta<string>('area')) ?? '';
    this.blocked = new Set((await db.getMeta<string[]>('blocked')) ?? []);
    const now = Date.now();
    const expired: string[] = [];
    for (const env of await db.allEnvelopes()) {
      if (env.exp <= now) expired.push(env.id);
      else this.ingest(env);
    }
    if (expired.length) void db.deleteEnvelopes(expired);
    for (const s of await db.allSent()) this.messages.set(s.id, { ...s, mine: true });

    if (native) {
      this.nativeSeq = (await db.getMeta<number>('nativeSeq')) ?? 0;
      this.settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(native.settings()) as Partial<Settings>) };
      window.spirchatEvents = { onChanged: () => void this.pullNative() };
      // Hand the engine anything it does not have yet (first run, or after a native wipe).
      for (const env of this.envelopes.values()) native.publish(JSON.stringify(env));
      await this.pullNative();
    } else {
      this.settings = { ...DEFAULT_SETTINGS, ...((await db.getMeta<Partial<Settings>>('settings')) ?? {}) };
      this.connectHubs();
      addEventListener('online', () => this.conns.forEach((c) => c.poke()));
    }
    this.changed();
  }

  private setIdentity(id: Identity) {
    this.me = id;
    this.myTag = mailboxTag(id.id);
    native?.setIdentity(this.myTag, id.id);
  }

  async createAccount(name: string, seed?: Uint8Array) {
    const id = seed ? identityFromSeed(seed) : newIdentity();
    await db.setMeta('seed', b64u(id.seed));
    this.setIdentity(id);
    // Re-scan held envelopes: a restored identity may already have mail waiting.
    const held = [...this.envelopes.values()];
    this.envelopes.clear();
    for (const env of held) this.ingest(env);
    if (name) await this.publishSigned('profile', { name });
    this.changed();
  }

  backupCode(): string {
    return this.me ? b64u(this.me.seed) : '';
  }

  async wipe() {
    this.conns.forEach((c) => c.close());
    native?.wipe();
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

  /** Stores an envelope from a hub or the engine; `trusted` (engine-validated) skips re-validation. */
  private receive(env: Envelope, trusted = false) {
    if (this.envelopes.has(env.id)) return;
    if (!trusted && !validateEnvelope(env).ok) return;
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
    if (native) {
      const err = native.publish(JSON.stringify(env));
      if (err) throw new Error(err);
    } else {
      for (const c of this.conns) c.send({ t: 'publish', env });
    }
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

  private live(): Envelope[] {
    const now = Date.now();
    return [...this.envelopes.values()].filter((e) => e.exp > now);
  }

  /** IDs carried that were created on the given days, urgent first. */
  private idsOnDays(days: number[]): string[] {
    const set = new Set(days);
    return this.live()
      .filter((e) => set.has(dayOf(e.ts)))
      .sort((a, b) => priorityOf(a) - priorityOf(b) || b.ts - a.ts)
      .slice(0, MAX_HAVE_IDS)
      .map((e) => e.id);
  }

  /** Area for a new post at the chosen scope. */
  areaFor(scope: Scope): Area | undefined {
    if (!this.area || scope === 'all') return undefined;
    return scope === 'gov' ? this.area.split('/')[0] : this.area;
  }

  async publishPost(text: string, image: Compressed | null, scope: Scope) {
    const area = this.areaFor(scope);
    const body: BodyByKind['post'] = { text, ...(area ? { area } : {}) };
    if (image) {
      body.media = await saveMedia(image.bytes, image.mime);
      body.thumb = image.thumb;
      for (const base of this.hubBases()) void uploadMissing(base);
    }
    await this.publishSigned('post', body);
  }

  /** HTTP base URLs of hubs online right now (for fetching images). */
  hubBases(): string[] {
    const online = this.hubs.filter((h) => h.state === 'online').map((h) => h.url);
    // In the browser the serving hub is same-origin.
    return native ? online : online.map((u, i) => (i === 0 && !this.hubs[0]?.internet ? '' : u));
  }

  async setArea(area: Area) {
    this.area = area;
    await db.setMeta('area', area);
    this.changed();
  }

  async block(id: string, on: boolean) {
    if (on) this.blocked.add(id);
    else this.blocked.delete(id);
    await db.setMeta('blocked', [...this.blocked]);
    this.changed();
  }

  /** Whether an envelope is relevant to the user's area (no area on either side counts as yes). */
  nearMe(env: Envelope): boolean {
    return areasOverlap(this.area || undefined, areaOf(env));
  }

  /** Imports an NDJSON bundle (from another hub or phone) through this device. */
  async importBundle(text: string): Promise<number> {
    let added = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        const env = JSON.parse(line) as Envelope;
        if (this.envelopes.has(env.id) || !validateEnvelope(env).ok) continue;
        await this.publish(env);
        added++;
      } catch {
        // skip malformed lines
      }
    }
    return added;
  }

  /** NDJSON of everything this device carries. */
  exportBundle(): string {
    return [...this.envelopes.values()].map((e) => JSON.stringify(e)).join('\n') + '\n';
  }

  // --- browser: direct hub connections ---------------------------------------------

  private connectHubs() {
    this.conns.forEach((c) => c.close());
    const secure = location.protocol === 'https:';
    const handlers = {
      receive: (env: Envelope) => this.receive(env),
      summary: () => summarize(this.live()),
      idsOnDays: (days: number[]) => this.idsOnDays(days),
      synced: (base: string) => void uploadMissing(base === httpBase(location.host) ? '' : base),
      get: (id: string) => this.envelopes.get(id),
      delivered: (ids: string[]) => {
        ids.forEach((id) => this.atHub.add(id));
        this.changed();
      },
      alertKeys: (keys: string[]) => {
        keys.forEach((k) => this.alertKeys.add(k));
        void db.setMeta('alertKeys', [...this.alertKeys]);
      },
      changed: () => {
        this.hubs = this.conns.map((c) => c.view());
        this.changed();
      },
    };
    const urls = [wsUrl(location.host, secure)];
    if (this.settings.internetEnabled) {
      for (const h of this.settings.internetHubs) {
        const u = wsUrl(h, true);
        if (!urls.includes(u)) urls.push(u);
      }
    }
    this.conns = urls.map((u, i) => new HubConn(u, i > 0, handlers));
    this.hubs = this.conns.map((c) => c.view());
  }

  // --- app: the native engine does the syncing ------------------------------------------

  private async pullNative() {
    if (!native || this.pulling) return;
    this.pulling = true;
    try {
      for (;;) {
        const page = JSON.parse(native.storeSince(String(this.nativeSeq))) as {
          items: { seq: number; env: Envelope }[];
          last: number;
          more: boolean;
        };
        for (const { env } of page.items) this.receive(env, true);
        this.nativeSeq = page.last;
        if (!page.more) break;
      }
      await db.setMeta('nativeSeq', this.nativeSeq);
      const s = JSON.parse(native.status()) as {
        hubs: (Omit<HubView, 'name'> & { name: string | null })[];
        peers: number;
        mesh: boolean;
        alertKeys: string[];
      };
      this.hubs = s.hubs.map((h) => ({ ...h, name: h.name ?? undefined }));
      this.peers = s.peers;
      this.meshRunning = s.mesh;
      if (s.alertKeys.some((k) => !this.alertKeys.has(k))) {
        s.alertKeys.forEach((k) => this.alertKeys.add(k));
        void db.setMeta('alertKeys', [...this.alertKeys]);
      }
      const mine = [...this.messages.values()].filter((m) => m.mine && !this.atHub.has(m.id)).map((m) => m.id);
      if (mine.length) {
        (JSON.parse(native.delivered(JSON.stringify(mine))) as string[]).forEach((id) => this.atHub.add(id));
      }
    } finally {
      this.pulling = false;
    }
    this.changed();
  }

  async updateSettings(patch: Partial<Settings>) {
    if (native) {
      const saved = JSON.parse(native.updateSettings(JSON.stringify(patch))) as Partial<Settings>;
      this.settings = { ...DEFAULT_SETTINGS, ...saved };
    } else {
      this.settings = { ...this.settings, ...patch };
      await db.setMeta('settings', this.settings);
      this.connectHubs();
    }
    this.changed();
  }

  setMesh(on: boolean) {
    if (on) native?.startMesh();
    else native?.stopMesh();
  }

  // --- derived views ------------------------------------------------------

  ofKind<K extends Envelope['kind']>(kind: K): Envelope[] {
    return [...this.envelopes.values()]
      .filter((e) => e.kind === kind && !(e.author && this.blocked.has(e.author)))
      .sort((a, b) => b.ts - a.ts);
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
      if (this.blocked.has(other)) continue;
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

const httpBase = (host: string) => `${location.protocol}//${host}`;

export const app = new AppState();

/** Re-render the calling component whenever app state changes. */
export function useApp(): AppState {
  const [, setV] = useState(0);
  useEffect(() => app.subscribe(() => setV(app.version)), []);
  return app;
}
