import { useEffect, useState } from 'preact/hooks';
import {
  type Area,
  areaOf,
  areasOverlap,
  type BodyByKind,
  dayOf,
  createDirect,
  createGroupMessage,
  createSigned,
  type GroupInvite,
  groupTag,
  type LockedSeed,
  lockSeed,
  newPrekey,
  openGroupMessage,
  pinVerifier,
  randomBytes,
  unlockSeed,
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
  type PostTag,
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
  exp: number;
  /** Set for messages in a private group. */
  group?: string;
}

interface Prekey {
  secret: string;
  pub: string;
  created: number;
}

const DAY = 86_400_000;
const PREKEY_ROTATE = 7 * DAY;
const PREKEY_VALID = 14 * DAY;
/** Prekey secrets are deleted after this; messages sealed to them become unreadable. */
const PREKEY_KEEP = 30 * DAY;

/** Disappearing-message timers offered in chats (ms; 0 = the default lifetime). */
export const TTL_CHOICES = [0, 3600_000, DAY, 7 * DAY];

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
  /** A PIN protects the identity and it has not been entered yet. */
  locked = false;
  hasPin = false;
  groups = new Map<string, GroupInvite>();
  private groupTags = new Map<string, string>();
  private prekeys: Prekey[] = [];
  /** Disappearing-message timer per conversation key. */
  ttls: Record<string, number> = {};
  /** Contacts whose identity was confirmed in person (QR scan). */
  verified = new Set<string>();
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
    const lock = await db.getMeta<LockedSeed>('lock');
    this.hasPin = !!lock;
    this.prekeys = (await db.getMeta<Prekey[]>('prekeys')) ?? [];
    this.setGroups((await db.getMeta<GroupInvite[]>('groups')) ?? []);
    this.ttls = (await db.getMeta<Record<string, number>>('ttls')) ?? {};
    this.verified = new Set((await db.getMeta<string[]>('verified')) ?? []);
    if (seed) this.setIdentity(identityFromSeed(fromB64u(seed)));
    else if (lock) this.locked = true;
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
    const expiredSent: string[] = [];
    for (const s of await db.allSent()) {
      const exp = s.exp ?? Number.MAX_SAFE_INTEGER;
      if (exp <= now) expiredSent.push(s.id);
      else this.messages.set(s.id, { ...s, exp, mine: true });
    }
    if (expiredSent.length) void db.deleteSent(expiredSent);
    if (this.me) void this.rotatePrekeys();

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
    this.rescan();
    // Prekey first (no profile yet, so nothing is published), then one profile carrying it.
    await this.rotatePrekeys();
    if (name) await this.publishProfile(name);
    this.changed();
  }

  private rescan() {
    const held = [...this.envelopes.values()];
    this.envelopes.clear();
    for (const env of held) this.ingest(env);
  }

  /** Publishes the profile with the current prekeys, keeping name and bio. */
  async publishProfile(name?: string, bio?: string) {
    if (!this.me) return;
    const cur = this.profiles().get(this.me.id);
    const n = name ?? cur?.name;
    if (!n) return;
    const b = bio ?? cur?.bio;
    const keys = this.prekeys.slice(-2).map((k) => ({ k: k.pub, until: k.created + PREKEY_VALID }));
    await this.publishSigned('profile', { name: n, ...(b ? { bio: b } : {}), ...(keys.length ? { keys } : {}) });
  }

  /** Weekly new prekey; secrets older than PREKEY_KEEP are destroyed. */
  private async rotatePrekeys() {
    const now = Date.now();
    const newest = this.prekeys.at(-1);
    const before = this.prekeys.length;
    this.prekeys = this.prekeys.filter((k) => now - k.created < PREKEY_KEEP);
    const rotate = !newest || now - newest.created > PREKEY_ROTATE;
    if (rotate) this.prekeys.push({ ...newPrekey(), created: now });
    if (rotate || this.prekeys.length !== before) await db.setMeta('prekeys', this.prekeys);
    if (rotate) await this.publishProfile();
  }

  /** The recipient's newest published prekey that is still valid. */
  private prekeyOf(id: string): string | undefined {
    const now = Date.now();
    return this.profiles()
      .get(id)
      ?.keys?.filter((k) => k.until > now)
      .sort((a, b) => b.until - a.until)[0]?.k;
  }

  // --- PIN lock --------------------------------------------------------------------

  /** Returns false for a wrong PIN. The duress PIN silently wipes everything and opens an empty account. */
  async unlock(pin: string): Promise<boolean> {
    const lock = await db.getMeta<LockedSeed>('lock');
    if (!lock) return false;
    const seed = await unlockSeed(lock, pin);
    if (seed) {
      this.setIdentity(identityFromSeed(seed));
      this.locked = false;
      this.rescan();
      await this.rotatePrekeys();
      this.changed();
      return true;
    }
    const duress = await db.getMeta<{ salt: string; v: string; n: number }>('duress');
    if (duress && (await pinVerifier(pin, duress.salt, duress.n)) === duress.v) {
      native?.wipe();
      await db.wipeAll();
      this.envelopes.clear();
      this.messages.clear();
      this.setGroups([]);
      this.prekeys = [];
      this.hasPin = false;
      this.locked = false;
      await this.createAccount('');
      return true;
    }
    return false;
  }

  async setPin(pin: string, duressPin?: string) {
    if (!this.me) return;
    await db.setMeta('lock', await lockSeed(this.me.seed, pin));
    await db.deleteMeta('seed');
    if (duressPin) {
      const salt = b64u(randomBytes(16));
      await db.setMeta('duress', { salt, v: await pinVerifier(duressPin, salt), n: 15 });
    } else {
      await db.deleteMeta('duress');
    }
    this.hasPin = true;
    this.changed();
  }

  async removePin() {
    if (!this.me) return;
    await db.setMeta('seed', b64u(this.me.seed));
    await db.deleteMeta('lock');
    await db.deleteMeta('duress');
    this.hasPin = false;
    this.changed();
  }

  // --- groups, timers, verification ------------------------------------------------

  private setGroups(list: GroupInvite[]) {
    this.groups = new Map(list.map((g) => [g.id, g]));
    this.groupTags = new Map(list.map((g) => [groupTag(g.id), g.id]));
  }

  private async addGroup(g: GroupInvite) {
    if (this.groups.has(g.id)) return;
    this.setGroups([...this.groups.values(), g]);
    await db.setMeta('groups', [...this.groups.values()]);
    // Messages for this group may already be on this device.
    for (const env of this.envelopes.values()) if (env.to === groupTag(g.id)) this.ingestGroup(env, g);
  }

  async createGroup(name: string, members: string[]): Promise<string> {
    if (!this.me) throw new Error('no identity');
    const g: GroupInvite = { id: b64u(randomBytes(16)), key: b64u(randomBytes(32)), name, members: [this.me.id, ...members] };
    await this.addGroup(g);
    for (const m of members) await this.sendDirect(m, { text: '', invite: g });
    this.changed();
    return g.id;
  }

  async sendGroup(groupId: string, content: { text: string; image?: string; audio?: string }) {
    const g = this.groups.get(groupId);
    if (!this.me || !g) throw new Error('unknown group');
    const ttl = this.ttls[`g:${groupId}`] || undefined;
    const env = createGroupMessage(this.me, g, content, { ttl });
    const sent: db.SentMessage = { id: env.id, from: this.me.id, to: groupId, group: groupId, ts: env.ts, exp: env.exp, ...content };
    this.messages.set(env.id, { ...sent, exp: env.exp, mine: true });
    await db.putSent(sent);
    await this.publish(env);
  }

  async setTtl(key: string, ttl: number) {
    this.ttls = { ...this.ttls, [key]: ttl };
    await db.setMeta('ttls', this.ttls);
    this.changed();
  }

  async setVerified(id: string) {
    this.verified.add(id);
    await db.setMeta('verified', [...this.verified]);
    this.changed();
  }

  private ingestGroup(env: Envelope, g: GroupInvite) {
    const m = openGroupMessage(g, env);
    if (!m || !this.me || m.from === this.me.id) return;
    this.messages.set(env.id, {
      from: m.from,
      to: g.id,
      ts: m.ts,
      text: m.text,
      image: m.image,
      audio: m.audio,
      id: env.id,
      mine: false,
      exp: env.exp,
      group: g.id,
    });
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
      const m = openDirect(this.me, env, this.prekeys.map((k) => k.secret));
      if (m) {
        if (m.invite) void this.addGroup(m.invite);
        else this.messages.set(env.id, { ...m, id: env.id, mine: false, exp: env.exp });
      }
    } else if (env.kind === 'dm' && env.to && this.groupTags.has(env.to)) {
      this.ingestGroup(env, this.groups.get(this.groupTags.get(env.to)!)!);
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

  async sendDirect(to: string, content: { text: string; image?: string; audio?: string; invite?: GroupInvite }) {
    if (!this.me) throw new Error('no identity');
    const env = createDirect(this.me, to, content, { prekey: this.prekeyOf(to), ttl: this.ttls[to] || undefined });
    if (content.invite) return this.publish(env);
    const sent: db.SentMessage = { id: env.id, from: this.me.id, to, ts: env.ts, exp: env.exp, ...content };
    this.messages.set(env.id, { ...sent, exp: env.exp, mine: true });
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

  async publishPost(text: string, image: Compressed | null, scope: Scope, tag?: PostTag) {
    const area = this.areaFor(scope);
    const body: BodyByKind['post'] = { text, ...(area ? { area } : {}), ...(tag ? { tag } : {}) };
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
    const now = Date.now();
    for (const m of this.messages.values()) {
      if (m.exp <= now) continue;
      const other = m.group ? `g:${m.group}` : m.mine ? m.to : m.from;
      if (!m.group && this.blocked.has(other)) continue;
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
