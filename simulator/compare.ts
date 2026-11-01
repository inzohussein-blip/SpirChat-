// Runs the scenarios behind docs/simulation-ar.md and prints a comparison table.
//   node simulator/compare.ts > results.txt
import { type Options, simulate } from './sim.ts';

const base: Partial<Options> = { phones: 2000, hubs: 10, hours: 24 };
const scenarios: [string, Partial<Options>][] = [
  ['epidemic (v1)', { strategy: 'epidemic' }],
  ['spray own6 relay2 (v2 engine)', { strategy: 'spray', ownCopies: 6, relayCopies: 2, hubCopies: 0 }],
  ['spray own6 relay0 no hub seeding', { strategy: 'spray', ownCopies: 6, relayCopies: 0, hubCopies: 0 }],
  ['spray own6 relay0 hub1', { strategy: 'spray', ownCopies: 6, relayCopies: 0, hubCopies: 1 }],
  ['spray own6 relay0 hub2', { strategy: 'spray', ownCopies: 6, relayCopies: 0, hubCopies: 2 }],
  ['spray own6 relay0 hub4', { strategy: 'spray', ownCopies: 6, relayCopies: 0, hubCopies: 4 }],
  ['spray own6 relay1 hub2', { strategy: 'spray', ownCopies: 6, relayCopies: 1, hubCopies: 2 }],
  ['hub2, hubs not linked', { strategy: 'spray', hubCopies: 2, backbone: false }],
  ['hub2, no hubs at all', { strategy: 'spray', hubCopies: 2, hubs: 0 }],
  ['epidemic, no hubs at all', { strategy: 'epidemic', hubs: 0 }],
];

console.log('| scenario | delivered | p50 min | p90 min | copies/msg |');
console.log('|---|---|---|---|---|');
for (const [name, o] of scenarios) {
  const r = simulate({ ...base, ...o });
  console.log(
    `| ${name} | ${(r.ratio * 100).toFixed(1)}% | ${r.latencyP50Min ?? '-'} | ${r.latencyP90Min ?? '-'} | ${r.copiesPerMessage.toFixed(1)} |`,
  );
}
