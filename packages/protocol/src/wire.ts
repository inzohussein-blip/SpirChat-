import type { Envelope } from './envelope.ts';
import type { Bucket } from './summary.ts';

// Messages exchanged between a client (phone/browser) and a hub over WebSocket.

export type ClientMessage =
  /** `since` is the last hub sequence number this client has seen from `hubId`. */
  | { t: 'hello'; hubId?: string; since?: number }
  | { t: 'publish'; env: Envelope }
  /** IDs of envelopes the client carries; the hub answers with the ones it lacks. */
  | { t: 'have'; ids: string[] }
  /** Summary of what the client carries; the hub answers with its own summary. */
  | { t: 'sum'; buckets: Bucket[] };

export type HubMessage =
  | { t: 'welcome'; hubId: string; name: string; seq: number; alertKeys: string[] }
  | { t: 'env'; seq: number; env: Envelope }
  /** Initial catch-up is complete up to `seq`. */
  | { t: 'synced'; seq: number }
  | { t: 'want'; ids: string[] }
  | { t: 'ack'; id: string; ok: boolean; error?: string }
  /** The hub's summary; the client then sends `have` only for days that differ. */
  | { t: 'sum'; buckets: Bucket[] };

/** Hub-to-hub pull: GET /api/sync?since=N&limit=M */
export interface SyncPage {
  hubId: string;
  items: { seq: number; env: Envelope }[];
  /** Highest sequence number in `items`, or `since` if empty. */
  last: number;
  more: boolean;
}

export const MAX_HAVE_IDS = 5000;

/**
 * Symmetric phone-to-phone sync over a direct link (Bluetooth / Wi-Fi Direct).
 * Each side sends `sum` on connect, then `have` for differing days; the other answers `want`;
 * envelopes follow.
 * New urgent envelopes are also pushed unasked with `env`.
 */
export type PeerMessage =
  /** Sent first by both sides; each answers with `have` for the days that differ. */
  | { t: 'sum'; buckets: Bucket[] }
  | { t: 'have'; ids: string[] }
  | { t: 'want'; ids: string[] }
  | { t: 'env'; env: Envelope };
