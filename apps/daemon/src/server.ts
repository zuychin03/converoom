import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { isProduct } from '../../../packages/shared/src/products.js';
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
  type Seat,
  type Turn,
  type ToolArgs,
  type RemoteConnection,
} from '../../../packages/shared/src/contracts.js';
import { TOOL_DEFINITIONS, validateToolArgs } from '../../../packages/mcp/src/tools.js';
import { redactTransport } from '../../../packages/store/src/index.js';
import { MANAGED_TOOLS, type ManagedScope } from '../../../packages/mcp/src/managed.js';
import { SHARED_READS, SHARED_WRITES } from '../../../packages/core/src/membership.js';
import { artefactMetadata } from '../../../packages/core/src/shared-artefacts.js';
import type { SharedArtefact } from '../../../packages/shared/src/contracts.js';

export const VERSION = '0.2.0';
const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const readCommands = new Set([...SHARED_READS, 'runtime_capabilities', 'task_get', 'artefact_get', 'repo_get', 'repo_list',
  'resource_profile_list', 'adapter_status', 'room_export']);
const outcome = (name: string, args: ToolArgs) => ({ committed: !readCommands.has(name), retrySafe: readCommands.has(name) ||
  (typeof args.clientKey === 'string' && TOOL_DEFINITIONS.some((t) => t.name === name) &&
    !['task_claim', 'task_submit', 'verification_request', 'integration_prepare'].includes(name)) });
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
  remoteConnectionId?: string,
): { token: string; principalId: string; remoteConnectionId?: string } {
  if (!isProduct(product))
    throw new ConveroomError('invalid_product', 'Choose a supported product');
  const token = secret();
  const principalId = crypto.randomUUID();
  if (remoteConnectionId) {
    const c = runtime.core.store.get<RemoteConnection>('remote_connection', remoteConnectionId);
    if (!c || c.localOwnerId !== humanIdentity(runtime).ownerId || c.status !== 'connected' || c.mode !== 'polling' || c.product !== product)
      throw new ConveroomError('remote_registration', 'Own connected polling product required', 403);
  }
  runtime.core.store.put('bridge', hash(token), {
    kind: 'agent',
    principalId,
    ownerId: humanIdentity(runtime).ownerId,
    product,
    ...(remoteConnectionId ? { remoteConnectionId } : {}),
    createdAt: Date.now(),
  });
  return { token, principalId, ...(remoteConnectionId ? { remoteConnectionId } : {}) };
}
export function redact(value: unknown): unknown {
  return redactTransport(value);
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
  remoteConnections: 'remote_connection',
  remoteProposals: 'remote_proposal',
  members: 'human_membership',
  ownerConsents: 'owner_consent',
  sharedArtefacts: 'shared_artefact',
};
export function snapshot(runtime: Runtime): Record<string, unknown> {
  const state: Record<string, unknown> = {};
  for (const [key, kind] of Object.entries(entities))
    state[key] = redact(runtime.core.store.list(kind));
  state.events = redact(allEvents(runtime));
  state.sharedArtefacts = runtime.core.store.list<SharedArtefact>('shared_artefact').map(artefactMetadata);
  state.invitations = runtime.core.store.list<Record<string, unknown>>('invitation').map((row) => {
    const { codeHash: _hash, ...metadata } = row; return metadata;
  });
  return state;
}
function allEvents(runtime: Runtime): Event[] {
  return runtime.core.store.recentEvents(1000);
}
export interface ServerOptions {
  port?: number;
  pairingCode?: string;
  pairingExpiresAt?: number;
  controlToken?: string;
  onPairingCode?: (code: string, expiresAt: number) => void;
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
  app.setErrorHandler((error: Error & { statusCode?: number; committed?: boolean | null; retrySafe?: boolean }, _request, reply) => {
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
          committed: error.committed ?? (known && ['invalid_argument', 'unknown_command', 'unauthorised', 'invalid_csrf', 'human_session_required'].includes(error.code) ? false : null),
          retrySafe: error.retrySafe ?? (status === 413 || (known && ['invalid_argument', 'unknown_command', 'unauthorised', 'invalid_csrf', 'human_session_required'].includes(error.code))),
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
    'attempt_release',
    'managed_stop',
    'adapter_status',
    'room_export',
    'backup_request',
    'remote_connection_prepare', 'remote_connection_finish', 'remote_connection_disconnect', 'remote_connection_enable',
    'remote_refresh', 'remote_turn_accept', 'remote_turn_decline',
    'membership_invite', 'membership_confirm', 'membership_revoke', 'invitation_revoke', 'owner_consent_update', 'shared_artefact_publish',
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
    if (actor.kind === 'human' && body.name === 'remote_connection_prepare') {
      const prepared = result as ToolArgs;
      return { result: { ...redact(prepared) as ToolArgs, authorizationUrl: prepared.authorizationUrl }, committed: true, retrySafe: false };
    }
    if (body.name === 'room_create' && result && typeof result === 'object') {
      const room = result as { id: string };
      return {
        ...outcome(body.name, args),
        result: redact({
          ...result,
          appUrl: url + '/?room=' + encodeURIComponent(room.id),
          roster: runtime.core.store
            .list<{ roomId: string }>('seat')
            .filter((s) => s.roomId === room.id),
        }),
      };
    }
    return { result: redact(result), ...outcome(body.name, args) };
  };
  app.post('/api/commands', async (request) => {
    humanSession(request, true);
    return dispatch(request, human);
  });
  app.post('/api/artefacts', { bodyLimit: 3145728, onRequest: async (request) => { humanSession(request, true); } }, async (request) => {
    if ((request.body as { name?: string })?.name !== 'shared_artefact_publish') throw new ConveroomError('invalid_argument', 'Artefact publication required');
    return dispatch(request, human);
  });
  app.post('/agent/commands', async (request) => {
    browserOrigin(request, false);
    const auth = String(request.headers.authorization ?? '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const principal = token ? runtime.core.store.get<Actor & { scope?: ManagedScope; remoteConnectionId?: string }>('bridge', hash(token)) : undefined;
    if (
      !principal ||
      principal.kind !== 'agent' ||
      runtime.core.store.get('revoked', principal.principalId)
    )
      throw new ConveroomError('unauthorised', 'Agent bridge credential required', 401);
    if (principal.remoteConnectionId) {
      const body = request.body as { name?: string; args?: ToolArgs };
      const result = await runtime.core.dispatch({ kind: 'agent', ownerId: principal.ownerId, principalId: principal.principalId },
        'remote_polling_dispatch', { connectionId: principal.remoteConnectionId, name: body?.name, args: body?.args ?? {} });
      return { result: redact(result), committed: SHARED_WRITES.has(String(body.name)), retrySafe: SHARED_READS.has(String(body.name)) || typeof body.args?.clientKey === 'string' };
    }
    if (principal.scope) {
      const scope = principal.scope;
      const body = request.body as { name?: string; args?: ToolArgs };
      const turn = runtime.core.store.get<Turn>('turn', scope.turnId);
      const seat = runtime.core.store.get<Seat>('seat', scope.seatId);
      const attempt = scope.attemptId ? runtime.core.store.get<ToolArgs>('attempt', scope.attemptId) : undefined;
      if (!turn || !['dispatching', 'running'].includes(turn.status) ||
        turn.roomId !== scope.roomId || turn.seatId !== scope.seatId || turn.attemptId !== scope.attemptId ||
        !seat?.consent || seat.status === 'left' || seat.principalId !== principal.principalId ||
        (scope.attemptId && (!attempt || attempt.generation !== scope.generation ||
          !['ready', 'running'].includes(String(attempt.status)) || !(Number(attempt.leaseExpiresAt) > Date.now()) ||
          runtime.core.store.get<ToolArgs>('task', scope.roomId + ':' + attempt.taskId)?.generation !== scope.generation)))
        throw new ConveroomError('unauthorised', 'Managed turn credential expired or fenced', 401);
      if (!body || !MANAGED_TOOLS.has(String(body.name)) ||
        (body.name !== 'runtime_capabilities' && body.args?.roomId !== scope.roomId) ||
        (body.args?.attemptId && body.args.attemptId !== scope.attemptId) ||
        (body.args?.seatId && body.args.seatId !== scope.seatId))
        throw new ConveroomError('managed_scope', 'Managed tools are limited to this seat and room', 403);
      if (scope.remoteConnectionId) {
        const result = await runtime.core.dispatch({ kind: 'agent', principalId: principal.principalId, ownerId: principal.ownerId },
          'remote_agent_dispatch', { connectionId: scope.remoteConnectionId, localTurnId: scope.turnId, name: body.name, args: body.args ?? {} });
        return { result: redact(result), committed: SHARED_WRITES.has(String(body.name)), retrySafe: SHARED_READS.has(String(body.name)) || typeof body.args?.clientKey === 'string' };
      }
    }
    return dispatch(request, {
      kind: 'agent',
      principalId: principal.principalId,
      ownerId: principal.ownerId,
    });
  });
  app.post('/local/commands', async (request) => {
    localAuth(request);
    throw new ConveroomError('human_session_required', 'Pair a human session to issue commands', 403);
  });
  app.post<{ Body: { product: Product; remoteConnectionId?: string } }>('/local/credentials', async (request) => {
    localAuth(request);
    return issueBridgeCredential(runtime, request.body.product, request.body.remoteConnectionId);
  });
  app.post('/local/pair', async (request) => {
    localAuth(request);
    if (!options.onPairingCode)
      throw new ConveroomError('pairing_unavailable', 'Use the code in the original start terminal', 409);
    pairing = secret().slice(0, 12);
    pairingExpiresAt = Date.now() + 300000;
    pairingUsed = false;
    options.onPairingCode(pairing, pairingExpiresAt);
    return { issued: true, expiresAt: pairingExpiresAt };
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
    runtime.core.store.eventsAfter(cursor, 1);
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    reply.raw.flushHeaders();
    let lastId = cursor;
    let busy = false;
    let blocked = false;
    const emit = () => {
      if (busy || blocked || reply.raw.destroyed) return;
      busy = true;
      try {
        for (const event of runtime.core.store.eventsAfter(lastId)) {
          const accepted = reply.raw.write(
              `id: ${event.id}\nevent: room\ndata: ${JSON.stringify(redact(event))}\n\n`,
            );
          lastId = event.id;
          if (!accepted) {
            blocked = true;
            reply.raw.once('drain', () => { blocked = false; emit(); });
            break;
          }
        }
      } catch {
        reply.raw.end('event: resync\ndata: {"reason":"cursor_expired"}\n\n');
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
