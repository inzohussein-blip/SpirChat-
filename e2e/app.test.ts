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

test('images travel separately: thumbnail with the post, full image fetched on tap', async () => {
  const hub = await startHub('Karrada-1');
  hubs.push(hub);
  const { writeFileSync: write } = await import('node:fs');
  // A small valid PNG (red 8x8) written to disk for the file picker.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHQwSAPnjP8H6c8HyAAAAAElFTkSuQmCC',
    'base64',
  );
  const file = join(tmpdir(), `photo-${Date.now()}.png`);
  write(file, png);

  const a = await phone(hub.url);
  await signUp(a, 'مصوّر');
  await a.waitForSelector('.status-online');
  await a.setInputFiles('.composer input[type=file]', file);
  await a.waitForSelector('.composer .preview');
  await a.click('.composer button.primary');
  await a.waitForSelector('article.post img');

  // The hub holds the image separately from the post.
  let info: { byKind: Record<string, number> } = { byKind: {} };
  for (let i = 0; i < 50 && !info.byKind.post; i++) {
    info = await hub.info();
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(info.byKind.post, 1);

  const b = await phone(hub.url);
  await signUp(b, 'مشاهد');
  await b.waitForSelector('article.post .img-hint');
  const before = await b.getAttribute('article.post img', 'src');
  assert.match(before!, /^data:image\//, 'thumbnail first');
  await b.click('article.post .post-img');
  await b.waitForFunction(() => document.querySelector('article.post img')?.getAttribute('src')?.startsWith('blob:'));
});

test('area filter and blocking', async () => {
  const hub = await startHub('Baghdad');
  hubs.push(hub);
  const basra = await phone(hub.url);
  await signUp(basra, 'بصري');
  await tab(basra, 5);
  await basra.selectOption('select:near(:text("المحافظة"))', 'basra');
  await basra.click('form:has(select) button.primary');
  await tab(basra, 1);
  await basra.selectOption('.composer .scope', 'gov');
  await basra.fill('.composer textarea', 'خبر من البصرة');
  await basra.click('.composer button.primary');
  await basra.waitForSelector('article.post');

  const baghdad = await phone(hub.url);
  await signUp(baghdad, 'بغدادي');
  await baghdad.waitForSelector('article.post');
  await tab(baghdad, 5);
  await baghdad.selectOption('select:near(:text("المحافظة"))', 'baghdad');
  await baghdad.click('form:has(select) button.primary');
  await tab(baghdad, 1);
  await baghdad.waitForSelector('.chips');
  assert.equal(await baghdad.locator('article.post').count(), 0, 'Basra post hidden under "near me"');
  await baghdad.click('.chip:not(.on)');
  assert.equal(await baghdad.locator('article.post').count(), 1);

  baghdad.once('dialog', (d) => d.accept());
  await baghdad.click('article.post .more');
  await baghdad.click('.menu button');
  await baghdad.waitForSelector('article.post', { state: 'detached' });
});

test('PIN lock, duress PIN, and a private group of three', async () => {
  const hub = await startHub('Group-Hub');
  hubs.push(hub);
  const [a, b, c] = [await phone(hub.url), await phone(hub.url), await phone(hub.url)];
  await signUp(a, 'أم علي');
  await signUp(b, 'علي');
  await signUp(c, 'زينب');
  for (const p of [a, b, c]) await p.waitForSelector('.status-online');

  // a creates a group with b and c once their profiles have arrived.
  await tab(a, 3);
  await a.click('text=مجموعة جديدة');
  await a.waitForSelector('.pick-list li:nth-child(2)');
  await a.fill('input[maxlength="40"]', 'العائلة');
  for (const box of await a.locator('.pick-list input').all()) await box.check();
  await a.click('button:has-text("إنشاء")');
  await a.fill('.send-row input:not([type=file])', 'تجمعنا الساعة 6');
  await a.click('.send-row button.primary');

  for (const p of [b, c]) {
    await tab(p, 3);
    await p.click('.list li button:has-text("العائلة")');
    await p.waitForSelector('.bubble p:has-text("تجمعنا الساعة 6")');
  }
  await c.fill('.send-row input:not([type=file])', 'تمام');
  await c.click('.send-row button.primary');
  await a.waitForSelector('.bubble p:has-text("تمام")');
  assert.equal(await a.textContent('.bubble:not(.mine) small'), 'زينب');

  // My QR code renders.
  await tab(b, 3);
  await b.click('.list li button:has-text("العائلة")').catch(() => {});
  await b.click('text=رجوع').catch(() => {});
  await b.click('text=رمزي');
  await b.waitForSelector('.qr svg');
  await b.click('.modal');

  // b sets a PIN and a duress PIN; reload shows the lock screen.
  await tab(b, 5);
  await b.fill('input:near(:text("رمز PIN جديد"))', '2580');
  await b.fill('input:near(:text("رمز الإكراه"))', '0000');
  await b.click('form:has(input[type=password]) button.primary');
  await b.waitForSelector('text=قفل الآن');
  await b.reload();
  await b.waitForSelector('text=أدخل رمز PIN');
  await b.fill('input[type=password]', '1111');
  await b.click('button.primary');
  await b.waitForSelector('text=رمز غير صحيح');
  await b.fill('input[type=password]', '2580');
  await b.click('button.primary');
  await b.waitForSelector('.tabs');
  await tab(b, 3);
  await b.waitForSelector('.list li button:has-text("العائلة")');

  // Duress PIN: everything gone, an empty account opens.
  await b.reload();
  await b.fill('input[type=password]', '0000');
  await b.click('button.primary');
  await b.waitForSelector('.tabs');
  await tab(b, 3);
  assert.equal(await b.locator('.list li button:has-text("العائلة")').count(), 0);
});
