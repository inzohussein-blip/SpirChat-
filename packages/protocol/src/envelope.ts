import {
  type Identity,
  leadingZeroBits,
  mailboxTag,
  open,
  seal,
  sha256,
  sign,
  verify,
} from './crypto.ts';
import { b64u, canonicalJson, concat, fromUtf8, utf8 } from './encoding.ts';

export const PROTOCOL_VERSION = 1;

export type SignedKind = 'profile' | 'post' | 'room' | 'alert' | 'sos';
export type SealedKind = 'dm';
export type Kind = SignedKind | SealedKind;

export const KINDS: readonly Kind[] = ['profile', 'post', 'room', 'alert', 'sos', 'dm'];

const HOUR = 3600_000;
const DAY = 24 * HOUR;

interface KindRules {
  /** Lower is more urgent. Carriers send and keep urgent envelopes first. */
  priority: number;
  maxBytes: number;
  maxTtl: number;
  defaultTtl: number;
  powBits: number;
}

export const RULES: Record<Kind, KindRules> = {
  sos: { priority: 0, maxBytes: 1024, maxTtl: 3 * DAY, defaultTtl: 2 * DAY, powBits: 10 },
  alert: { priority: 0, maxBytes: 4096, maxTtl: 7 * DAY, defaultTtl: 3 * DAY, powBits: 0 },
  dm: { priority: 1, maxBytes: 256 * 1024, maxTtl: 30 * DAY, defaultTtl: 14 * DAY, powBits: 12 },
  room: { priority: 2, maxBytes: 8 * 1024, maxTtl: 14 * DAY, defaultTtl: 7 * DAY, powBits: 12 },
  profile: { priority: 3, maxBytes: 2048, maxTtl: 365 * DAY, defaultTtl: 180 * DAY, powBits: 10 },
  post: { priority: 3, maxBytes: 256 * 1024, maxTtl: 60 * DAY, defaultTtl: 30 * DAY, powBits: 14 },
};

/** Tolerated clock skew: phones in a crisis often have wrong clocks. */
export const MAX_FUTURE_SKEW = DAY;

export interface ProfileBody {
  name: string;
  bio?: string;
}
export interface PostBody {
  text: string;
  /** data: URL of a compressed image. */
  image?: string;
  /** Small data: URL preview, sent over slow links instead of `image`. */
  thumb?: string;
}
export interface RoomBody {
  room: string;
  text: string;
}
export interface AlertBody {
  title: string;
  text: string;
  level: 'info' | 'warning' | 'danger';
}
export interface SosBody {
  text: string;
  /** Rounded coordinates, only if the user chose to share them. */
  loc?: { lat: number; lon: number };
}

export interface BodyByKind {
  profile: ProfileBody;
  post: PostBody;
  room: RoomBody;
  alert: AlertBody;
  sos: SosBody;
}

export interface Envelope {
  v: number;
  kind: Kind;
  /** Creation time, ms since epoch (sender's clock). */
  ts: number;
  /** Carriers drop the envelope after this time. */
  exp: number;
  // Signed (public) kinds:
  author?: string;
  body?: unknown;
  sig?: string;
  // Sealed kinds: recipient mailbox tag, ephemeral key and ciphertext.
  to?: string;
  epk?: string;
  ct?: string;
  /** Proof-of-work counter; see `id`. */
  nonce: number;
  /** base64url(sha256(base || nonce)), which must have RULES[kind].powBits leading zero bits. */
  id: string;
}

export interface DirectMessage {
  from: string;
  to: string;
  ts: number;
  text: string;
  image?: string;
}

type Unsealed = Omit<Envelope, 'nonce' | 'id'>;

function signedPayload(env: Pick<Envelope, 'v' | 'kind' | 'ts' | 'exp' | 'author' | 'body'>) {
  const { v, kind, ts, exp, author, body } = env;
  return utf8(canonicalJson({ v, kind, ts, exp, author, body }));
}

function powBase(env: Unsealed): Uint8Array {
  return sha256(utf8(canonicalJson(env)));
}

function powHash(base: Uint8Array, nonce: number): Uint8Array {
  const n = new Uint8Array(4);
  new DataView(n.buffer).setUint32(0, nonce);
  return sha256(concat(base, n));
}

function finish(env: Unsealed): Envelope {
  const bits = RULES[env.kind].powBits;
  const base = powBase(env);
  for (let nonce = 0; nonce < 2 ** 32; nonce++) {
    const h = powHash(base, nonce);
    if (leadingZeroBits(h) >= bits) return { ...env, nonce, id: b64u(h) };
  }
  throw new Error('proof of work exhausted');
}

export interface CreateOptions {
  now?: number;
  ttl?: number;
}

function times(kind: Kind, opts: CreateOptions) {
  const ts = opts.now ?? Date.now();
  return { ts, exp: ts + Math.min(opts.ttl ?? RULES[kind].defaultTtl, RULES[kind].maxTtl) };
}

export function createSigned<K extends SignedKind>(
  identity: Identity,
  kind: K,
  body: BodyByKind[K],
  opts: CreateOptions = {},
): Envelope {
  const head = { v: PROTOCOL_VERSION, kind, ...times(kind, opts), author: identity.id, body };
  const err = validateBody(kind, body);
  if (err) throw new Error(err);
  return finish({ ...head, sig: sign(identity, signedPayload(head)) });
}

function directPayload(m: DirectMessage) {
  const { from, to, ts, text, image } = m;
  return utf8(canonicalJson({ from, to, ts, text, image }));
}

export function createDirect(
  identity: Identity,
  recipientId: string,
  content: { text: string; image?: string },
  opts: CreateOptions = {},
): Envelope {
  const t = times('dm', opts);
  const msg: DirectMessage = { from: identity.id, to: recipientId, ts: t.ts, ...content };
  const inner = { ...msg, sig: sign(identity, directPayload(msg)) };
  const { epk, ct } = seal(recipientId, utf8(JSON.stringify(inner)));
  return finish({ v: PROTOCOL_VERSION, kind: 'dm', ...t, to: mailboxTag(recipientId), epk, ct });
}

/** Decrypts and authenticates a DM addressed to `identity`, or returns null. */
export function openDirect(identity: Identity, env: Envelope): DirectMessage | null {
  if (env.kind !== 'dm' || !env.epk || !env.ct || env.to !== mailboxTag(identity.id)) return null;
  const plain = open(identity, env.epk, env.ct);
  if (!plain) return null;
  try {
    const inner = JSON.parse(fromUtf8(plain)) as DirectMessage & { sig: string };
    if (typeof inner.from !== 'string' || typeof inner.text !== 'string') return null;
    if (inner.to !== identity.id || inner.ts !== env.ts) return null;
    const msg: DirectMessage = { from: inner.from, to: inner.to, ts: inner.ts, text: inner.text };
    if (typeof inner.image === 'string') msg.image = inner.image;
    if (!verify(msg.from, directPayload(msg), inner.sig)) return null;
    return msg;
  } catch {
    return null;
  }
}

const isStr = (v: unknown, max: number, min = 0): v is string =>
  typeof v === 'string' && v.length >= min && v.length <= max;
const isDataUrl = (v: unknown, max: number) => isStr(v, max) && /^data:image\/(webp|jpeg|png);base64,/.test(v);

export function validateBody(kind: Kind, body: unknown): string | null {
  if (kind === 'dm') return body === undefined ? null : 'dm must not have a body';
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return 'body must be an object';
  const b = body as Record<string, unknown>;
  switch (kind) {
    case 'profile':
      if (!isStr(b.name, 40, 1)) return 'profile.name must be 1-40 chars';
      if (b.bio !== undefined && !isStr(b.bio, 160)) return 'profile.bio too long';
      return null;
    case 'post':
      if (!isStr(b.text, 2000)) return 'post.text too long';
      if (b.image !== undefined && !isDataUrl(b.image, 240_000)) return 'post.image invalid';
      if (b.thumb !== undefined && !isDataUrl(b.thumb, 12_000)) return 'post.thumb invalid';
      if (!b.text && !b.image) return 'post is empty';
      return null;
    case 'room':
      if (!isStr(b.room, 32, 1) || !/^[\p{L}\p{N}_-]+$/u.test(b.room)) return 'room name invalid';
      if (!isStr(b.text, 2000, 1)) return 'room.text must be 1-2000 chars';
      return null;
    case 'alert':
      if (!isStr(b.title, 100, 1) || !isStr(b.text, 1000)) return 'alert text invalid';
      if (!['info', 'warning', 'danger'].includes(b.level as string)) return 'alert.level invalid';
      return null;
    case 'sos': {
      if (!isStr(b.text, 280, 1)) return 'sos.text must be 1-280 chars';
      if (b.loc === undefined) return null;
      const loc = b.loc as Record<string, unknown> | null;
      const ok =
        typeof loc === 'object' && loc !== null &&
        typeof loc.lat === 'number' && Math.abs(loc.lat) <= 90 &&
        typeof loc.lon === 'number' && Math.abs(loc.lon) <= 180;
      return ok ? null : 'sos.loc invalid';
    }
  }
}

export function envelopeBytes(env: Envelope): number {
  return utf8(JSON.stringify(env)).length;
}

export function priorityOf(env: Envelope): number {
  const p = RULES[env.kind].priority;
  // Image posts are the bulkiest thing we carry; they go last.
  return env.kind === 'post' && (env.body as PostBody).image ? p + 1 : p;
}

export type Validation = { ok: true } | { ok: false; error: string };

const fail = (error: string): Validation => ({ ok: false, error });

/** Checks structure, size, lifetime, signature and proof of work. */
export function validateEnvelope(input: unknown, now = Date.now()): Validation {
  if (typeof input !== 'object' || input === null) return fail('not an object');
  const env = input as Envelope;
  if (env.v !== PROTOCOL_VERSION) return fail('unsupported version');
  if (!KINDS.includes(env.kind)) return fail('unknown kind');
  const rules = RULES[env.kind];
  if (!Number.isSafeInteger(env.ts) || !Number.isSafeInteger(env.exp)) return fail('bad timestamps');
  if (env.ts > now + MAX_FUTURE_SKEW) return fail('timestamp in the future');
  if (env.exp <= env.ts || env.exp - env.ts > rules.maxTtl) return fail('bad lifetime');
  if (env.exp < now) return fail('expired');
  if (!Number.isInteger(env.nonce) || env.nonce < 0 || env.nonce >= 2 ** 32) return fail('bad nonce');
  if (envelopeBytes(env) > rules.maxBytes) return fail('too large');

  const allowed =
    env.kind === 'dm'
      ? ['v', 'kind', 'ts', 'exp', 'to', 'epk', 'ct', 'nonce', 'id']
      : ['v', 'kind', 'ts', 'exp', 'author', 'body', 'sig', 'nonce', 'id'];
  if (Object.keys(env).some((k) => !allowed.includes(k))) return fail('unexpected field');

  if (env.kind === 'dm') {
    if (!isStr(env.to, 32, 1) || !isStr(env.epk, 64, 1) || !isStr(env.ct, rules.maxBytes, 1)) {
      return fail('bad sealed fields');
    }
  } else {
    if (!isStr(env.author, 64, 1) || !isStr(env.sig, 128, 1)) return fail('missing author or sig');
    const err = validateBody(env.kind, env.body);
    if (err) return fail(err);
    if (!verify(env.author, signedPayload(env), env.sig)) return fail('bad signature');
  }

  const { nonce, id, ...rest } = env;
  const h = powHash(powBase(rest), nonce);
  if (b64u(h) !== id) return fail('id mismatch');
  if (leadingZeroBits(h) < rules.powBits) return fail('insufficient proof of work');
  return { ok: true };
}
