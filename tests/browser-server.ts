import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer } from '../apps/daemon/src/server.js';
const dir = await mkdtemp(join(tmpdir(), 'converoom-browser-'));
const runtime = await createRuntime(dir, { noScheduler: true });
const server = await createServer(runtime, {
  port: 43317,
  pairingCode: 'browser-fixture-pair',
  controlToken: 'browser-fixture-control',
  uiDir: join(process.cwd(), 'dist', 'ui'),
});
console.log('Browser fixture ready: ' + server.url);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await server.close();
  await runtime.stop();
  await rm(dir, { recursive: true, force: true });
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
