import { type Bucket, differingDays, type Envelope, type HubMessage } from '@spirchat/protocol';
import * as db from './db.ts';

export type HubState = 'offline' | 'connecting' | 'syncing' | 'online';

export interface HubView {
  url: string;
  internet: boolean;
  state: HubState;
  name?: string;
}

export interface HubHandlers {
  receive(env: Envelope): void;
  /** Summary of what this device carries. */
  summary(): Bucket[];
  /** IDs this device carries that were created on the given days. */
  idsOnDays(days: number[]): string[];
  /** Called once per connection after catching up (images to upload, etc.). */
  synced(base: string): void;
  get(id: string): Envelope | undefined;
  delivered(ids: string[]): void;
  alertKeys(keys: string[]): void;
  changed(): void;
}

/** Accepts "host[:port]", "http(s)://host" or "ws(s)://host/ws"; returns the WebSocket URL. */
export function wsUrl(addr: string, secureDefault: boolean): string {
  const a = addr.trim().replace(/\/+$/, '');
  if (/^wss?:\/\//.test(a)) return a.endsWith('/ws') ? a : `${a}/ws`;
  if (a.startsWith('https://')) return `wss://${a.slice(8)}/ws`;
  if (a.startsWith('http://')) return `ws://${a.slice(7)}/ws`;
  return `${secureDefault ? 'wss' : 'ws'}://${a}/ws`;
}

export const httpUrl = (ws: string) => ws.replace(/\/ws$/, '').replace(/^ws/, 'http');

/**
 * One browser connection to one hub (the hub serving the page, or an internet hub), with
 * catch-up from a per-hub cursor, have/want offering, and reconnection with backoff.
 */
export class HubConn {
  state: HubState = 'connecting';
  name?: string;
  hubId?: string;
  private ws: WebSocket | null = null;
  private retryMs = 1000;
  private offered: string[] = [];
  private closed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  readonly url: string;
  readonly internet: boolean;
  private h: HubHandlers;

  constructor(url: string, internet: boolean, handlers: HubHandlers) {
    this.url = url;
    this.internet = internet;
    this.h = handlers;
    this.connect();
  }

  view(): HubView {
    return { url: httpUrl(this.url), internet: this.internet, state: this.state, name: this.name };
  }

  private set(state: HubState) {
    this.state = state;
    this.h.changed();
  }

  private connect() {
    if (this.closed) return;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.set('offline');
      return;
    }
    this.ws = ws;
    ws.onopen = async () => {
      this.retryMs = 1000;
      const cursor = await db.getMeta<{ hubId: string; seq: number }>(`cursor:${this.url}`);
      ws.send(JSON.stringify({ t: 'hello', hubId: cursor?.hubId, since: cursor?.seq }));
    };
    ws.onmessage = (e) => this.onMessage(JSON.parse(String(e.data)) as HubMessage);
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.name = undefined;
      this.set('offline');
      if (this.closed) return;
      this.timer = setTimeout(() => this.connect(), this.retryMs);
      this.retryMs = Math.min(this.retryMs * 2, 30_000);
    };
  }

  private onMessage(m: HubMessage) {
    switch (m.t) {
      case 'welcome':
        this.hubId = m.hubId;
        this.name = m.name;
        this.h.alertKeys(m.alertKeys);
        this.set('syncing');
        return;
      case 'env':
        this.h.delivered([m.env.id]);
        this.h.receive(m.env);
        return;
      case 'synced':
        if (this.hubId) void db.setMeta(`cursor:${this.url}`, { hubId: this.hubId, seq: m.seq });
        this.set('online');
        this.send({ t: 'sum', buckets: this.h.summary() });
        this.h.synced(httpUrl(this.url));
        return;
      case 'sum': {
        // Only days whose summaries differ need their IDs offered.
        const mine = this.h.summary();
        const days = differingDays(mine, m.buckets);
        const differing = new Set(days);
        this.h.delivered(this.h.idsOnDays(mine.map(([d]) => d).filter((d) => !differing.has(d))));
        this.offered = this.h.idsOnDays(days);
        if (this.offered.length) this.send({ t: 'have', ids: this.offered });
        return;
      }
      case 'want': {
        const wanted = new Set(m.ids);
        this.h.delivered(this.offered.filter((id) => !wanted.has(id)));
        for (const id of m.ids) {
          const env = this.h.get(id);
          if (env) this.send({ t: 'publish', env });
        }
        return;
      }
      case 'ack':
        if (m.ok) this.h.delivered([m.id]);
        else console.warn('hub rejected', m.id, m.error);
        return;
    }
  }

  send(m: unknown) {
    if (this.ws?.readyState === WebSocket.OPEN && this.state === 'online') this.ws.send(JSON.stringify(m));
  }

  /** Retry immediately if not connected (e.g. after the network came back). */
  poke() {
    if (this.ws || this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.retryMs = 1000;
    this.connect();
  }

  close() {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
