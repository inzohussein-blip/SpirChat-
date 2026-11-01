import { useEffect, useRef, useState } from 'preact/hooks';
import { fingerprint } from '@spirchat/protocol';
import { ago, t } from '../lib/i18n.ts';
import { compressImage } from '../lib/image.ts';
import { app, useApp } from '../lib/state.ts';

export function Chats({ peer, setPeer }: { peer: string | null; setPeer: (id: string | null) => void }) {
  const app = useApp();
  if (peer) return <Conversation peer={peer} onBack={() => setPeer(null)} />;
  const convs = [...app.conversations()].sort((a, b) => b[1].at(-1)!.ts - a[1].at(-1)!.ts);
  if (!convs.length) return <p class="empty">{t('noChats')}</p>;
  return (
    <ul class="list">
      {convs.map(([id, msgs]) => {
        const last = msgs.at(-1)!;
        return (
          <li key={id}>
            <button onClick={() => setPeer(id)}>
              <strong>{app.nameOf(id)}</strong>
              <span class="preview-text">{last.text || '📷'}</span>
              <time>{ago(last.ts)}</time>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function Conversation({ peer, onBack }: { peer: string; onBack: () => void }) {
  useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const msgs = app.conversations().get(peer) ?? [];

  useEffect(() => end.current?.scrollIntoView(), [msgs.length]);

  const sendImage = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const { image } = await compressImage(file);
      await app.sendDirect(peer, { text: '', image });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="thread">
      <header class="thread-head">
        <button class="link" onClick={onBack}>
          {t('back')}
        </button>
        <div>
          <h2>{app.nameOf(peer)}</h2>
          <small title={t('verify')} dir="ltr">
            🔒 {fingerprint(peer)}
          </small>
        </div>
        <button
          class="link block-btn"
          title={t('block')}
          onClick={() => {
            if (confirm(t('blockConfirm'))) {
              void app.block(peer, true);
              onBack();
            }
          }}
        >
          🚫
        </button>
      </header>
      <p class="hint">{t('encrypted')}</p>
      <div class="messages">
        {msgs.map((m) => (
          <div key={m.id} class={`bubble ${m.mine ? 'mine' : ''}`}>
            {m.image && <img src={m.image} alt="" />}
            {m.text && <p>{m.text}</p>}
            <time>
              {ago(m.ts)} {m.mine && (app.atHub.has(m.id) ? '✓' : '🕓')}
            </time>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        class="send-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          setBusy(true);
          try {
            await app.sendDirect(peer, { text: text.trim() });
            setText('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label class="file-btn" aria-label={t('addPhoto')}>
          📷
          <input type="file" accept="image/*" hidden onChange={sendImage} />
        </label>
        <input value={text} maxLength={4000} placeholder={t('message')} onInput={(e) => setText(e.currentTarget.value)} />
        <button class="primary" disabled={busy}>
          {t('send')}
        </button>
      </form>
    </div>
  );
}
