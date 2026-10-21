#!/usr/bin/env node
import { loadConfig } from './config.ts';
import { Hub } from './hub.ts';
import { startPeerSync } from './peers.ts';
import { createHubServer } from './server.ts';

const config = loadConfig();
const hub = new Hub(config);
const server = createHubServer(hub);

const prune = () => {
  const n = hub.store.prune(config.maxStoreBytes);
  if (n) console.log(`pruned ${n} envelopes`);
};
prune();
const pruneTimer = setInterval(prune, 10 * 60_000);
const stopPeers = startPeerSync(hub);

server.listen(config.port, config.host, () => {
  console.log(`SpirChat hub "${config.name}" (${hub.id}) on http://${config.host}:${config.port}`);
  console.log(`data: ${config.dataDir}  web: ${config.webDir}  peers: ${config.peers.join(', ') || 'none'}`);
});

const shutdown = () => {
  clearInterval(pruneTimer);
  stopPeers();
  server.close(() => {
    hub.store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
