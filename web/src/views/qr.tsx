import { useEffect, useRef, useState } from 'preact/hooks';
import qrcode from 'qrcode-generator';
import { t } from '../lib/i18n.ts';
import { app } from '../lib/state.ts';

const PREFIX = 'spirchat:';

/** My contact card as a QR code: "spirchat:<id>". */
export function MyQr() {
  const me = app.me!;
  const qr = qrcode(0, 'M');
  qr.addData(`${PREFIX}${me.id}`);
  qr.make();
  return (
    <div class="qr" dangerouslySetInnerHTML={{ __html: qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }) }} />
  );
}

export function parseContact(text: string): string | null {
  const t = text.trim();
  if (!t.startsWith(PREFIX)) return null;
  const id = t.slice(PREFIX.length);
  return /^[A-Za-z0-9_-]{43}$/.test(id) ? id : null;
}

/** Camera scanner. Needs a secure context (the Android app, or https). */
export function QrScanner({ onResult, onClose }: { onResult: (id: string) => void; onClose: () => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    // The decoder is large; it is only downloaded when someone actually scans.
    let jsQR: typeof import('jsqr').default | null = null;
    void import('jsqr').then((m) => (jsQR = m.default));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    const tick = () => {
      const v = video.current;
      if (v && v.readyState >= 2 && jsQR) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
        ctx.drawImage(v, 0, 0);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height);
        const id = code && parseContact(code.data);
        if (id) return onResult(id);
      }
      raf = requestAnimationFrame(tick);
    };
    if (!navigator.mediaDevices?.getUserMedia) {
      setError(t('cameraUnavailable'));
    } else {
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: 'environment' } })
        .then((s) => {
          stream = s;
          if (video.current) {
            video.current.srcObject = s;
            void video.current.play();
          }
          raf = requestAnimationFrame(tick);
        })
        .catch(() => setError(t('cameraUnavailable')));
    }
    return () => {
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, []);

  return (
    <div class="modal" role="dialog" aria-modal="true">
      <div class="card">
        <h2>📷 {t('scanQr')}</h2>
        {error ? <p class="error">{error}</p> : <video ref={video} class="scanner" playsInline muted />}
        <button class="wide" onClick={onClose}>
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}
