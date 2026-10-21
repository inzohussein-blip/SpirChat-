import { useEffect, useRef, useState } from 'preact/hooks';
import type { RoomBody } from '@spirchat/protocol';
import { ago, t } from '../lib/i18n.ts';
import { app, useApp } from '../lib/state.ts';

const normalize = (s: string) => s.trim().toLowerCase().replace(/\s+/g, '-');

export function Rooms() {
  const app = useApp();
  const [room, setRoom] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const counts = new Map<string, { n: number; last: number }>();
  for (const e of app.ofKind('room')) {
    const r = (e.body as RoomBody).room;
    const c = counts.get(r) ?? { n: 0, last: e.ts };
    counts.set(r, { n: c.n + 1, last: Math.max(c.last, e.ts) });
  }

  if (room) return <Room room={room} onBack={() => setRoom(null)} />;

  return (
    <div class="rooms">
      <p class="hint">{t('roomsHint')}</p>
      <form
        class="row card"
        onSubmit={(e) => {
          e.preventDefault();
          const r = normalize(draft);
          if (/^[\p{L}\p{N}_-]{1,32}$/u.test(r)) setRoom(r);
        }}
      >
        <input value={draft} maxLength={32} placeholder={t('roomName')} onInput={(e) => setDraft(e.currentTarget.value)} />
        <button class="primary">{t('join')}</button>
      </form>
      <ul class="list">
        {[...counts]
          .sort((a, b) => b[1].last - a[1].last)
          .map(([r, c]) => (
            <li key={r}>
              <button onClick={() => setRoom(r)}>
                <strong># {r}</strong>
                <span>
                  {c.n} · {ago(c.last)}
                </span>
              </button>
            </li>
          ))}
      </ul>
    </div>
  );
}

function Room({ room, onBack }: { room: string; onBack: () => void }) {
  useApp();
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const msgs = app
    .ofKind('room')
    .filter((e) => (e.body as RoomBody).room === room)
    .reverse()
    .slice(-300);

  useEffect(() => end.current?.scrollIntoView(), [msgs.length]);

  return (
    <div class="thread">
      <header class="thread-head">
        <button class="link" onClick={onBack}>
          {t('back')}
        </button>
        <h2># {room}</h2>
      </header>
      <div class="messages">
        {msgs.map((e) => (
          <div key={e.id} class={`bubble ${e.author === app.me?.id ? 'mine' : ''}`}>
            <small>{app.nameOf(e.author!)}</small>
            <p>{(e.body as RoomBody).text}</p>
            <time>{ago(e.ts)}</time>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form
        class="send-row"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!text.trim()) return;
          await app.publishSigned('room', { room, text: text.trim() });
          setText('');
        }}
      >
        <input value={text} maxLength={2000} placeholder={t('message')} onInput={(e) => setText(e.currentTarget.value)} />
        <button class="primary">{t('send')}</button>
      </form>
    </div>
  );
}
