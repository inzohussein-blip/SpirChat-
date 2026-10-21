import { useState } from 'preact/hooks';
import { ago, t } from '../lib/i18n.ts';
import { useApp } from '../lib/state.ts';

export function People({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const app = useApp();
  const [q, setQ] = useState('');
  const people = [...app.profiles()]
    .filter(([id, p]) => id !== app.me?.id && p.name.toLowerCase().includes(q.trim().toLowerCase()))
    .sort((a, b) => b[1].ts - a[1].ts);

  return (
    <div class="people">
      <p class="hint">{t('peopleHint')}</p>
      <input class="search" value={q} placeholder={t('search')} onInput={(e) => setQ(e.currentTarget.value)} />
      {!people.length && <p class="empty">{t('noPeople')}</p>}
      <ul class="list">
        {people.map(([id, p]) => (
          <li key={id}>
            <button onClick={() => onOpenChat(id)}>
              <strong>{p.name}</strong>
              {p.bio && <span class="preview-text">{p.bio}</span>}
              <time>{ago(p.ts)}</time>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
