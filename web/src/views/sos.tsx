import { useState } from 'preact/hooks';
import type { SosBody } from '@spirchat/protocol';
import { t } from '../lib/i18n.ts';
import { app } from '../lib/state.ts';

/** Rounds to 3 decimals (~100 m) so an SOS never pinpoints a home. */
const coarse = (n: number) => Math.round(n * 1000) / 1000;

export function SosDialog({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [shareLoc, setShareLoc] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const body: SosBody = { text: text.trim() };
      if (shareLoc) {
        const pos = await new Promise<GeolocationPosition>((resolve, reject) =>
          navigator.geolocation.getCurrentPosition(resolve, reject, { timeout: 15_000, maximumAge: 60_000 }),
        );
        body.loc = { lat: coarse(pos.coords.latitude), lon: coarse(pos.coords.longitude) };
      }
      await app.publishSigned('sos', body);
      onClose();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div class="modal" role="dialog" aria-modal="true">
      <form class="card" onSubmit={submit}>
        <h2>🆘 {t('sosTitle')}</h2>
        <p class="hint">{t('sosHint')}</p>
        <textarea value={text} maxLength={280} rows={3} required onInput={(e) => setText(e.currentTarget.value)} />
        <label class="check">
          <input type="checkbox" checked={shareLoc} onChange={(e) => setShareLoc(e.currentTarget.checked)} />
          {t('sosShareLoc')}
        </label>
        {shareLoc && <p class="warn">{t('sosLocWarn')}</p>}
        {error && <p class="error">{error}</p>}
        <div class="row">
          <button type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button class="danger" disabled={busy || !text.trim()}>
            {t('sosSend')}
          </button>
        </div>
      </form>
    </div>
  );
}
