import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ConveroomError,
  type Actor,
  type Event,
  type Product,
  type Runtime,
} from '../../../packages/shared/src/contracts.js';
import { TOOL_DEFINITIONS, validateToolArgs } from '../../../packages/mcp/src/tools.js';
import { redactPublic } from '../../../packages/store/src/index.js';

export const VERSION = '0.1.0';
const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export function humanIdentity(runtime: Runtime): Actor {
  let actor = runtime.core.store.get<Actor>('identity', 'human');
  if (!actor) {
    const id = crypto.randomUUID();
    actor = { kind: 'human', principalId: id, ownerId: id };
    runtime.core.store.put('identity', 'human', actor);
  }
  return actor;
}
export function issueBridgeCredential(
  runtime: Runtime,
  product: Product,
): { token: string; principalId: string } {
  if (!['codex', 'claude', 'cursor', 'opencode'].includes(product))
    throw new ConveroomError('invalid_product', 'Choose a supported product');
  const token = secret();
  const principalId = crypto.randomUUID();
  runtime.core.store.put('bridge', hash(token), {
    kind: 'agent',
    principalId,
    ownerId: humanIdentity(runtime).ownerId,
    product,
    createdAt: Date.now(),
  });
  return { token, principalId };
}
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .filter(
          ([key]) =>
            !/(token|secret|password|credential|reasoning|authorization|cookie|csrf)/i.test(key),
        )
        .map(([key, child]) => [key, redact(child)]),
    );
  return redactPublic(value);
}
const entities = {
  rooms: 'room',
  seats: 'seat',
  profiles: 'profile',
  interactions: 'interaction',
  turns: 'turn',
  permissions: 'permission',
  tasks: 'task',
  attempts: 'attempt',
  repos: 'repo',
  manifests: 'manifest',
  verifications: 'verification',
  reviews: 'review',
  candidates: 'candidate',
  resources: 'resource',
};
export function snapshot(runtime: Runtime): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(entities))
    state[key] = redact(runtime.core.store.list(kind));
  state.events = redact(allEvents(runtime));
  return state;
}
function allEvents(runtime: Runtime): Event[] {
  return runtime.core.store
    .list<{ id: string }>('room')
    .flatMap((room) => {
      const r = runtime.core.store.get<{ seq: number }>('room', room.id)!;
      return runtime.core.store.events(room.id, Math.max(0, r.seq - 1000), 1000);
    })
    .sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    .slice(-1000);
}
export interface ServerOptions {
  port?: number;
  pairingCode?: string;
  pairingExpiresAt?: number;
  controlToken?: string;
  uiDir?: string;
  onStop?: () => Promise<void>;
}
export async function createServer(
  runtime: Runtime,
  options: ServerOptions = {},
): Promise<{ app: FastifyInstance; url: string; close(): Promise<void> }> {
  const app = Fastify({ logger: false, bodyLimit: 65536, requestTimeout: 35000 });
  const human = humanIdentity(runtime);
  let pairing = options.pairingCode ?? secret();
  let pairingExpiresAt = options.pairingExpiresAt ?? Date.now() + 300000;
  let pairingUsed = false;
  let url = '';
  const sessions = new Map<string, { csrf: string; expiresAt: number }>();
  const rates = new Map<string, { at: number; count: number }>();
  const streams = new Set<() => void>();
  const browserOrigin = (request: FastifyRequest, required: boolean) => {
    if (
      (required && !request.headers.origin) ||
      (request.headers.origin && request.headers.origin !== url)
    )
      throw new ConveroomError('invalid_origin', 'Browser origin rejected', 403);
    if (
      request.headers['sec-fetch-site'] &&
      !['same-origin', 'none'].includes(String(request.headers['sec-fetch-site']))
    )
      throw new ConveroomError('invalid_origin', 'Browser origin rejected', 403);
  };
  const humanSession = (request: FastifyRequest, mutation = false) => {
    browserOrigin(request, mutation);
    const cookie = String(request.headers.cookie ?? '')
      .split(';')
      .map((s) => s.trim())
      .find((s) => s.startsWith('converoom_session='))
      ?.slice(18);
    const session = cookie ? sessions.get(hash(cookie)) : undefined;
    if (!session || session.expiresAt <= Date.now())
      throw new ConveroomError(
        'unauthorised',
        'Pair this browser using the local start command',
        401,
      );
    if (mutation && !equal(String(request.headers['x-csrf-token'] ?? ''), session.csrf))
      throw new ConveroomError('invalid_csrf', 'Refresh your browser session', 403);
    return session;
  };
  const localAuth = (request: FastifyRequest) => {
    browserOrigin(request, false);
    if (
      !options.controlToken ||
      !equal(String(request.headers.authorization ?? ''), `Bearer ${options.controlToken}`)
    )
      throw new ConveroomError('unauthorised', 'Local control credential required', 401);
  };
  app.addHook('onRequest', async (request, reply) => {
    reply.header(
      'content-security-policy',
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    reply
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'no-referrer')
      .header('cache-control', 'no-store');
    if (request.headers.host !== new URL(url).host)
      throw new ConveroomError('invalid_host', 'Host rejected', 403);
    const rateKey = `${request.ip}:${request.url.split('?')[0]}`;
    const prior = rates.get(rateKey);
    const rate = prior && prior.at > Date.now() - 60000 ? prior : { at: Date.now(), count: 0 };
    rates.set(rateKey, rate);
    if (++rate.count > (request.url.startsWith('/api/pair') ? 10 : 240))
      throw new ConveroomError('rate_limited', 'Retry after one minute', 429);
    if (rates.size > 1000)
      for (const [key, value] of rates) if (value.at < Date.now() - 60000) rates.delete(key);
  });
  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const known = error instanceof ConveroomError;
    const status = known
      ? error.status
      : error.statusCode === 413
        ? 413
        : error.statusCode === 400
          ? 400
          : 500;
    reply
      .code(status)
      .send({
        error: {
          code: known
            ? error.code
            : status === 413
              ? 'payload_too_large'
              : status === 400
                ? 'invalid_argument'
                : 'internal_error',
          message: known
            ? error.message
            : status === 500
              ? 'The operation failed. Check local runtime status.'
              : 'Invalid request',
        },
      });
  });
  app.get('/health', async () => ({ name: 'converoom', version: VERSION, pid: process.pid }));
  app.post<{ Body: { code?: unknown } }>('/api/pair', async (request, reply) => {
    browserOrigin(request, true);
    if (
      pairingUsed ||
      Date.now() >= pairingExpiresAt ||
      typeof request.body?.code !== 'string' ||
      !equal(request.body.code, pairing)
    )
      throw new ConveroomError('invalid_pairing', 'Pairing code is invalid or expired', 401);
    pairingUsed = true;
    const cookie = secret();
    const csrf = secret();
    sessions.set(hash(cookie), { csrf, expiresAt: Date.now() + 86400000 });
    reply.header(
      'set-cookie',
      `converoom_session=${cookie}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`,
    );
    return { paired: true };
  });
  app.get('/api/session', async (request) => ({ csrf: humanSession(request).csrf, actor: human }));
  app.get('/api/state', async (request) => {
    humanSession(request);
    return snapshot(runtime);
  });
  const humanCommands = new Set([
    'seat_add',
    'seat_consent',
    'policy_update',
    'permission_grant',
    'permission_deny',
    'host_transfer_confirm',
    'repo_register',
    'repo_get',
    'repo_list',
    'profile_register',
    'resource_profile_register',
    'resource_profile_list',
    'candidate_review',
    'candidate_apply',
    'workspace_cleanup',
    'managed_stop',
    'adapter_status',
    'room_export',
    'backup_request',
  ]);
  const dispatch = async (request: FastifyRequest, actor: Actor) => {
    const body = request.body as { name?: unknown; args?: unknown };
    if (
      !body ||
      typeof body.name !== 'string' ||
      !body.args ||
      typeof body.args !== 'object' ||
      Array.isArray(body.args) ||
      Object.keys(body).some((k) => !['name', 'args'].includes(k))
    )
      throw new ConveroomError('invalid_argument', 'Expected a command name and arguments');
    const args = body.args as Record<string, unknown>;
    if (['principalId', 'ownerId', 'actor', 'kind'].some((k) => k in args))
      throw new ConveroomError('invalid_argument', 'Identity is supplied by the transport');
    const tool = TOOL_DEFINITIONS.find((t) => t.name === body.name);
    if (tool) validateToolArgs(body.name, args);
    else if (actor.kind !== 'human' || !humanCommands.has(body.name))
      throw new ConveroomError('unknown_command', 'Unsupported command');
    const result = await runtime.core.dispatch(actor, body.name, args);
    if (body.name === 'room_create' && result && typeof result === 'object') {
      const room = result as { id: string };
      return {
        result: redact({
          ...result,
          appUrl: url + '/?room=' + encodeURIComponent(room.id),
          roster: runtime.core.store
            .list<{ roomId: string }>('seat')
            .filter((s) => s.roomId === room.id),
        }),
      };
    }
    return { result: redact(result) };
  };
  app.post('/api/commands', async (request) => {
    humanSession(request, true);
    return dispatch(request, human);
  });
  app.post('/agent/commands', async (request) => {
    browserOrigin(request, false);
    const auth = String(request.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const principal = token ? runtime.core.store.get<Actor>('bridge', hash(token)) : undefined;
    if (
      !principal ||
      principal.kind !== 'agent' ||
      runtime.core.store.get('revoked', principal.principalId)
    )
      throw new ConveroomError('unauthorised', 'Agent bridge credential required', 401);
    return dispatch(request, {
      kind: 'agent',
      principalId: principal.principalId,
      ownerId: principal.ownerId,
    });
  });
  app.post('/local/commands', async (request) => {
    localAuth(request);
    return dispatch(request, human);
  });
  app.post<{ Body: { product: Product } }>('/local/credentials', async (request) => {
    localAuth(request);
    return issueBridgeCredential(runtime, request.body.product);
  });
  app.post('/local/pair', async (request) => {
    localAuth(request);
    pairing = secret().slice(0, 12);
    pairingExpiresAt = Date.now() + 300000;
    pairingUsed = false;
    return { code: pairing, expiresAt: pairingExpiresAt };
  });
  app.post('/local/stop', async (request) => {
    localAuth(request);
    setTimeout(() => void options.onStop?.(), 100);
    return { stopping: true };
  });
  app.post<{ Body: { principalId: string } }>('/local/revoke', async (request) => {
    localAuth(request);
    for (const credential of runtime.core.store.list<Actor & { id?: string }>('bridge'))
      if (credential.principalId === request.body.principalId) {
        // Hash keys are not exposed by Store.list; credentials are revoked through an indexed principal record.
        runtime.core.store.put('revoked', credential.principalId, true);
      }
    return { revoked: true };
  });
  app.get('/api/events', async (request, reply) => {
    humanSession(request);
    const cursor = String(request.headers['last-event-id'] ?? '');
    let current = allEvents(runtime);
    if (cursor && !current.some((e) => e.id === cursor))
      throw new ConveroomError(
        'cursor_expired',
        'Refresh the room snapshot before resuming events',
        409,
      );
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    let lastId = cursor;
    let busy = false;
    const emit = () => {
      if (busy || reply.raw.destroyed) return;
      busy = true;
      try {
        current = allEvents(runtime);
        const start = lastId ? current.findIndex((e) => e.id === lastId) + 1 : 0;
        for (const event of current.slice(start)) {
          if (
            !reply.raw.write(
              `id: ${event.id}\nevent: room\ndata: ${JSON.stringify(redact(event))}\n\n`,
            )
          )
            break;
          lastId = event.id;
        }
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(emit, 750);
    const heartbeat = setInterval(() => reply.raw.write(': keepalive\n\n'), 15000);
    const finish = () => {
      clearInterval(timer);
      clearInterval(heartbeat);
      streams.delete(finish);
      reply.raw.end();
    };
    streams.add(finish);
    request.raw.on('close', finish);
    emit();
  });
  const uiDir = options.uiDir ?? resolve(dirname(fileURLToPath(import.meta.url)), 'ui');
  if (existsSync(resolve(uiDir, 'index.html'))) {
    await app.register(fastifyStatic, {
      root: uiDir,
      prefix: '/',
      index: 'index.html',
      dotfiles: 'deny',
    });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith('/api/') ||
      request.url.startsWith('/agent/') ||
      request.url.startsWith('/local/') ||
      request.method !== 'GET'
        ? reply.code(404).send({ error: { code: 'not_found', message: 'Unknown route' } })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('onClose', async () => {
    for (const finish of streams) finish();
    sessions.clear();
  });
  url = await app.listen({ host: '127.0.0.1', port: options.port ?? 43123 });
  return {
    app,
    url,
    close: async () => {
      for (const finish of streams) finish();
      await app.close();
    },
  };
}
