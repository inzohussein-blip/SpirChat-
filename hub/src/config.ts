import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface Config {
  port: number;
  host: string;
  name: string;
  dataDir: string;
  webDir: string;
  /** Other hubs to pull from, e.g. http://10.20.0.1 */
  peers: string[];
  peerIntervalMs: number;
  /** Public keys allowed to publish `alert` envelopes. */
  alertKeys: string[];
  maxStoreBytes: number;
  /** Answer OS connectivity checks so phones open the app as a captive portal. */
  captive: boolean;
  /** Behind a reverse proxy (internet hubs): take the client address from X-Forwarded-For. */
  trustProxy: boolean;
  /** Area this hub serves, e.g. "baghdad/karrada"; '' serves every area (internet hubs). */
  area: string;
  /** Authors whose envelopes this hub refuses (also read from DATA_DIR/deny.txt). */
  denyKeys: string[];
  /** Max envelopes per author per kind per day; unlisted kinds are unlimited. */
  quotas: Record<string, number>;
}

const list = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const here = dirname(fileURLToPath(import.meta.url));
  const dataDir = resolve(env.DATA_DIR ?? join(here, '..', 'data'));
  mkdirSync(dataDir, { recursive: true });
  return {
    port: Number(env.PORT ?? 80),
    host: env.HOST ?? '0.0.0.0',
    name: env.HUB_NAME ?? 'SpirChat',
    dataDir,
    webDir: resolve(env.WEB_DIR ?? join(here, '..', '..', 'web', 'dist')),
    peers: list(env.PEERS).map((u) => u.replace(/\/+$/, '')),
    peerIntervalMs: Number(env.PEER_INTERVAL_SEC ?? 30) * 1000,
    alertKeys: list(env.ALERT_KEYS),
    maxStoreBytes: Number(env.MAX_STORE_MB ?? 2048) * 1024 * 1024,
    captive: env.CAPTIVE === '1',
    trustProxy: env.TRUST_PROXY === '1',
    area: (env.HUB_AREA ?? '').trim().toLowerCase(),
    denyKeys: list(env.DENY_KEYS),
    quotas: {
      post: Number(env.QUOTA_POST ?? 30),
      room: Number(env.QUOTA_ROOM ?? 300),
      profile: Number(env.QUOTA_PROFILE ?? 10),
      sos: Number(env.QUOTA_SOS ?? 5),
    },
  };
}
