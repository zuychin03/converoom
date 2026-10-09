import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createHttpServer, request as proxyRequest } from 'node:http';
import { createServer as createTlsServer, Agent, request as tlsRequest } from 'node:https';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer } from '../apps/daemon/src/server.js';
import { createSharedServer } from '../apps/daemon/src/shared-server.js';
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
const origin = 'https://room.example.ts.net:43319';
const shared = await createSharedServer(runtime.core, { enabled: true, origin, roomTools: true, uiDir: join(process.cwd(), 'dist', 'ui'),
  clients: [{ client_id: 'participant-bridge', redirect_uris: ['http://127.0.0.1:50181/oauth/callback'], token_endpoint_auth_method: 'none' }] });
const cert = await readFile(new URL('./fixtures/shared-tls-cert.pem', import.meta.url));
const agent = new Agent({ ca: cert, lookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) });
const tlsFetch = async (input: string | URL | Request, options: RequestInit = {}): Promise<Response> => new Promise((resolve, reject) => {
  const url = input instanceof Request ? new URL(input.url) : new URL(input);
  const request = tlsRequest(url, { agent, method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)) }, (response) => {
    const chunks: Buffer[] = []; response.on('data', (chunk) => chunks.push(chunk));
    response.on('end', () => resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks), { status: response.statusCode, headers: response.headers as Record<string, string> })));
  });
  request.on('error', reject); request.setTimeout(10000, () => request.destroy(new Error('Fixture TLS timeout')));
  if (options.body) request.write(options.body instanceof URLSearchParams ? options.body.toString() : String(options.body)); request.end();
});
const proxy = createTlsServer({ cert, key: await readFile(new URL('./fixtures/shared-tls-key.pem', import.meta.url)) }, (request, response) => {
  const upstream = proxyRequest({ hostname: '127.0.0.1', port: new URL(shared!.url).port, path: request.url, method: request.method,
    headers: { ...request.headers, 'x-forwarded-host': request.headers.host, 'x-forwarded-proto': 'https' } }, (reply) => { response.writeHead(reply.statusCode!, reply.headers); reply.pipe(response); });
  upstream.on('error', () => response.destroy()); response.once('close', () => upstream.destroy()); request.pipe(upstream);
});
await new Promise<void>((resolve, reject) => { proxy.once('error', reject); proxy.listen(43319, '127.0.0.1', resolve); });
let nativeStarts = 0, participantCode = '';
const participant = await createRuntime(join(dir, 'participant'), { remoteFetch: tlsFetch,
  startSession: async (product) => { nativeStarts++; return { id: 'browser-native-fixture', product, capabilities: ['prompt', 'cancel'],
    prompt: async () => 'Public browser fixture answer', cancel: async () => {}, close: async () => true }; } });
const participantServer = await createServer(participant, { port: 43320, pairingCode: 'participant-fixture-pair', controlToken: 'participant-fixture-control',
  onPairingCode: (code) => { participantCode = code; }, uiDir: join(process.cwd(), 'dist', 'ui') });
const fixtureControl = createHttpServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (requestUrl.pathname === '/native-count') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ nativeStarts })); return; }
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
  if (request.method !== 'POST' || requestUrl.pathname !== '/pair') {
    response.writeHead(404).end();
    return;
  }
  const remote = requestUrl.searchParams.has('participant');
  const rotated = await fetch((remote ? participantServer : server).url + '/local/pair', {
    method: 'POST', headers: { authorization: 'Bearer ' + (remote ? 'participant-fixture-control' : 'browser-fixture-control') },
  });
  response.writeHead(rotated.status, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ code: remote ? participantCode : terminalCode }));
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
  await participantServer.close(); await participant.stop();
  proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); await shared?.close(); agent.destroy();
  await runtime.stop();
  await rm(dir, { recursive: true, force: true });
};
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
