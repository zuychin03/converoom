import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer as createHttpServer, request as proxyRequest } from 'node:http';
import { createServer as createTlsServer, Agent, request as tlsRequest } from 'node:https';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, humanIdentity } from '../apps/daemon/src/server.js';
import { createSharedServer } from '../apps/daemon/src/shared-server.js';
import { ENDED_ROOMS, type Room, type Seat, type Turn } from '../packages/shared/src/contracts.js';
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
  // The UI opens the latest unclosed room on load, so a room left by a failed flow would change the next flow's first screen.
  if (request.method === 'POST' && requestUrl.pathname === '/reset') {
    for (const room of runtime.core.store.list<Room>('room').filter((r) => !ENDED_ROOMS.includes(r.lifecycle)))
      await runtime.core.dispatch(humanIdentity(runtime), 'room_close', { roomId: room.id });
    await rm(join(dir, 'discovery.json'), { force: true });
    response.writeHead(204).end();
    return;
  }
  // A recorded result, so the flow never launches real vendor programs.
  if (request.method === 'POST' && requestUrl.pathname === '/discovery') {
    const harness = (product: string, status: string, registered: boolean, detail: string, signIn = 'not_checked') =>
      ({ product, status, installed: status !== 'not_installed', registered, signIn, detail, ...(status === 'not_installed' ? {} : { version: product + ' 1.0.0' }) });
    await writeFile(join(dir, 'discovery.json'), JSON.stringify({ at: Date.now(), harnesses: [
      { ...harness('codex', 'ready_managed', true, 'Codex can start managed sessions with its own sign-in.', 'signed_in'), models: ['gpt-fixture', 'gpt-mini'] },
      harness('cursor', 'needs_login', false, 'Cursor does not offer its native cursor_login sign-in, and managed sessions do not use API keys. Sign in through Cursor, then discover again.'),
      harness('claude', 'needs_mcp_registration', false, 'Claude Code is installed but not connected to Converoom. Connect it to join rooms.', 'not_applicable'),
      harness('qoder', 'not_installed', false, 'Qoder is not installed on this machine.', 'not_applicable'),
    ] }));
    response.writeHead(204).end();
    return;
  }
  if (request.method === 'POST' && requestUrl.pathname === '/uncertain') {
    const roomId = requestUrl.searchParams.get('roomId') ?? '';
    const turn = runtime.core.store.list<Turn>('turn', { roomId }).sort((a, b) => a.createdAt - b.createdAt).at(-1);
    if (!turn) { response.writeHead(400).end(); return; }
    runtime.core.store.put('turn', turn.id, { ...turn, status: 'uncertain', dispatchBoundaryAt: Date.now() - 60000, startedAt: Date.now() - 55000,
      sessionId: 'browser-native-fixture', failure: 'turn_timeout', error: 'Turn exceeded its wall time',
      repair: 'The agent may have acted before this stopped. Inspect the room and workspace before requesting it again; nothing is rerun automatically.' });
    runtime.core.store.append(roomId, 'turn.uncertain', 'runtime', { turnId: turn.id, failure: 'turn_timeout' });
    response.writeHead(204).end();
    return;
  }
  // Enough newer events elsewhere that no window of recent events across rooms reaches the flow's own room.
  if (request.method === 'POST' && requestUrl.pathname === '/busy') {
    const owner = humanIdentity(runtime);
    const room = await runtime.core.dispatch(owner, 'room_create', { title: 'Busy fixture room', objective: 'Newer events elsewhere' }) as Room;
    runtime.core.store.transaction(() => { for (let i = 0; i < 1100; i++) runtime.core.store.append(room.id, 'fixture', 'fixture', { i }); });
    await runtime.core.dispatch(owner, 'room_close', { roomId: room.id });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ roomId: room.id }));
    return;
  }
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
    const human = runtime.core.store.get<{ principalId: string }>('identity', 'human')!;
    runtime.core.store.put('command', human.principalId + ':task_submit:browser-' + id, { hash: 'browser-fixture', status: 'working',
      startedAt: Date.now() - 90000, args: { roomId, attemptId: id } });
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
