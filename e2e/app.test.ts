// End-to-end tests: real hubs, real browsers. Run `npm run build` first, then `npm run e2e`.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeAll, phone, signUp, startHub, tab, type TestHub } from './harness.ts';

const hubs: TestHub[] = [];
after(() => closeAll(hubs));

test('neighbours post, chat privately, use rooms and send SOS through one hub', async () => {
  const hub = await startHub('Karrada-1');
  hubs.push(hub);
  const ali = await phone(hub.url);
  await signUp(ali, 'علي');
  await ali.waitForSelector('.status-online');
  await ali.fill('.composer textarea', 'الكهرباء رجعت بشارع 52');
  await ali.click('.composer button.primary');
  await ali.waitForSelector('article.post');

  const zainab = await phone(hub.url);
  await signUp(zainab, 'زينب');
  await zainab.waitForSelector('article.post');
  assert.equal(await zainab.textContent('article.post .text'), 'الكهرباء رجعت بشارع 52');

  await zainab.click('article.post .author');
  await zainab.fill('.send-row input:not([type=file])', 'شلونكم؟');
  await zainab.click('.send-row button.primary');
  await zainab.waitForSelector('.bubble.mine time:has-text("✓")');
  await tab(ali, 3);
  await ali.click('.list li button');
  assert.equal(await ali.textContent('.bubble p'), 'شلونكم؟');

  await tab(ali, 2);
  await ali.fill('.rooms input', 'الكرادة');
  await ali.click('.rooms button.primary');
  await ali.fill('.send-row input', 'منو عنده مولدة؟');
  await ali.click('.send-row button.primary');
  await ali.waitForSelector('.bubble');

  await zainab.click('.sos-btn');
  await zainab.fill('.modal textarea', 'نحتاج دواء ضغط');
  await zainab.click('.modal button.danger');
  await tab(ali, 1);
  await ali.waitForSelector('.sos-item');

  await ali.reload();
  await ali.waitForSelector('article.post');
  const info = await hub.info();
  assert.deepEqual(info.byKind, { dm: 1, post: 1, profile: 2, room: 1, sos: 1 });
});

test('internet hub links a neighbourhood with someone abroad', async () => {
  const local = await startHub('Karrada-1');
  const global = await startHub('Internet');
  hubs.push(local, global);

  const sara = await phone(local.url);
  await signUp(sara, 'سارة');
  await sara.waitForSelector('.status-online');
  await tab(sara, 5);
  await sara.fill('input[placeholder="https://hub.example.org"]', global.url);
  await sara.click('text=إضافة');
  await sara.waitForSelector('.status.mesh:has-text("🌐")');

  const omar = await phone(global.url);
  await signUp(omar, 'عمر');
  await tab(omar, 4);
  await omar.waitForSelector('.list li button');
  await omar.click('.list li button');
  await omar.fill('.send-row input:not([type=file])', 'وصلت عبر الإنترنت');
  await omar.click('.send-row button.primary');

  await tab(sara, 3);
  await sara.click('.list li button');
  assert.equal(await sara.textContent('.bubble p'), 'وصلت عبر الإنترنت');

  await sara.reload();
  await sara.waitForSelector('.status.mesh:has-text("🌐")');
});

test('a device carries data between two hubs that never connect', async () => {
  const a = await startHub('Hub-A');
  const b = await startHub('Hub-B');
  hubs.push(a, b);

  const writer = await phone(a.url);
  await signUp(writer, 'كاتب');
  await writer.fill('.composer textarea', 'خبر من الحي أ');
  await writer.click('.composer button.primary');
  await writer.waitForSelector('article.post');

  // Save the bundle from a device on hub A, load it on a device at hub B.
  await tab(writer, 5);
  const [dl] = await Promise.all([writer.waitForEvent('download'), writer.click('text=حفظ حزمة البيانات')]);
  const file = join(tmpdir(), `bundle-${Date.now()}.ndjson`);
  await dl.saveAs(file);

  const reader = await phone(b.url);
  await signUp(reader, 'قارئ');
  await reader.waitForSelector('.status-online');
  await tab(reader, 5);
  await reader.setInputFiles('.me input[type=file]', file);
  await reader.waitForSelector('text=تمت الإضافة');
  await tab(reader, 1);
  await reader.waitForSelector('article.post');
  assert.equal(await reader.textContent('article.post .text'), 'خبر من الحي أ');
  const info = await b.info();
  assert.equal(info.byKind.post, 1, 'hub B received the carried post');
  writeFileSync(file, '');
});
