import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from './sim.ts';

const small = { phones: 300, hubs: 4, size: 3000, hours: 6, messages: 60, seed: 7 };

test('runs are reproducible', () => {
  assert.deepEqual(simulate(small), simulate(small));
});

test('spray-and-wait bounds copies far below epidemic routing', () => {
  const epidemic = simulate({ ...small, strategy: 'epidemic' });
  const spray = simulate({ ...small, strategy: 'spray', ownCopies: 6, relayCopies: 0, hubCopies: 0, adaptiveHours: 0 });
  assert.ok(epidemic.ratio > 0.5, `epidemic delivers (${epidemic.ratio})`);
  assert.ok(spray.ratio > 0.2, `spray delivers (${spray.ratio})`);
  assert.ok(spray.copiesPerMessage * 5 < epidemic.copiesPerMessage, 'at least 5x fewer copies');
});

test('phones seeded at hubs carry messages to people who never visit a hub', () => {
  const without = simulate({ ...small, strategy: 'spray', relayCopies: 0, hubCopies: 0, adaptiveHours: 0 });
  const seeded = simulate({ ...small, strategy: 'spray', relayCopies: 0, hubCopies: 2, adaptiveHours: 0 });
  assert.ok(seeded.ratio > without.ratio);
});

test('relays with their own copy budget grow copies with every hop', () => {
  const bounded = simulate({ ...small, strategy: 'spray', relayCopies: 0, hubCopies: 0, adaptiveHours: 0 });
  const growing = simulate({ ...small, strategy: 'spray', relayCopies: 2, hubCopies: 0, adaptiveHours: 0 });
  assert.ok(growing.copiesPerMessage > bounded.copiesPerMessage * 3);
});

test('adaptive spraying still delivers when there are no hubs at all', () => {
  const fixed = simulate({ ...small, strategy: 'spray', hubs: 0, adaptiveHours: 0 });
  const adaptive = simulate({ ...small, strategy: 'spray', hubs: 0, adaptiveHours: 1 });
  assert.ok(fixed.ratio < 0.2, `fixed spraying starves without hubs (${fixed.ratio})`);
  assert.ok(adaptive.ratio > 0.8, `adaptive recovers (${adaptive.ratio})`);
});
