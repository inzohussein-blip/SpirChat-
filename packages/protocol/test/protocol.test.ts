import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b64u,
  canonicalJson,
  createDirect,
  createSigned,
  fingerprint,
  fromB64u,
  leadingZeroBits,
  newIdentity,
  openDirect,
  priorityOf,
  RULES,
  validateEnvelope,
} from '../src/index.ts';

test('base64url round-trips all lengths', () => {
  for (let n = 0; n < 40; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
    assert.deepEqual(fromB64u(b64u(bytes)), bytes);
  }
  assert.equal(b64u(Uint8Array.of(0xfb, 0xff)), '-_8');
});

test('canonical JSON sorts keys and drops undefined', () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, 'x'], c: undefined }), '{"a":[true,null,"x"],"b":1}');
  assert.equal(canonicalJson({ z: { y: 1, x: 2 } }), '{"z":{"x":2,"y":1}}');
});

test('signed post validates and carries proof of work', () => {
  const alice = newIdentity();
  const env = createSigned(alice, 'post', { text: 'مرحبا من بغداد' });
  assert.deepEqual(validateEnvelope(env), { ok: true });
  assert.ok(leadingZeroBits(fromB64u(env.id)) >= RULES.post.powBits);
  assert.equal(env.author, alice.id);
});

test('tampering is detected', () => {
  const alice = newIdentity();
  const env = createSigned(alice, 'room', { room: 'karrada', text: 'hello' });
  const edited = { ...env, body: { room: 'karrada', text: 'HELLO' } };
  assert.equal(validateEnvelope(edited).ok, false);
  const reauthored = { ...env, author: newIdentity().id };
  assert.equal(validateEnvelope(reauthored).ok, false);
  const extended = { ...env, exp: env.exp + 1000 };
  assert.equal(validateEnvelope(extended).ok, false);
  const renonced = { ...env, nonce: env.nonce + 1 };
  assert.equal(validateEnvelope(renonced).ok, false);
});

test('expired, future and oversized envelopes are rejected', () => {
  const alice = newIdentity();
  const now = Date.now();
  const env = createSigned(alice, 'sos', { text: 'help' }, { now, ttl: 1000 });
  assert.equal(validateEnvelope(env, now + 2000).ok, false);
  const future = createSigned(alice, 'sos', { text: 'help' }, { now: now + 3 * 86400_000 });
  assert.deepEqual(validateEnvelope(future, now), { ok: false, error: 'timestamp in the future' });
  assert.throws(() => createSigned(alice, 'sos', { text: 'x'.repeat(281) }));
});

test('direct messages are readable only by the recipient', () => {
  const alice = newIdentity();
  const bob = newIdentity();
  const eve = newIdentity();
  const env = createDirect(alice, bob.id, { text: 'سري' });
  assert.deepEqual(validateEnvelope(env), { ok: true });
  assert.equal(env.author, undefined, 'sender is hidden from carriers');
  const msg = openDirect(bob, env);
  assert.equal(msg?.text, 'سري');
  assert.equal(msg?.from, alice.id);
  assert.equal(openDirect(eve, env), null);
});

test('direct message ciphertext tampering is rejected', () => {
  const alice = newIdentity();
  const bob = newIdentity();
  const env = createDirect(alice, bob.id, { text: 'hi' });
  const ct = fromB64u(env.ct!);
  ct[0]! ^= 1;
  assert.equal(openDirect(bob, { ...env, ct: b64u(ct) }), null);
});

test('priority orders SOS before chat before image posts', () => {
  const a = newIdentity();
  const sos = createSigned(a, 'sos', { text: 'help' });
  const dm = createDirect(a, newIdentity().id, { text: 'hi' });
  const img = createSigned(a, 'post', { text: '', image: 'data:image/webp;base64,AAAA' });
  assert.ok(priorityOf(sos) < priorityOf(dm));
  assert.ok(priorityOf(dm) < priorityOf(img));
});

test('fingerprint is stable and short', () => {
  const a = newIdentity();
  assert.equal(fingerprint(a.id), fingerprint(a.id));
  assert.match(fingerprint(a.id), /^\d{5}( \d{5}){5}$/);
});

test('summaries agree on equal sets and isolate the differing day', async () => {
  const { summarize, differingDays, dayOf } = await import('../src/index.ts');
  const a = newIdentity();
  const day = 86_400_000;
  const now = Date.now();
  const envs = [0, 0, 1, 2].map((d, i) => createSigned(a, 'room', { room: 'r', text: `m${i}` }, { now: now - d * day }));
  const sumA = summarize(envs);
  assert.equal(sumA.length, 3);
  assert.deepEqual(differingDays(sumA, summarize([...envs].reverse())), []);
  const fewer = summarize(envs.slice(1));
  assert.deepEqual(differingDays(sumA, fewer), [dayOf(now)]);
  assert.deepEqual(differingDays(fewer, sumA), [dayOf(now)]);
});

test('posts may reference media and declare an area', async () => {
  const { areasOverlap } = await import('../src/index.ts');
  const a = newIdentity();
  const media = { id: 'A'.repeat(43), size: 1234, mime: 'image/webp' as const };
  const env = createSigned(a, 'post', { text: '', media, area: 'baghdad/الكرادة' });
  assert.deepEqual(validateEnvelope(env), { ok: true });
  assert.throws(() => createSigned(a, 'post', { text: 'x', media: { ...media, size: 5_000_000 } }));
  assert.throws(() => createSigned(a, 'post', { text: 'x', area: 'bad area!' }));
  assert.ok(areasOverlap('baghdad', 'baghdad/karrada'));
  assert.ok(areasOverlap('baghdad/karrada', undefined));
  assert.ok(!areasOverlap('baghdad/karrada', 'basra'));
  assert.ok(!areasOverlap('baghdad/karrada', 'baghdad/mansour'));
});
