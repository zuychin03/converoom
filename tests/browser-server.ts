import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createHttpServer } from 'node:http';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer } from '../apps/daemon/src/server.js';
import type { Room, Seat } from '../packages/shared/src/contracts.js';
const dir = await mkdtemp(join(tmpdir(), 'converoom-browser-'));
const runtime = await createRuntime(dir, { noScheduler: true });
let terminalCode = '';
const server = await createServer(runtime, {
  port: 43317,
  pairingCode: 'browser-fixture-pair',
  controlToken: 'browser-fixture-control',
  onPairingCode: (code) => { terminalCode = code; },
  uiDir: join(process.cwd(), 'dist', 'ui'),
});
const fixtureControl = createHttpServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (request.method === 'POST' && requestUrl.pathname === '/workspace') {
    const roomId = requestUrl.searchParams.get('roomId') ?? '';
    const room = runtime.core.store.get<Room>('room', roomId);
    const seat = runtime.core.store.list<Seat>('seat').find((s) => s.roomId === roomId && s.mode === 'managed');
    if (!room || !seat) { response.writeHead(400).end(); return; }
    const id = crypto.randomUUID(), path = join(dir, 'workspaces', id);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'README.md'), 'Preserved browser fixture work\n');
    runtime.core.store.put('task', roomId + ':browser-task', { id: 'browser-task', roomId,
      title: 'Recover retained work', acceptance: 'Inspect before release', status: 'claimed', generation: 1,
      scopePaths: ['README.md'], dependsOn: [], profileId: 'fixture-profile' });
    runtime.core.store.put('attempt', id, { id, roomId, taskId: 'browser-task', seatId: seat.id,
      status: 'quarantined', generation: 1, leaseExpiresAt: 0, wallDeadline: 0, resourceId: id, path });
    runtime.core.store.put('resource', id, { id, roomId, status: 'quarantined' });
    runtime.core.store.append(roomId, 'attempt.quarantined', 'fixture', { attemptId: id });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ attemptId: id }));
    return;
  }
  if (request.method !== 'POST' || request.url !== '/pair') {
    response.writeHead(404).end();
    return;
  }
  const rotated = await fetch(server.url + '/local/pair', {
    method: 'POST', headers: { authorization: 'Bearer browser-fixture-control' },
  });
  response.writeHead(rotated.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ code: terminalCode }));
});
await new Promise<void>((resolve, reject) => {
  fixtureControl.once('error', reject);
  fixtureControl.listen(43318, '127.0.0.1', resolve);
});
console.log('Browser fixture ready: ' + server.url);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve) => fixtureControl.close(() => resolve()));
  await server.close();
  await runtime.stop();
  await rm(dir, { recursive: true, force: true });
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
