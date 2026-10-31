import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, sep } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import { type ClientMessage, type HubMessage, MAX_HAVE_IDS, type SyncPage } from '@spirchat/protocol';
import { type Hub, RateLimiter } from './hub.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive',
};

/** Paths phones and laptops probe to detect a captive portal. */
const CAPTIVE_PROBES = new Set([
  '/generate_204',
  '/gen_204',
  '/hotspot-detect.html',
  '/library/test/success.html',
  '/connecttest.txt',
  '/ncsi.txt',
  '/success.txt',
  '/canonical.html',
  '/redirect',
]);

const MAX_BODY = 32 * 1024 * 1024;
const PAGE = 200;

function json(res: ServerResponse, status: number, body: unknown) {
  // The Android app's pages have their own origin; everything on this API is public anyway.
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Parses newline-delimited JSON or a JSON array of envelopes. */
function parseEnvelopes(text: string): unknown[] {
  const t = text.trim();
  if (t.startsWith('[')) return JSON.parse(t) as unknown[];
  return t
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as unknown);
}

export function createHubServer(hub: Hub): Server {
  const { config, store } = hub;
  const clientIp = (req: IncomingMessage) => {
    const fwd = config.trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim() : '';
    return fwd || req.socket.remoteAddress || '?';
  };
  const importLimiter = new RateLimiter(20, 60_000);

  function serveStatic(req: IncomingMessage, res: ServerResponse, path: string) {
    let file = normalize(join(config.webDir, decodeURIComponent(path)));
    if (!file.startsWith(config.webDir + sep) && file !== config.webDir) return json(res, 400, { error: 'bad path' });
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(config.webDir, 'index.html');
    if (!existsSync(file)) {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('SpirChat hub is running, but the web app is not built. Run: npm run build\n');
    }
    const immutable = path.startsWith('/assets/');
    res.writeHead(200, {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    if (req.method === 'HEAD') return res.end();
    createReadStream(file).pipe(res);
  }

  async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://hub');
    const path = url.pathname;

    if (config.captive) {
      const host = (req.headers.host ?? '').split(':')[0];
      const foreign = host && host !== 'spirchat.local' && !/^[\d.]+$/.test(host) && host !== 'localhost';
      if (CAPTIVE_PROBES.has(path) || foreign) {
        res.writeHead(302, { location: 'http://spirchat.local/' });
        return res.end();
      }
    }

    if (path === '/api/info' && req.method === 'GET') {
      return json(res, 200, { hubId: hub.id, name: config.name, seq: store.maxSeq(), ...store.stats() });
    }

    if (path === '/api/sync' && req.method === 'GET') {
      const since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
      const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') ?? PAGE) || PAGE));
      const items = store.since(since, limit + 1);
      const more = items.length > limit;
      if (more) items.pop();
      const page: SyncPage = { hubId: hub.id, items, last: items.at(-1)?.seq ?? since, more };
      return json(res, 200, page);
    }

    if (path === '/api/envelopes' && req.method === 'POST') {
      if (!importLimiter.allow(clientIp(req))) return json(res, 429, { error: 'slow down' });
      let envs: unknown[];
      try {
        envs = parseEnvelopes(await readBody(req));
      } catch (e) {
        return json(res, 400, { error: (e as Error).message });
      }
      let added = 0;
      let rejected = 0;
      for (const env of envs) {
        const r = hub.accept(env);
        if (!r.ok) rejected++;
        else if (r.seq !== null) added++;
      }
      return json(res, 200, { received: envs.length, added, rejected });
    }

    if (path === '/api/export' && req.method === 'GET') {
      // A "data mule" bundle: carry it to another hub on a phone or USB stick and POST it to /api/envelopes.
      res.writeHead(200, {
        'content-type': 'application/x-ndjson',
        'content-disposition': `attachment; filename="spirchat-${hub.id.slice(0, 8)}-${Date.now()}.ndjson"`,
      });
      let since = Math.max(0, Number(url.searchParams.get('since') ?? 0) || 0);
      for (;;) {
        const page = store.since(since, 500);
        if (!page.length) break;
        for (const { env } of page) res.write(`${JSON.stringify(env)}\n`);
        since = page.at(-1)!.seq;
      }
      return res.end();
    }

    if (path === '/spirchat.apk' && (req.method === 'GET' || req.method === 'HEAD')) {
      // Drop a built APK into the data directory and every phone on the hub can install it.
      const apk = join(config.dataDir, 'spirchat.apk');
      if (!existsSync(apk)) return json(res, 404, { error: 'no apk on this hub' });
      res.writeHead(200, {
        'content-type': MIME['.apk']!,
        'content-length': statSync(apk).size,
        'content-disposition': 'attachment; filename="SpirChat.apk"',
      });
      if (req.method === 'HEAD') return res.end();
      return createReadStream(apk).pipe(res);
    }

    if (path.startsWith('/api/')) return json(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' });
    return serveStatic(req, res, path);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      console.error('request failed', e);
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 512 * 1024 });
  const authorLimiter = new RateLimiter(30, 60_000);
  const freshLimiter = new RateLimiter(60, 60_000);
  const carryLimiter = new RateLimiter(5000, 60_000);
  let connCounter = 0;

  wss.on('connection', (ws: WebSocket) => {
    const conn = `c${++connCounter}`;
    const send = (m: HubMessage) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
    let unsubscribe: (() => void) | null = null;

    const drain = () =>
      new Promise<void>((resolve) => {
        const tick = () => (ws.bufferedAmount < 1024 * 1024 || ws.readyState !== ws.OPEN ? resolve() : setTimeout(tick, 50));
        tick();
      });

    async function catchUp(since: number) {
      const upTo = store.maxSeq();
      // Text and alerts first, so they arrive even if the link drops during image transfer.
      for (const prio of [
        [0, 2],
        [3, 99],
      ] as [number, number][]) {
        let cursor = since;
        while (ws.readyState === ws.OPEN) {
          const page = store.since(cursor, PAGE, prio).filter((p) => p.seq <= upTo);
          if (!page.length) break;
          for (const { seq, env } of page) send({ t: 'env', seq, env });
          cursor = page.at(-1)!.seq;
          await drain();
        }
      }
      send({ t: 'synced', seq: upTo });
    }

    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(String(data)) as ClientMessage;
      } catch {
        return ws.close(1003, 'bad json');
      }
      switch (msg.t) {
        case 'hello': {
          if (unsubscribe) return;
          send({ t: 'welcome', hubId: hub.id, name: config.name, seq: store.maxSeq(), alertKeys: config.alertKeys });
          unsubscribe = hub.subscribe((seq, env) => send({ t: 'env', seq, env }));
          const since = msg.hubId === hub.id && Number.isSafeInteger(msg.since) ? msg.since! : 0;
          catchUp(since).catch((e: unknown) => console.error('catch-up failed', e));
          return;
        }
        case 'have': {
          const ids = Array.isArray(msg.ids) ? msg.ids.filter((i) => typeof i === 'string').slice(0, MAX_HAVE_IDS) : [];
          send({ t: 'want', ids: store.missing(ids) });
          return;
        }
        case 'publish': {
          const env = msg.env;
          const id = typeof env?.id === 'string' ? env.id : '';
          // A phone reconnecting may upload thousands of carried envelopes written
          // by others; only freshly written ones get the tight per-author limits.
          const fresh = env && Date.now() - env.ts < 10 * 60_000;
          const allowed = fresh
            ? freshLimiter.allow(conn) && (!env.author || authorLimiter.allow(env.author))
            : carryLimiter.allow(conn);
          if (!allowed) {
            return send({ t: 'ack', id, ok: false, error: 'rate limited' });
          }
          const r = hub.accept(env);
          return send(r.ok ? { t: 'ack', id, ok: true } : { t: 'ack', id, ok: false, error: r.error });
        }
      }
    });

    ws.on('close', () => unsubscribe?.());
    ws.on('error', () => unsubscribe?.());
  });

  server.on('close', () => wss.close());
  return server;
}
