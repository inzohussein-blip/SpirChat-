import type { DirectMessage, Envelope } from '@spirchat/protocol';

// IndexedDB persistence. Everything a phone holds is also offered to every hub
// it connects to, which is how a phone carries messages between neighbourhoods.

export interface SentMessage extends DirectMessage {
  id: string;
}

const DB_NAME = 'spirchat';
let dbPromise: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('envelopes', { keyPath: 'id' });
      d.createObjectStore('sent', { keyPath: 'id' });
      d.createObjectStore('meta');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name: string, mode: IDBTransactionMode = 'readonly') {
  return (await db()).transaction(name, mode).objectStore(name);
}

export async function allEnvelopes(): Promise<Envelope[]> {
  return done((await store('envelopes')).getAll() as IDBRequest<Envelope[]>);
}

export async function putEnvelopes(envs: Envelope[]): Promise<void> {
  if (!envs.length) return;
  const tx = (await db()).transaction('envelopes', 'readwrite');
  const s = tx.objectStore('envelopes');
  for (const e of envs) s.put(e);
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function deleteEnvelopes(ids: string[]): Promise<void> {
  const s = await store('envelopes', 'readwrite');
  await Promise.all(ids.map((id) => done(s.delete(id))));
}

export async function allSent(): Promise<SentMessage[]> {
  return done((await store('sent')).getAll() as IDBRequest<SentMessage[]>);
}

export async function putSent(m: SentMessage): Promise<void> {
  await done((await store('sent', 'readwrite')).put(m));
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return done((await store('meta')).get(key) as IDBRequest<T | undefined>);
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await done((await store('meta', 'readwrite')).put(value, key));
}

export async function wipeAll(): Promise<void> {
  (await db()).close();
  dbPromise = null;
  await done(indexedDB.deleteDatabase(DB_NAME));
}
