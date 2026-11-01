import { useEffect, useRef, useState } from 'preact/hooks';
import { fingerprint } from '@spirchat/protocol';
import { ago, t } from '../lib/i18n.ts';
import { compressImage } from '../lib/image.ts';
import { app, TTL_CHOICES, useApp } from '../lib/state.ts';
import { MyQr, QrScanner } from './qr.tsx';

const isGroup = (key: string) => key.startsWith('g:');

function title(key: string): string {
  return isGroup(key) ? `👥 ${app.groups.get(key.slice(2))?.name ?? '…'}` : app.nameOf(key);
}

function NewGroup({ onDone }: { onDone: (key: string | null) => void }) {
  const [name, setName] = useState('');
  const [members, setMembers] = useState<Set<string>>(new Set());
  const people = [...app.profiles()].filter(([id]) => id !== app.me?.id && !app.blocked.has(id));
  return (
    <form
      class="card"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!name.trim() || !members.size) return;
        const id = await app.createGroup(name.trim(), [...members]);
        onDone(`g:${id}`);
      }}
    >
      <h2>👥 {t('newGroup')}</h2>
      <label>
        {t('groupName')}
        <input value={name} maxLength={40} required onInput={(e) => setName(e.currentTarget.value)} />
      </label>
      <p class="hint">{t('groupMembers')}</p>
      <ul class="pick-list">
        {people.map(([id, p]) => (
          <li key={id}>
            <label class="check">
              <input
                type="checkbox"
                checked={members.has(id)}
                onChange={(e) => {
                  const next = new Set(members);
                  if (e.currentTarget.checked) next.add(id);
                  else next.delete(id);
                  setMembers(next);
                }}
              />
              {p.name}
            </label>
          </li>
        ))}
      </ul>
      <div class="row">
        <button type="button" onClick={() => onDone(null)}>
          {t('cancel')}
        </button>
        <button class="primary" disabled={!name.trim() || !members.size}>
          {t('create')}
        </button>
      </div>
    </form>
  );
}

export function Chats({ peer, setPeer }: { peer: string | null; setPeer: (id: string | null) => void }) {
  const app = useApp();
  const [creating, setCreating] = useState(false);
  const [qr, setQr] = useState<'show' | 'scan' | null>(null);
  if (peer) return <Conversation peer={peer} onBack={() => setPeer(null)} />;
  if (creating) {
    return (
      <NewGroup
        onDone={(k) => {
          setCreating(false);
          if (k) setPeer(k);
        }}
      />
    );
  }
  const convs = app.conversations();
  // Groups appear even before their first message.
  for (const g of app.groups.keys()) if (!convs.has(`g:${g}`)) convs.set(`g:${g}`, []);
  const sorted = [...convs].sort((a, b) => (b[1].at(-1)?.ts ?? 0) - (a[1].at(-1)?.ts ?? 0));
  return (
    <div class="chats">
      <div class="row toolbar">
        <button onClick={() => setCreating(true)}>👥 {t('newGroup')}</button>
        <button onClick={() => setQr('show')}>🔳 {t('myQr')}</button>
        <button onClick={() => setQr('scan')}>📷 {t('scanQr')}</button>
      </div>
      {qr === 'show' && (
        <div class="modal" role="dialog" aria-modal="true" onClick={() => setQr(null)}>
          <div class="card center">
            <h2>{t('myQr')}</h2>
            <MyQr />
            <p class="hint">{t('myQrHint')}</p>
          </div>
        </div>
      )}
      {qr === 'scan' && (
        <QrScanner
          onClose={() => setQr(null)}
          onResult={(id) => {
            void app.setVerified(id);
            setQr(null);
            setPeer(id);
          }}
        />
      )}
      {!sorted.length && <p class="empty">{t('noChats')}</p>}
      <ul class="list">
        {sorted.map(([key, msgs]) => {
          const last = msgs.at(-1);
          return (
            <li key={key}>
              <button onClick={() => setPeer(key)}>
                <strong>
                  {title(key)} {!isGroup(key) && app.verified.has(key) && '✅'}
                </strong>
                <span class="preview-text">{last ? last.text || (last.audio ? '🎙' : '📷') : ''}</span>
                {last && <time>{ago(last.ts)}</time>}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const MAX_VOICE_SECONDS = 60;

/** Records a short low-bitrate voice note. Needs a secure context (the app, or https). */
function VoiceButton({ onDone }: { onDone: (dataUrl: string) => void }) {
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  const start = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mimeType = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) =>
      MediaRecorder.isTypeSupported(m),
    );
    const r = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 12_000 });
    const chunks: Blob[] = [];
    r.ondataavailable = (e) => chunks.push(e.data);
    r.onstop = () => {
      stream.getTracks().forEach((tr) => tr.stop());
      const blob = new Blob(chunks, { type: r.mimeType });
      if (!blob.size || blob.size > 150_000) return;
      const reader = new FileReader();
      reader.onload = () => onDone(String(reader.result));
      reader.readAsDataURL(blob);
    };
    r.start();
    setRec(r);
    setTimeout(() => r.state === 'recording' && r.stop(), MAX_VOICE_SECONDS * 1000);
  };
  return (
    <button
      type="button"
      class={rec ? 'recording' : ''}
      title={rec ? t('stopRecord') : t('record')}
      onClick={() => {
        if (rec) {
          rec.stop();
          setRec(null);
        } else {
          void start().catch(() => setRec(null));
        }
      }}
    >
      {rec ? '⏹' : '🎙'}
    </button>
  );
}

const ttlLabel = (ms: number) =>
  ms === 0 ? t('ttlOff') : ms <= 3600_000 ? t('ttlHour') : ms <= 86_400_000 ? t('ttlDay') : t('ttlWeek');

function Conversation({ peer, onBack }: { peer: string; onBack: () => void }) {
  useApp();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);
  const msgs = app.conversations().get(peer) ?? [];
  const group = isGroup(peer) ? app.groups.get(peer.slice(2)) : undefined;
  const ttl = app.ttls[peer] ?? 0;

  useEffect(() => end.current?.scrollIntoView(), [msgs.length]);

  const send = (content: { text: string; image?: string; audio?: string }) =>
    group ? app.sendGroup(group.id, content) : app.sendDirect(peer, content);

  const sendImage = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const { image } = await compressImage(file);
      await send({ text: '', image });
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
          <h2>
            {title(peer)} {!group && app.verified.has(peer) && <span title={t('verified')}>✅</span>}
          </h2>
          {group ? (
            <small>
              {group.members.length} {t('members')}: {group.members.map((m) => app.nameOf(m)).join('، ')}
            </small>
          ) : (
            <small title={t('verify')} dir="ltr">
              🔒 {fingerprint(peer)}
            </small>
          )}
        </div>
        <select
          class="ttl"
          title={t('disappearing')}
          value={ttl}
          onChange={(e) => void app.setTtl(peer, Number(e.currentTarget.value))}
        >
          {TTL_CHOICES.map((ms) => (
            <option key={ms} value={ms}>
              ⏱ {ttlLabel(ms)}
            </option>
          ))}
        </select>
        {!group && (
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
        )}
      </header>
      <p class="hint">{t('encrypted')}</p>
      <div class="messages">
        {msgs.map((m) => (
          <div key={m.id} class={`bubble ${m.mine ? 'mine' : ''}`}>
            {group && !m.mine && <small>{app.nameOf(m.from)}</small>}
            {m.image && <img src={m.image} alt="" />}
            {m.audio && <audio controls preload="none" src={m.audio} />}
            {m.text && <p>{m.text}</p>}
            <time>
              {ago(m.ts)} {m.exp - m.ts <= 7 * 86_400_000 && '⏱'} {m.mine && (app.atHub.has(m.id) ? '✓' : '🕓')}
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
            await send({ text: text.trim() });
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
        <VoiceButton onDone={(audio) => void send({ text: '', audio })} />
        <input value={text} maxLength={4000} placeholder={t('message')} onInput={(e) => setText(e.currentTarget.value)} />
        <button class="primary" disabled={busy}>
          {t('send')}
        </button>
      </form>
    </div>
  );
}
