import { useState } from 'preact/hooks';
import { type AlertBody, fingerprint } from '@spirchat/protocol';
import { type Lang, lang, setLang, t } from '../lib/i18n.ts';
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

function DataMule() {
  const [result, setResult] = useState('');
  return (
    <section class="card">
      <h2>{t('dataMule')}</h2>
      <a class="button" href="/api/export" download>
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
            const res = await fetch('/api/envelopes', { method: 'POST', body: await file.text() });
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
