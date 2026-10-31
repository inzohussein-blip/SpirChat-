// Generates test vectors that other implementations (android/engine) must agree with.
// Run: node packages/protocol/scripts/vectors.ts > packages/protocol/test/vectors.json
import {
  b64u,
  canonicalJson,
  createDirect,
  createSigned,
  type Envelope,
  identityFromSeed,
  mailboxTag,
  summarize,
  validateEnvelope,
} from '../src/index.ts';

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0);
const seed = (n: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 7 + n) & 255);
const alice = identityFromSeed(seed(1));
const bob = identityFromSeed(seed(2));
const opts = { now: NOW - 60_000 };

const valid: Record<string, Envelope> = {
  profile: createSigned(alice, 'profile', { name: 'علي 🌙', bio: 'quote " backslash \\ tab \t newline \n ctrl \u0001' }, opts),
  post: createSigned(alice, 'post', { text: 'مرحبا بغداد', thumb: 'data:image/webp;base64,AAAA' }, opts),
  room: createSigned(alice, 'room', { room: 'الكرادة-52', text: 'hello' }, opts),
  sos: createSigned(alice, 'sos', { text: 'help', loc: { lat: 33.312, lon: 44.361 } }, opts),
  sosNegative: createSigned(alice, 'sos', { text: 'x', loc: { lat: -0.001, lon: 0 } }, opts),
  alert: createSigned(alice, 'alert', { title: 't', text: '', level: 'danger' }, opts),
  dm: createDirect(alice, bob.id, { text: 'سري' }, opts),
};

const tamper = (e: Envelope, patch: Partial<Envelope>): Envelope => ({ ...e, ...patch });
const invalid: Record<string, unknown> = {
  editedBody: tamper(valid.room!, { body: { room: 'الكرادة-52', text: 'HELLO' } }),
  otherAuthor: tamper(valid.post!, { author: bob.id }),
  wrongNonce: tamper(valid.post!, { nonce: valid.post!.nonce + 1 }),
  wrongId: tamper(valid.post!, { id: valid.room!.id }),
  extendedExp: tamper(valid.post!, { exp: valid.post!.exp + 1 }),
  extraField: { ...valid.post!, extra: 1 },
  badVersion: tamper(valid.post!, { v: 2 }),
  dmWithBody: { ...valid.dm!, body: {} },
  expired: createSigned(alice, 'sos', { text: 'old' }, { now: NOW - 10_000, ttl: 5_000 }),
  future: createSigned(alice, 'sos', { text: 'later' }, { now: NOW + 3 * 86400_000 }),
};

for (const [k, e] of Object.entries(valid)) {
  const r = validateEnvelope(e, NOW);
  if (!r.ok) throw new Error(`${k} should be valid: ${r.error}`);
}
for (const [k, e] of Object.entries(invalid)) {
  if (validateEnvelope(e, NOW).ok) throw new Error(`${k} should be invalid`);
}

const canonical = [
  { b: 1, a: [true, null, 'x'] },
  { s: '"\\/\b\f\n\r\t\u0000\u001f\u007f é 😀 \ud800' },
  { n: [0, -0, 1, -1, 1.5, 0.001, 1e-7, 123456789012, 1e21, 33.312, -44.361] },
];

console.log(
  JSON.stringify(
    {
      now: NOW,
      identities: { alice: { seed: b64u(seed(1)), id: alice.id, tag: mailboxTag(alice.id) }, bob: { seed: b64u(seed(2)), id: bob.id, tag: mailboxTag(bob.id) } },
      valid,
      invalid,
      canonical: canonical.map((value) => ({ value, json: canonicalJson(value) })),
      summary: (() => {
        const items = [...Object.values(valid), invalid.expired as Envelope, invalid.future as Envelope].map((e) => ({ id: e.id, ts: e.ts }));
        return { items, buckets: summarize(items) };
      })(),
    },
    null,
    1,
  ),
);
