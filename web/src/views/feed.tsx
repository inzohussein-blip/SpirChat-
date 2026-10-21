import { useState } from 'preact/hooks';
import type { PostBody, SosBody } from '@spirchat/protocol';
import { ago, t } from '../lib/i18n.ts';
import { compressImage } from '../lib/image.ts';
import { app, useApp } from '../lib/state.ts';

function Composer() {
  const [text, setText] = useState('');
  const [img, setImg] = useState<{ image: string; thumb: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const pick = async (e: Event) => {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      setImg(await compressImage(file));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    if (!text.trim() && !img) return;
    setBusy(true);
    try {
      await app.publishSigned('post', { text: text.trim(), ...(img ?? {}) });
      setText('');
      setImg(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form class="card composer" onSubmit={submit}>
      <textarea
        value={text}
        maxLength={2000}
        rows={2}
        placeholder={t('whatsNew')}
        onInput={(e) => setText(e.currentTarget.value)}
      />
      {img && <img class="preview" src={img.thumb} alt="" />}
      {error && <p class="error">{error}</p>}
      <div class="row">
        <label class="file-btn">
          📷 {t('addPhoto')}
          <input type="file" accept="image/*" hidden onChange={pick} />
        </label>
        <button class="primary" disabled={busy || (!text.trim() && !img)}>
          {busy ? t('sending') : t('post')}
        </button>
      </div>
    </form>
  );
}

function PostImage({ body }: { body: PostBody }) {
  const [full, setFull] = useState(false);
  if (!body.image && !body.thumb) return null;
  const src = full || !body.thumb ? body.image : body.thumb;
  return (
    <button type="button" class="post-img" onClick={() => setFull(true)} title={t('showFull')}>
      <img src={src} alt="" loading="lazy" />
    </button>
  );
}

export function Feed({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const app = useApp();
  const sos = app.ofKind('sos').slice(0, 5);
  const posts = app.ofKind('post').slice(0, 200);
  return (
    <div class="feed">
      {sos.length > 0 && (
        <section class="card sos-list">
          <h2>🆘 {t('sosList')}</h2>
          {sos.map((e) => {
            const b = e.body as SosBody;
            return (
              <div key={e.id} class="sos-item">
                <strong>{app.nameOf(e.author!)}</strong> · <time>{ago(e.ts)}</time>
                <p>{b.text}</p>
                {b.loc && (
                  <code dir="ltr">
                    {b.loc.lat.toFixed(3)}, {b.loc.lon.toFixed(3)}
                  </code>
                )}
              </div>
            );
          })}
        </section>
      )}
      <Composer />
      {!posts.length && <p class="empty">{t('noPosts')}</p>}
      {posts.map((e) => {
        const b = e.body as PostBody;
        const mine = e.author === app.me?.id;
        return (
          <article key={e.id} class="card post">
            <header>
              <button class="link author" disabled={mine} onClick={() => onOpenChat(e.author!)}>
                {app.nameOf(e.author!)}
              </button>
              <time>{ago(e.ts)}</time>
            </header>
            {b.text && <p class="text">{b.text}</p>}
            <PostImage body={b} />
          </article>
        );
      })}
    </div>
  );
}
