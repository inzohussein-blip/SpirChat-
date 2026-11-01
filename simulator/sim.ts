// Delay-tolerant network simulator for SpirChat.
//
// Phones walk around a city (random waypoint), hubs sit at fixed places, and private messages
// are created between random people. Whenever two phones are within radio range, or a phone is
// near a hub, they exchange messages under a bandwidth budget, using the chosen strategy:
//   epidemic — give every message to everyone met (what v1 did)
//   spray    — spray-and-wait: limited copies per message (what the engine does now)
// Hubs pass everything to each other when linked (backbone), like PEERS between hubs.
//
//   node simulator/sim.ts --phones 2000 --hubs 10 --hours 24 --strategy spray
//
// Output: delivery ratio, latency percentiles, and copies per message (network cost).

export interface Options {
  phones: number;
  hubs: number;
  /** Side of the square city, metres. */
  size: number;
  hours: number;
  /** Simulation step, seconds. */
  step: number;
  messages: number;
  strategy: 'epidemic' | 'spray';
  /** Copies a message's author may hand out (spray). */
  ownCopies: number;
  /** Copies a relay may hand out (spray). */
  relayCopies: number;
  /**
   * Phones syncing with a hub download every message (as the real hub catch-up does) and may
   * hand each one to this many phones afterwards, so hubs seed their surroundings (spray).
   */
  hubCopies: number;
  /** Phone-to-phone range (Bluetooth/Wi-Fi Direct), metres. */
  phoneRange: number;
  /** Hub Wi-Fi range, metres. */
  hubRange: number;
  /** Messages exchanged per contact per step (bandwidth). */
  perContact: number;
  /** Whether hubs are linked to each other (domestic internet / Wi-Fi links / internet hub). */
  backbone: boolean;
  /** Share of phones that are out and moving (others stay home). */
  mobile: number;
  /** Walking speed range, m/s. */
  speed: [number, number];
  seed: number;
}

export const DEFAULTS: Options = {
  phones: 2000,
  hubs: 10,
  size: 10_000,
  hours: 24,
  step: 10,
  messages: 300,
  strategy: 'spray',
  ownCopies: 6,
  relayCopies: 0,
  hubCopies: 2,
  phoneRange: 50,
  hubRange: 300,
  perContact: 20,
  backbone: true,
  mobile: 0.6,
  speed: [0.8, 1.6],
  seed: 1,
};

export interface Result {
  options: Options;
  delivered: number;
  ratio: number;
  latencyP50Min: number | null;
  latencyP90Min: number | null;
  copiesPerMessage: number;
  contacts: number;
}

/** Small deterministic PRNG (mulberry32), so runs are reproducible. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Phone {
  x: number;
  y: number;
  tx: number;
  ty: number;
  v: number;
  mobile: boolean;
  /** message id -> copies left to hand out (Infinity for epidemic). */
  carry: Map<number, number>;
}

interface Message {
  from: number;
  to: number;
  created: number;
  deliveredAt: number | null;
}

export function simulate(partial: Partial<Options> = {}): Result {
  const o = { ...DEFAULTS, ...partial };
  const rand = rng(o.seed);
  const pick = (n: number) => Math.floor(rand() * n);

  const phones: Phone[] = Array.from({ length: o.phones }, () => {
    const x = rand() * o.size;
    const y = rand() * o.size;
    return { x, y, tx: x, ty: y, v: 0, mobile: rand() < o.mobile, carry: new Map() };
  });
  const hubs = Array.from({ length: o.hubs }, () => ({ x: rand() * o.size, y: rand() * o.size, has: new Set<number>() }));
  // Without a backbone each hub only holds what reached it directly.
  const backbone = new Set<number>();

  const steps = Math.floor((o.hours * 3600) / o.step);
  const msgs: Message[] = [];
  const createEvery = Math.max(1, Math.floor(steps / 2 / o.messages)); // created during the first half
  let copies = 0;
  let contacts = 0;

  const give = (p: Phone, id: number, budget: number) => {
    if (p.carry.has(id)) return false;
    p.carry.set(id, budget);
    copies++;
    return true;
  };

  const deliver = (pi: number, now: number) => {
    for (const id of phones[pi]!.carry.keys()) {
      const m = msgs[id]!;
      if (m.to === pi && m.deliveredAt === null) m.deliveredAt = now;
    }
  };

  // Spatial hash for neighbour search.
  const cell = Math.max(o.phoneRange, 1);
  const cols = Math.ceil(o.size / cell);

  for (let s = 0; s < steps; s++) {
    const now = s * o.step;

    if (s % createEvery === 0 && msgs.length < o.messages) {
      const from = pick(o.phones);
      let to = pick(o.phones);
      if (to === from) to = (to + 1) % o.phones;
      const id = msgs.push({ from, to, created: now, deliveredAt: null }) - 1;
      give(phones[from]!, id, o.strategy === 'epidemic' ? Infinity : o.ownCopies);
    }

    // Move.
    for (const p of phones) {
      if (!p.mobile) continue;
      const dx = p.tx - p.x;
      const dy = p.ty - p.y;
      const d = Math.hypot(dx, dy);
      if (d < 1) {
        p.tx = rand() * o.size;
        p.ty = rand() * o.size;
        p.v = o.speed[0] + rand() * (o.speed[1] - o.speed[0]);
        continue;
      }
      const stepLen = Math.min(d, p.v * o.step);
      p.x += (dx / d) * stepLen;
      p.y += (dy / d) * stepLen;
    }

    // Hubs: phones in range upload what they carry and download what is for them.
    for (let h = 0; h < hubs.length; h++) {
      const hub = hubs[h]!;
      const store = o.backbone ? backbone : hub.has;
      for (let i = 0; i < phones.length; i++) {
        const p = phones[i]!;
        if (Math.hypot(p.x - hub.x, p.y - hub.y) > o.hubRange) continue;
        for (const id of p.carry.keys()) store.add(id);
        for (const id of store) {
          const m = msgs[id]!;
          if (m.to === i && m.deliveredAt === null) {
            give(p, id, 0);
            m.deliveredAt = now;
          } else if (m.deliveredAt === null && !p.carry.has(id) && (o.hubCopies > 0 || o.strategy === 'epidemic')) {
            // Downloaded during catch-up; carried into the neighbourhood.
            p.carry.set(id, o.strategy === 'epidemic' ? Infinity : o.hubCopies);
          }
        }
      }
    }

    // Phone-to-phone contacts.
    const grid = new Map<number, number[]>();
    for (let i = 0; i < phones.length; i++) {
      const p = phones[i]!;
      const key = Math.floor(p.x / cell) * cols + Math.floor(p.y / cell);
      const list = grid.get(key);
      if (list) list.push(i);
      else grid.set(key, [i]);
    }
    for (let i = 0; i < phones.length; i++) {
      const a = phones[i]!;
      const cx = Math.floor(a.x / cell);
      const cy = Math.floor(a.y / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gy = cy - 1; gy <= cy + 1; gy++) {
          for (const j of grid.get(gx * cols + gy) ?? []) {
            if (j <= i) continue;
            const b = phones[j]!;
            if (Math.hypot(a.x - b.x, a.y - b.y) > o.phoneRange) continue;
            contacts++;
            exchange(a, b, j);
            exchange(b, a, i);
          }
        }
      }
    }

    function exchange(from: Phone, to: Phone, toIndex: number) {
      let sent = 0;
      for (const [id, budget] of from.carry) {
        if (sent >= o.perContact) break;
        if (to.carry.has(id)) continue;
        // A relay cannot tell which phone is the recipient (mailbox tags are opaque), so every
        // hand-over spends a copy, even to the recipient.
        if (budget <= 0) continue;
        if (budget !== Infinity) from.carry.set(id, budget - 1);
        give(to, id, o.strategy === 'epidemic' ? Infinity : o.relayCopies);
        sent++;
      }
      deliver(toIndex, now);
    }
  }

  const latencies = msgs
    .filter((m) => m.deliveredAt !== null)
    .map((m) => (m.deliveredAt! - m.created) / 60)
    .sort((a, b) => a - b);
  const pct = (q: number) => (latencies.length ? Math.round(latencies[Math.floor((latencies.length - 1) * q)]!) : null);
  return {
    options: o,
    delivered: latencies.length,
    ratio: msgs.length ? latencies.length / msgs.length : 0,
    latencyP50Min: pct(0.5),
    latencyP90Min: pct(0.9),
    copiesPerMessage: msgs.length ? copies / msgs.length : 0,
    contacts,
  };
}

function parseArgs(argv: string[]): Partial<Options> {
  const out: Record<string, unknown> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]!.replace(/^--/, '');
    const v = argv[i + 1]!;
    if (!(k in DEFAULTS)) throw new Error(`unknown option --${k}`);
    const def = (DEFAULTS as unknown as Record<string, unknown>)[k];
    out[k] = typeof def === 'number' ? Number(v) : typeof def === 'boolean' ? v === 'true' : v;
  }
  return out as Partial<Options>;
}

export function format(r: Result): string {
  const o = r.options;
  return [
    `${o.phones} phones, ${o.hubs} hubs${o.backbone ? ' (linked)' : ''}, ${o.size / 1000} km, ${o.hours} h, ${o.strategy}`,
    `  delivered ${r.delivered}/${o.messages} (${(r.ratio * 100).toFixed(1)}%)`,
    `  latency p50 ${r.latencyP50Min ?? '-'} min, p90 ${r.latencyP90Min ?? '-'} min`,
    `  copies per message ${r.copiesPerMessage.toFixed(1)}, contacts ${r.contacts}`,
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(format(simulate(parseArgs(process.argv.slice(2)))));
}
