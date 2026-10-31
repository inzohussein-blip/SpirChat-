import { useEffect, useState } from 'preact/hooks';
import { type AlertBody, fingerprint } from '@spirchat/protocol';
import { type Lang, lang, setLang, t } from '../lib/i18n.ts';
import { native } from '../lib/native.ts';
import { app, useApp } from '../lib/state.ts';

function ProfileForm() {
  const me = app.me!;
  const current = app.profiles().get(me.id);
  const [name, setName] = useState(current?.name ?? '');
  const [bio, setBio] = useState(current?.bio ?? '');
  const [saved, setSaved] = useState(false);
  return (
    <form
      class="card"
      onSubmit={async (e) => {
        e.preventDefault();
        await app.publishSigned('profile', { name: name.trim(), ...(bio.trim() ? { bio: bio.trim() } : {}) });
        setSaved(true);
      }}
    >
      <h2>{t('profile')}</h2>
      <label>
        {t('yourName')}
        <input value={name} maxLength={40} required onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <label>
        {t('bio')}
        <input value={bio} maxLength={160} onInput={(e) => setBio(e.currentTarget.value)} />
      </label>
      <button class="primary">{saved ? t('saved') : t('save')}</button>
    </form>
  );
}

function AlertForm() {
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [level, setLevel] = useState<AlertBody['level']>('warning');
  return (
    <form
      class="card"
      onSubmit={async (e) => {
        e.preventDefault();
        await app.publishSigned('alert', { title: title.trim(), text: text.trim(), level });
        setTitle('');
        setText('');
      }}
    >
      <h2>{t('newAlert')}</h2>
      <label>
        {t('alertTitle')}
        <input value={title} maxLength={100} required onInput={(e) => setTitle(e.currentTarget.value)} />
      </label>
      <label>
        {t('alertText')}
        <textarea value={text} maxLength={1000} rows={3} onInput={(e) => setText(e.currentTarget.value)} />
      </label>
      <label>
        {t('level')}
        <select value={level} onChange={(e) => setLevel(e.currentTarget.value as AlertBody['level'])}>
          <option value="info">{t('info')}</option>
          <option value="warning">{t('warning')}</option>
          <option value="danger">{t('danger')}</option>
        </select>
      </label>
      <button class="primary">{t('send')}</button>
    </form>
  );
}

function Mesh() {
  const app = useApp();
  return (
    <section class="card">
      <h2>📡 {t('mesh')}</h2>
      <p class="hint">{t('meshHint')}</p>
      <div class="row">
        <span>
          {t('nearby')}: <strong>{app.peers}</strong>
        </span>
        <button class={app.meshRunning ? '' : 'primary'} onClick={() => app.setMesh(!app.meshRunning)}>
          {app.meshRunning ? t('meshOff') : t('meshOn')}
        </button>
      </div>
      <label class="check">
        <input
          type="checkbox"
          checked={app.settings.background}
          onChange={(e) => void app.updateSettings({ background: e.currentTarget.checked })}
        />
        {t('background')}
      </label>
      <p class="hint">{t('backgroundHint')}</p>
      <hr />
      <button class="wide" onClick={() => native?.shareApp()}>
        📲 {t('shareApp')}
      </button>
      <p class="hint">{t('shareAppHint')}</p>
    </section>
  );
}

function Internet() {
  const app = useApp();
  const [draft, setDraft] = useState('');
  const { internetHubs, internetEnabled } = app.settings;
  const internet = app.hubs.filter((h) => h.internet);
  const add = (e: Event) => {
    e.preventDefault();
    const url = draft.trim().replace(/\/+$/, '');
    if (!url) return;
    const full = /^\w+:\/\//.test(url) ? url : `https://${url}`;
    if (!internetHubs.includes(full)) void app.updateSettings({ internetHubs: [...internetHubs, full] });
    setDraft('');
  };
  return (
    <section class="card">
      <h2>🌐 {t('internet')}</h2>
      <p class="hint">{t('internetHint')}</p>
      <label class="check">
        <input
          type="checkbox"
          checked={internetEnabled}
          onChange={(e) => void app.updateSettings({ internetEnabled: e.currentTarget.checked })}
        />
        {t('internetUse')}
      </label>
      <ul class="hub-list">
        {internetHubs.map((url) => {
          const st = internet.find((h) => h.url.replace(/\/+$/, '') === url.replace(/\/+$/, ''));
          return (
            <li key={url}>
              <span class={`status status-${internetEnabled ? (st?.state ?? 'offline') : 'offline'}`} dir="ltr">
                {st?.name ? `${st.name} · ` : ''}
                {url}
              </span>
              <button
                class="link"
                onClick={() => void app.updateSettings({ internetHubs: internetHubs.filter((u) => u !== url) })}
              >
                ✕
              </button>
            </li>
          );
        })}
      </ul>
      <form class="row" onSubmit={add}>
        <input value={draft} dir="ltr" placeholder="https://hub.example.org" onInput={(e) => setDraft(e.currentTarget.value)} />
        <button class="primary">{t('add')}</button>
      </form>
      <p class="warn">{t('internetPrivacy')}</p>
    </section>
  );
}

function GetApp() {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    fetch('/spirchat.apk', { method: 'HEAD' })
      .then((r) => setAvailable(r.ok && !(r.headers.get('content-type') ?? '').includes('html')))
      .catch(() => {});
  }, []);
  if (!available) return null;
  return (
    <section class="card">
      <a class="button primary wide" href="/spirchat.apk" download>
        🤖 {t('getApp')}
      </a>
      <p class="hint">{t('getAppHint')}</p>
    </section>
  );
}

function HubAddress() {
  const [addr, setAddr] = useState(app.settings.manualHub);
  return (
    <form
      class="card"
      onSubmit={(e) => {
        e.preventDefault();
        void app.updateSettings({ manualHub: addr.trim() });
      }}
    >
      <h2>{t('hubAddress')}</h2>
      <div class="row">
        <input value={addr} dir="ltr" placeholder="10.42.0.1" onInput={(e) => setAddr(e.currentTarget.value)} />
        <button class="primary">{t('save')}</button>
      </div>
      <p class="hint">{t('hubAddressHint')}</p>
    </form>
  );
}

function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Carrying data by hand: from this device to a USB stick, another phone or another hub. */
function DataMule() {
  const [result, setResult] = useState('');
  return (
    <section class="card">
      <h2>{t('dataMule')}</h2>
      <p class="hint">{t('dataMuleHint')}</p>
      <button
        class="wide"
        onClick={() =>
          native ? native.exportBundle() : download(`spirchat-${Date.now()}.ndjson`, app.exportBundle())
        }
      >
        ⬇️ {t('export')}
      </button>
      <label class="file-btn wide">
        ⬆️ {t('import')}
        <input
          type="file"
          accept=".ndjson,.json,application/x-ndjson,application/json,text/plain"
          hidden
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            if (!file) return;
            const added = await app.importBundle(await file.text());
            setResult(`${t('imported')}: ${added}`);
          }}
        />
      </label>
      {result && <p class="hint">{result}</p>}
    </section>
  );
}

export function Me() {
  const app = useApp();
  const me = app.me!;
  const [reveal, setReveal] = useState(false);

  return (
    <div class="me">
      <ProfileForm />
      {native ? <Mesh /> : <GetApp />}
      <Internet />
      {app.alertKeys.has(me.id) && <AlertForm />}
      <section class="card">
        <h2>{t('yourId')}</h2>
        <code class="mono" dir="ltr">
          {me.id}
        </code>
        <p class="hint" dir="ltr">
          🔒 {fingerprint(me.id)}
        </p>
        <h2>{t('backup')}</h2>
        <p class="warn">{t('backupWarn')}</p>
        {reveal ? (
          <code class="mono" dir="ltr">
            {app.backupCode()}
          </code>
        ) : (
          <button onClick={() => setReveal(true)}>{t('reveal')}</button>
        )}
      </section>
      <section class="card">
        <h2>{t('hubInfo')}</h2>
        <p>
          {app.hub.name ?? '—'} · {t(app.hub.status)}
        </p>
        <p>
          🌐 {t('internet')}: {app.internetOnline ? t('online') : t('offline')}
        </p>
        <p>
          {t('carrying')}: <strong>{app.envelopes.size}</strong>
        </p>
        <p class="hint">{t('carryHint')}</p>
      </section>
      <DataMule />
      {native && <HubAddress />}
      <section class="card">
        <h2>{t('language')}</h2>
        <select
          value={lang}
          onChange={(e) => {
            setLang(e.currentTarget.value as Lang);
            app.changed();
          }}
        >
          <option value="ar">العربية</option>
          <option value="en">English</option>
        </select>
      </section>
      <p class="hint">{t('safety')}</p>
      <button
        class="danger wide"
        onClick={() => {
          if (confirm(t('wipeConfirm'))) void app.wipe();
        }}
      >
        {t('wipe')}
      </button>
    </div>
  );
}
