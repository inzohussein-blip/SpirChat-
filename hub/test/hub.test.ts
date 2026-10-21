import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import {
  createDirect,
  createSigned,
  type Envelope,
  type HubMessage,
  newIdentity,
  openDirect,
} from '@spirchat/protocol';
import { type Config, loadConfig } from '../src/config.ts';
import { Hub } from '../src/hub.ts';
import { pullFromPeer } from '../src/peers.ts';
import { createHubServer } from '../src/server.ts';
import { Store } from '../src/store.ts';

const servers: Server[] = [];
after(() => servers.forEach((s) => s.close()));

async function startHub(overrides: Partial<Config> = {}) {
  const config = { ...loadConfig({ DATA_DIR: tmpdir() }), ...overrides };
  const hub = new Hub(config, new Store(':memory:'));
  const server = createHubServer(hub);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { hub, http: `http://${base}`, ws: `ws://${base}/ws` };
}

/** Minimal client that records hub messages and lets tests await specific ones. */
async function connect(url: string) {
  const ws = new WebSocket(url);
  const log: HubMessage[] = [];
  const waiters: { pred: (m: HubMessage) => boolean; resolve: (m: HubMessage) => void }[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as HubMessage;
    log.push(m);
    for (const w of [...waiters]) {
      if (w.pred(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
    }
  };
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  const next = <T extends HubMessage>(pred: (m: HubMessage) => boolean) => {
    const found = log.find(pred);
    if (found) return Promise.resolve(found as T);
    return new Promise<T>((resolve) => waiters.push({ pred, resolve: resolve as (m: HubMessage) => void }));
  };
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { ws, log, next, send, close: () => ws.close() };
}

const envs = (log: HubMessage[]) => log.flatMap((m) => (m.t === 'env' ? [m.env] : []));

test('publish, catch-up, live delivery and DM decryption', async () => {
  const { ws } = await startHub();
  const alice = newIdentity();
  const bob = newIdentity();

  const a = await connect(ws);
  a.send({ t: 'hello' });
  await a.next((m) => m.t === 'synced');
  const post = createSigned(alice, 'post', { text: 'أول منشور' });
  a.send({ t: 'publish', env: post });
  assert.deepEqual(await a.next((m) => m.t === 'ack'), { t: 'ack', id: post.id, ok: true });

  const b = await connect(ws);
  b.send({ t: 'hello' });
  const welcome = await b.next<Extract<HubMessage, { t: 'welcome' }>>((m) => m.t === 'welcome');
  const synced = await b.next<Extract<HubMessage, { t: 'synced' }>>((m) => m.t === 'synced');
  assert.deepEqual(envs(b.log).map((e) => e.id), [post.id]);

  const dm = createDirect(alice, bob.id, { text: 'وصلت؟' });
  a.send({ t: 'publish', env: dm });
  const live = await b.next<Extract<HubMessage, { t: 'env' }>>((m) => m.t === 'env' && m.env.id === dm.id);
  assert.equal(openDirect(bob, live.env)?.text, 'وصلت؟');

  // Resuming from the cursor only sends what is new.
  const c = await connect(ws);
  c.send({ t: 'hello', hubId: welcome.hubId, since: synced.seq });
  await c.next((m) => m.t === 'synced');
  assert.deepEqual(envs(c.log).map((e) => e.id), [dm.id]);
  [a, b, c].forEach((x) => x.close());
});

test('catch-up sends urgent envelopes before image posts', async () => {
  const { hub, ws } = await startHub();
  const alice = newIdentity();
  const img = createSigned(alice, 'post', { text: '', image: 'data:image/webp;base64,AAAA' });
  const sos = createSigned(alice, 'sos', { text: 'نحتاج مساعدة' });
  assert.ok(hub.accept(img).ok);
  assert.ok(hub.accept(sos).ok);
  const c = await connect(ws);
  c.send({ t: 'hello' });
  await c.next((m) => m.t === 'synced');
  assert.deepEqual(envs(c.log).map((e) => e.kind), ['sos', 'post']);
  c.close();
});

test('have/want lets a phone carry envelopes between hubs', async () => {
  const one = await startHub();
  const two = await startHub();
  const alice = newIdentity();
  const post = createSigned(alice, 'post', { text: 'من حي إلى حي' });
  assert.ok(one.hub.accept(post).ok);

  const phone = await connect(one.ws);
  phone.send({ t: 'hello' });
  await phone.next((m) => m.t === 'synced');
  const carried = envs(phone.log);
  phone.close();

  const atTwo = await connect(two.ws);
  atTwo.send({ t: 'hello' });
  await atTwo.next((m) => m.t === 'synced');
  atTwo.send({ t: 'have', ids: carried.map((e) => e.id) });
  const want = await atTwo.next<Extract<HubMessage, { t: 'want' }>>((m) => m.t === 'want');
  assert.deepEqual(want.ids, [post.id]);
  for (const env of carried) atTwo.send({ t: 'publish', env });
  await atTwo.next((m) => m.t === 'ack' && m.ok);
  assert.equal(two.hub.store.missing([post.id]).length, 0);
  atTwo.close();
});

test('invalid envelopes and unauthorised alerts are rejected', async () => {
  const official = newIdentity();
  const { hub } = await startHub({ alertKeys: [official.id] });
  const body = { title: 'تحذير', text: 'ابتعدوا عن الجسر', level: 'danger' as const };
  assert.equal(hub.accept(createSigned(newIdentity(), 'alert', body)).ok, false);
  assert.equal(hub.accept(createSigned(official, 'alert', body)).ok, true);
  assert.equal(hub.accept({ v: 1, kind: 'post' }).ok, false);
  const post = createSigned(official, 'post', { text: 'x' });
  assert.equal(hub.accept({ ...post, body: { text: 'y' } }).ok, false);
});

test('hubs sync with peers and via exported bundles', async () => {
  const one = await startHub();
  const two = await startHub();
  const three = await startHub();
  const alice = newIdentity();
  const posted: Envelope[] = [];
  for (let i = 0; i < 3; i++) {
    const env = createSigned(alice, 'room', { room: 'mosul', text: `msg ${i}` });
    posted.push(env);
    assert.ok(one.hub.accept(env).ok);
  }

  assert.equal(await pullFromPeer(two.hub, one.http), 3);
  assert.equal(await pullFromPeer(two.hub, one.http), 0, 'cursor persisted');
  assert.ok(one.hub.accept(createSigned(alice, 'room', { room: 'mosul', text: 'later' })).ok);
  assert.equal(await pullFromPeer(two.hub, one.http), 1);

  const bundle = await (await fetch(`${one.http}/api/export`)).text();
  assert.equal(bundle.trim().split('\n').length, 4);
  const res = await fetch(`${three.http}/api/envelopes`, { method: 'POST', body: bundle });
  assert.deepEqual(await res.json(), { received: 4, added: 4, rejected: 0 });
});

test('pruning drops expired and bulky envelopes before urgent ones', () => {
  const store = new Store(':memory:');
  const alice = newIdentity();
  const now = Date.now();
  const old = createSigned(alice, 'sos', { text: 'old' }, { now: now - 10_000, ttl: 5_000 });
  const sos = createSigned(alice, 'sos', { text: 'help' });
  const img = createSigned(alice, 'post', { text: '', image: `data:image/webp;base64,${'A'.repeat(4000)}` });
  [old, sos, img].forEach((e) => store.insert(e));
  store.prune(2000, now);
  assert.deepEqual(store.missing([old.id, sos.id, img.id]), [old.id, img.id]);
});

test('captive portal probes redirect to the app', async () => {
  const { http } = await startHub({ captive: true });
  const res = await fetch(`${http}/generate_204`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'http://spirchat.local/');
  const info = await fetch(`${http}/api/info`);
  assert.equal(info.status, 200);
});
