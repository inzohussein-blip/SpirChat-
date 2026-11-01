import { b64u, MAX_MEDIA_BYTES, type MediaRef, sha256 } from '@spirchat/protocol';
import * as db from './db.ts';
import { native } from './native.ts';

// Full-size images travel separately from posts, addressed by their SHA-256. A post carries
// only a ~5 KB thumbnail; the full image is fetched when someone taps it, from this device,
// a hub, or (in the app) a nearby phone.

const urls = new Map<string, string>();

function toUrl(id: string, mime: string, data: Uint8Array): string {
  let url = urls.get(id);
  if (!url) {
    url = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
    urls.set(id, url);
  }
  return url;
}

/** Stores an image locally (and in the native engine) and returns its reference. */
export async function saveMedia(data: Uint8Array, mime: MediaRef['mime']): Promise<MediaRef> {
  if (data.length > MAX_MEDIA_BYTES) throw new Error('image too large');
  const id = b64u(sha256(data));
  await db.putBlob({ id, mime, data, added: Date.now() });
  if (native) {
    let bin = '';
    for (let i = 0; i < data.length; i += 0x8000) bin += String.fromCharCode(...data.subarray(i, i + 0x8000));
    native.putBlob(id, mime, btoa(bin));
  }
  return { id, size: data.length, mime };
}

/** Object URL of the image if it is on this device (or in the native engine), else null. */
export async function localMedia(ref: MediaRef): Promise<string | null> {
  if (urls.has(ref.id)) return urls.get(ref.id)!;
  const b = await db.getBlob(ref.id);
  if (b) return toUrl(ref.id, b.mime, b.data);
  if (native) {
    const got = native.getBlob(ref.id); // also asks nearby phones and hubs if missing
    if (got) {
      const [mime, b64] = [got.slice(0, got.indexOf(';')), got.slice(got.indexOf(';') + 1)];
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await db.putBlob({ id: ref.id, mime, data, added: Date.now() });
      return toUrl(ref.id, mime, data);
    }
  }
  return null;
}

/** Fetches the image from the first hub that has it, checking its hash. */
export async function fetchMedia(ref: MediaRef, hubBases: string[]): Promise<string | null> {
  for (const base of hubBases) {
    try {
      const res = await fetch(`${base}/api/blobs/${ref.id}`);
      if (!res.ok) continue;
      const data = new Uint8Array(await res.arrayBuffer());
      if (b64u(sha256(data)) !== ref.id) continue;
      await db.putBlob({ id: ref.id, mime: ref.mime, data, added: Date.now() });
      return toUrl(ref.id, ref.mime, data);
    } catch {
      // try the next hub
    }
  }
  return null;
}

/** Uploads the images this device holds that the hub lacks. */
export async function uploadMissing(base: string): Promise<void> {
  const ids = (await db.blobIds()).slice(-200);
  if (!ids.length) return;
  try {
    const res = await fetch(`${base}/api/blobs/missing`, { method: 'POST', body: JSON.stringify({ ids }) });
    const { missing } = (await res.json()) as { missing: string[] };
    for (const id of missing) {
      const b = await db.getBlob(id);
      if (b) await fetch(`${base}/api/blobs/${id}`, { method: 'PUT', body: b.data as BodyInit, headers: { 'content-type': b.mime } });
    }
  } catch {
    // retried at the next sync
  }
}
