import { useState } from 'preact/hooks';
import { fromB64u } from '@spirchat/protocol';
import { t } from '../lib/i18n.ts';
import { app } from '../lib/state.ts';

export function Onboarding() {
  const [name, setName] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState('');

  const submit = async (e: Event) => {
    e.preventDefault();
    try {
      const seed = restoring ? fromB64u(code.trim()) : undefined;
      if (seed && seed.length !== 32) throw new Error('invalid code');
      await app.createAccount(name.trim(), seed);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <form class="onboarding" onSubmit={submit}>
      <h1>{t('welcomeTitle')}</h1>
      <p>{t('welcomeText')}</p>
      <label>
        {t('yourName')}
        <input value={name} maxLength={40} required={!restoring} onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      {restoring && (
        <label>
          {t('restoreCode')}
          <input value={code} dir="ltr" required onInput={(e) => setCode(e.currentTarget.value)} />
        </label>
      )}
      {error && <p class="error">{error}</p>}
      <button class="primary" type="submit">
        {t('start')}
      </button>
      {!restoring && (
        <button type="button" class="link" onClick={() => setRestoring(true)}>
          {t('restore')}
        </button>
      )}
      <p class="hint">{t('safety')}</p>
    </form>
  );
}
