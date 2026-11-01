import { useState } from 'preact/hooks';
import { t } from '../lib/i18n.ts';
import { app, useApp } from '../lib/state.ts';

/** Shown at start when a PIN protects the identity. */
export function PinScreen() {
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  return (
    <form
      class="onboarding"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        const ok = await app.unlock(pin);
        setBusy(false);
        if (!ok) {
          setError(true);
          setPin('');
        }
      }}
    >
      <h1>🔒 {t('appName')}</h1>
      <label>
        {t('enterPin')}
        <input
          type="password"
          inputMode="numeric"
          autoComplete="off"
          value={pin}
          autoFocus
          onInput={(e) => setPin(e.currentTarget.value)}
        />
      </label>
      {error && <p class="error">{t('wrongPin')}</p>}
      <button class="primary" disabled={busy || pin.length < 4}>
        {busy ? t('loading') : t('unlock')}
      </button>
    </form>
  );
}

export function SecurityCard() {
  const app = useApp();
  const [pin, setPin] = useState('');
  const [duress, setDuress] = useState('');
  const [error, setError] = useState('');
  return (
    <section class="card">
      <h2>🔐 {t('security')}</h2>
      {app.hasPin ? (
        <>
          <p>{t('pinOn')}</p>
          <div class="row">
            <button onClick={() => location.reload()}>🔒 {t('lockNow')}</button>
            <button class="link" onClick={() => void app.removePin()}>
              {t('removePin')}
            </button>
          </div>
        </>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (pin.length < 4) return setError(t('pinTooShort'));
            if (duress && duress === pin) return setError(t('duressSame'));
            setError('');
            await app.setPin(pin, duress || undefined);
            setPin('');
            setDuress('');
          }}
        >
          <p class="hint">{t('pinHint')}</p>
          <label>
            {t('newPin')}
            <input type="password" inputMode="numeric" value={pin} onInput={(e) => setPin(e.currentTarget.value)} />
          </label>
          <label>
            {t('duressPin')}
            <input type="password" inputMode="numeric" value={duress} onInput={(e) => setDuress(e.currentTarget.value)} />
          </label>
          <p class="warn">{t('duressHint')}</p>
          {error && <p class="error">{error}</p>}
          <button class="primary">{t('save')}</button>
        </form>
      )}
    </section>
  );
}
