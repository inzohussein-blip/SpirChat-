import type { SyncPage } from '@spirchat/protocol';
import type { Hub } from './hub.ts';

/**
 * Pulls new envelopes from one peer hub until caught up. Configure both hubs
 * as each other's peers for two-way sync over any IP link (domestic internet,
 * point-to-point Wi-Fi, VPN).
 */
export async function pullFromPeer(hub: Hub, url: string, fetchImpl: typeof fetch = fetch): Promise<number> {
  let { hubId, cursor } = hub.store.peerCursor(url);
  let added = 0;
  for (;;) {
    const res = await fetchImpl(`${url}/api/sync?since=${cursor}&limit=500`, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    const page = (await res.json()) as SyncPage;
    if (page.hubId !== hubId) {
      // Peer was reinstalled or the URL now points at another hub: start over.
      if (hubId !== null || cursor !== 0) {
        hubId = page.hubId;
        cursor = 0;
        continue;
      }
      hubId = page.hubId;
    }
    if (page.hubId === hub.id) throw new Error(`${url}: is this hub`);
    for (const { env } of page.items) {
      const r = hub.accept(env);
      if (r.ok && r.seq !== null) added++;
    }
    cursor = page.last;
    hub.store.setPeerCursor(url, hubId, cursor);
    if (!page.more) return added;
  }
}

export function startPeerSync(hub: Hub): () => void {
  const { peers, peerIntervalMs } = hub.config;
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    for (const url of peers) {
      try {
        const n = await pullFromPeer(hub, url);
        if (n) console.log(`peer ${url}: +${n} envelopes`);
      } catch (e) {
        console.warn(`peer ${url}: ${(e as Error).message}`);
      }
    }
    running = false;
  };
  if (!peers.length) return () => {};
  void run();
  const timer = setInterval(run, peerIntervalMs);
  return () => clearInterval(timer);
}
