import { useState } from 'preact/hooks';
import type { AlertBody } from '@spirchat/protocol';
import { t } from './lib/i18n.ts';
import { useApp } from './lib/state.ts';
import { Feed } from './views/feed.tsx';
import { Rooms } from './views/rooms.tsx';
import { Chats } from './views/chats.tsx';
import { People } from './views/people.tsx';
import { Me } from './views/me.tsx';
import { Onboarding } from './views/onboarding.tsx';
import { SosDialog } from './views/sos.tsx';

export type Tab = 'feed' | 'rooms' | 'chats' | 'people' | 'me';

const TABS: { id: Tab; icon: string }[] = [
  { id: 'feed', icon: '🏠' },
  { id: 'rooms', icon: '👥' },
  { id: 'chats', icon: '💬' },
  { id: 'people', icon: '🧭' },
  { id: 'me', icon: '⚙️' },
];

function Alerts() {
  const app = useApp();
  const now = Date.now();
  const alerts = app.ofKind('alert').filter((e) => app.isOfficial(e) && e.exp > now).slice(0, 3);
  if (!alerts.length) return null;
  return (
    <div class="alerts">
      {alerts.map((e) => {
        const b = e.body as AlertBody;
        return (
          <div key={e.id} class={`alert alert-${b.level}`} role="alert">
            <strong>✔ {t('alertOfficial')}: {b.title}</strong>
            <p>{b.text}</p>
          </div>
        );
      })}
    </div>
  );
}

export function App() {
  const app = useApp();
  const [tab, setTab] = useState<Tab>('feed');
  const [peer, setPeer] = useState<string | null>(null);
  const [sos, setSos] = useState(false);

  if (!app.me) return <Onboarding />;

  const openChat = (id: string) => {
    setPeer(id);
    setTab('chats');
  };
  const status = app.hub.status;

  return (
    <div class="shell">
      <header class="top">
        <div class="brand">
          <h1>{t('appName')}</h1>
          <span class={`status status-${status}`}>
            {status === 'online' && app.hub.name ? `${t('online')} · ${app.hub.name}` : t(status)}
          </span>
          {app.internetOnline && <span class="status mesh">🌐</span>}
          {app.meshRunning && <span class="status mesh">📡 {app.peers}</span>}
        </div>
        <button class="sos-btn" onClick={() => setSos(true)}>
          {t('sos')}
        </button>
      </header>
      <Alerts />
      <main>
        {tab === 'feed' && <Feed onOpenChat={openChat} />}
        {tab === 'rooms' && <Rooms />}
        {tab === 'chats' && <Chats peer={peer} setPeer={setPeer} />}
        {tab === 'people' && <People onOpenChat={openChat} />}
        {tab === 'me' && <Me />}
      </main>
      <nav class="tabs">
        {TABS.map((x) => (
          <button
            key={x.id}
            class={tab === x.id ? 'active' : ''}
            onClick={() => {
              setTab(x.id);
              if (x.id !== 'chats') setPeer(null);
            }}
          >
            <span aria-hidden="true">{x.icon}</span>
            {t(x.id)}
          </button>
        ))}
      </nav>
      {sos && <SosDialog onClose={() => setSos(false)} />}
    </div>
  );
}
