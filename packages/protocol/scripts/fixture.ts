// Prints freshly created envelopes (valid right now) for integration tests in other languages.
// Usage: node packages/protocol/scripts/fixture.ts [count]
import { createDirect, createSigned, newIdentity } from '../src/index.ts';

const count = Number(process.argv[2] ?? 3);
const alice = newIdentity();
const bob = newIdentity();
const posts = Array.from({ length: count }, (_, i) => createSigned(alice, 'room', { room: 'test', text: `msg ${i}` }));
const sos = createSigned(alice, 'sos', { text: 'help' });
const dm = createDirect(alice, bob.id, { text: 'secret' });
console.log(JSON.stringify({ alice: alice.id, bob: bob.id, posts, sos, dm }));
