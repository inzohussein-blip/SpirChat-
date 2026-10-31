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
          {t('nearby')}: <strong>{app.peers.size}</strong>
        </span>
        <button class={app.meshRunning ? '' : 'primary'} onClick={() => app.setMesh(!app.meshRunning)}>
          {app.meshRunning ? t('meshOff') : t('meshOn')}
        </button>
      </div>
      <hr />
      <button class="wide" onClick={() => native?.shareApp()}>
        📲 {t('shareApp')}
      </button>
      <p class="hint">{t('shareAppHint')}</p>
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
  const [addr, setAddr] = useState(app.manualHub);
  return (
    <form
      class="card"
      onSubmit={(e) => {
        e.preventDefault();
        void app.setManualHub(addr);
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

function DataMule() {
  const [result, setResult] = useState('');
  const base = app.hubBase;
  if (app.hub.status === 'offline' || app.hub.status === 'connecting') return null;
  return (
    <section class="card">
      <h2>{t('dataMule')}</h2>
      <a
        class="button"
        href={`${base}/api/export`}
        download
        onClick={(e) => {
          if (!native) return;
          e.preventDefault();
          native.openUrl(`${base}/api/export`);
        }}
      >
        ⬇️ {t('export')}
      </a>
      <label class="file-btn">
        ⬆️ {t('import')}
        <input
          type="file"
          accept=".ndjson,.json,application/x-ndjson"
          hidden
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            if (!file) return;
            const res = await fetch(`${base}/api/envelopes`, { method: 'POST', body: await file.text() });
            const r = (await res.json()) as { added?: number; error?: string };
            setResult(r.error ?? `${t('imported')}: ${r.added}`);
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
