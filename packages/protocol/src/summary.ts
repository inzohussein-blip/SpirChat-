import { fromB64u } from './encoding.ts';

/**
 * Compact set summaries for sync. Instead of listing up to 5000 IDs (~230 KB) on every
 * meeting, each side sends one bucket per day: [day, count, xor of the first 8 bytes of
 * every ID]. Only days whose buckets differ exchange ID lists (`have`), usually none or one.
 */
export type Bucket = [day: number, count: number, xor: string];

const DAY = 86_400_000;
export const dayOf = (ts: number) => Math.floor(ts / DAY);

export function summarize(items: Iterable<{ id: string; ts: number }>): Bucket[] {
  const days = new Map<number, { n: number; x: Uint8Array }>();
  for (const { id, ts } of items) {
    const d = dayOf(ts);
    let b = days.get(d);
    if (!b) days.set(d, (b = { n: 0, x: new Uint8Array(8) }));
    b.n++;
    const bytes = fromB64u(id);
    for (let i = 0; i < 8; i++) b.x[i]! ^= bytes[i] ?? 0;
  }
  return [...days]
    .sort(([a], [b]) => a - b)
    .map(([d, b]) => [d, b.n, [...b.x].map((v) => v.toString(16).padStart(2, '0')).join('')]);
}

/** Days where `mine` has something `theirs` may lack (bucket differs or is missing there). */
export function differingDays(mine: Bucket[], theirs: Bucket[]): number[] {
  const other = new Map(theirs.map(([d, n, x]) => [d, `${n}:${x}`]));
  return mine.filter(([d, n, x]) => other.get(d) !== `${n}:${x}`).map(([d]) => d);
}

export function isBucketList(v: unknown): v is Bucket[] {
  return (
    Array.isArray(v) &&
    v.length <= 400 &&
    v.every(
      (b) =>
        Array.isArray(b) &&
        b.length === 3 &&
        Number.isSafeInteger(b[0]) &&
        Number.isSafeInteger(b[1]) &&
        typeof b[2] === 'string' &&
        /^[0-9a-f]{16}$/.test(b[2]),
    )
  );
}
