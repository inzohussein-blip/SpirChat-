import { useEffect, useState } from 'preact/hooks';
import { areaOf, type PostBody, type SosBody } from '@spirchat/protocol';
import { ago, t } from '../lib/i18n.ts';
import { type Compressed, compressImage } from '../lib/image.ts';
import { fetchMedia, localMedia } from '../lib/media.ts';
import { app, type Scope, useApp } from '../lib/state.ts';

function Composer() {
  const app = useApp();
  const [text, setText] = useState('');
  const [img, setImg] = useState<Compressed | null>(null);
  const [scope, setScope] = useState<Scope>('gov');
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
      await app.publishPost(text.trim(), img, scope);
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
        {app.area && (
          <select class="scope" value={scope} onChange={(e) => setScope(e.currentTarget.value as Scope)} title={t('scope')}>
            <option value="hood">{t('scopeHood')}</option>
            <option value="gov">{t('scopeGov')}</option>
            <option value="all">{t('scopeAll')}</option>
          </select>
        )}
        <button class="primary" disabled={busy || (!text.trim() && !img)}>
          {busy ? t('sending') : t('post')}
        </button>
      </div>
    </form>
  );
}

/** Thumbnail first; the full image only when tapped (from this device, a hub, or nearby phones). */
function PostImage({ body }: { body: PostBody }) {
  const app = useApp();
  const [full, setFull] = useState<string | null>(null);
  const [wanted, setWanted] = useState(false);
  const [missing, setMissing] = useState(false);
  const media = body.media;

  useEffect(() => {
    if (!media) return;
    void localMedia(media).then((url) => url && setFull(url));
  }, [media?.id]);

  // In the app, a requested image may arrive later from a nearby phone or hub.
  useEffect(() => {
    if (media && wanted && !full) void localMedia(media).then((url) => url && setFull(url));
  }, [app.version]);

  if (!body.image && !body.thumb && !media) return null;
  if (body.image && !media) {
    return (
      <button type="button" class="post-img" onClick={() => setWanted(true)} title={t('showFull')}>
        <img src={wanted || !body.thumb ? body.image : body.thumb} alt="" loading="lazy" />
      </button>
    );
  }
  const load = async () => {
    setWanted(true);
    if (!media || full) return;
    const url = (await localMedia(media)) ?? (await fetchMedia(media, app.hubBases()));
    if (url) setFull(url);
    else setMissing(true);
  };
  return (
    <button type="button" class="post-img" onClick={load} title={t('showFull')}>
      <img src={full ?? body.thumb} alt="" loading="lazy" class={full ? '' : 'thumb'} />
      {!full && <span class="img-hint">{wanted ? (missing ? t('imageWaiting') : t('loading')) : t('showFull')}</span>}
    </button>
  );
}

function AuthorMenu({ id, onOpenChat }: { id: string; onOpenChat: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <span class="author-menu">
      <button class="link author" onClick={() => onOpenChat(id)}>
        {app.nameOf(id)}
      </button>
      <button class="link more" aria-label="⋯" onClick={() => setOpen(!open)}>
        ⋯
      </button>
      {open && (
        <span class="menu">
          <button
            onClick={() => {
              if (confirm(t('blockConfirm'))) void app.block(id, true);
              setOpen(false);
            }}
          >
            🚫 {t('block')}
          </button>
        </span>
      )}
    </span>
  );
}

export function Feed({ onOpenChat }: { onOpenChat: (id: string) => void }) {
  const app = useApp();
  const [nearOnly, setNearOnly] = useState(true);
  const sos = app.ofKind('sos').filter((e) => app.nearMe(e)).slice(0, 5);
  const posts = app
    .ofKind('post')
    .filter((e) => !nearOnly || app.nearMe(e))
    .slice(0, 200);
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
      {app.area && (
        <div class="chips">
          <button class={nearOnly ? 'chip on' : 'chip'} onClick={() => setNearOnly(true)}>
            📍 {t('nearMe')}
          </button>
          <button class={nearOnly ? 'chip' : 'chip on'} onClick={() => setNearOnly(false)}>
            🌍 {t('everything')}
          </button>
        </div>
      )}
      {!posts.length && <p class="empty">{t('noPosts')}</p>}
      {posts.map((e) => {
        const b = e.body as PostBody;
        const mine = e.author === app.me?.id;
        const area = areaOf(e);
        return (
          <article key={e.id} class="card post">
            <header>
              {mine ? <strong>{app.nameOf(e.author!)}</strong> : <AuthorMenu id={e.author!} onOpenChat={onOpenChat} />}
              <time>
                {area && <span class="area">📍 {area.split('/').at(-1)} · </span>}
                {ago(e.ts)}
              </time>
            </header>
            {b.text && <p class="text">{b.text}</p>}
            <PostImage body={b} />
          </article>
        );
      })}
    </div>
  );
}
