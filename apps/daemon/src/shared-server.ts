import Fastify, { type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { OAuthError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { SharedOAuth } from '../../../packages/mcp/src/shared-auth.js';
import { handleSharedMcp } from '../../../packages/mcp/src/http.js';
import { activeMembership, membershipId, sharedSeat, sharedProjection, sharedCommand, sharedExport, SHARED_READS, SHARED_WRITES } from '../../../packages/core/src/membership.js';
import { validateToolArgs } from '../../../packages/mcp/src/tools.js';
import { streamWriter } from './shared-stream.js';
import { ConveroomError as E, requiredString as str, type Actor, type Core, type HumanMembership, type Seat, type ToolArgs } from '../../../packages/shared/src/contracts.js';

const secret = () => randomBytes(32).toString('base64url');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escape = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const browserCookie = (request: FastifyRequest) => String(request.headers.cookie ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith('__Host-converoom_shared='))?.slice(24);
const browserCsrf = (cookie: string) => hash('converoom-browser-csrf:' + cookie);
interface BrowserSession {
  id: string;
  actor: Actor;
  roomId: string;
  generation: number;
  csrfHash: string;
  expiresAt: number;
}
export interface SharedServerOptions {
  enabled: boolean;
  origin?: string;
  port?: number;
  clients?: OAuthClientInformationFull[];
  roomTools?: boolean;
  uiDir?: string;
}
export async function createSharedServer(core: Core, options: SharedServerOptions) {
  if (!options.enabled) return null;
  if (!options.origin || !options.clients) throw new E('shared_config', 'Complete private configuration required');
  const auth = new SharedOAuth(core, options.origin, options.clients), host = new URL(auth.origin).host;
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 65536, requestTimeout: 35000, connectionTimeout: 35000 });
  const rates = new Map<string, { at: number; count: number }>();
  const streams = new Set<() => void>(), streamCounts = new Map<string, number>();
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    const fields = new URLSearchParams(String(body)), result: ToolArgs = {};
    for (const [key, value] of fields) {
      if (key in result) { done(new E('invalid_argument', 'Duplicate form fields')); return; }
      result[key] = value;
    }
    done(null, result);
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('cache-control', 'no-store').header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer')
      .header('content-security-policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== auth.origin) ||
      (request.headers['x-forwarded-host'] && request.headers['x-forwarded-host'] !== host) ||
      (request.headers['x-forwarded-proto'] && request.headers['x-forwarded-proto'] !== 'https') ||
      request.headers.forwarded || request.headers['tailscale-funnel-request'])
      throw new E('origin', 'Configured private Host and Origin required', 403);
    const group = /^\/(?:shared\/v1\/(?:join|login)|authorize|token|revoke)/.test(request.url) ? 'auth' : request.url.startsWith('/mcp') ? 'mcp' : 'other';
    const previous = rates.get(group), rate = previous && previous.at > Date.now() - 60000 ? previous : { at: Date.now(), count: 0 };
    rates.set(group, rate);
    if (++rate.count > (group === 'auth' ? 60 : 240)) throw new E('rate_limited', 'Retry after one minute', 429);
    if (request.url.startsWith('/shared/v1/join')) {
      const previous = rates.get('join'), rate = previous && previous.at > Date.now() - 60000 ? previous : { at: Date.now(), count: 0 };
      rates.set('join', rate);
      if (++rate.count > 10) throw new E('rate_limited', 'Invitation attempt limit reached', 429);
    }
  });
  app.setErrorHandler((error: Error & { statusCode?: number; committed?: boolean; retrySafe?: boolean }, _request, reply) => {
    if (error instanceof OAuthError) {
      reply.code(error instanceof InvalidTokenError ? 401 : 400).send(error.toResponseObject()); return;
    }
    const status = error instanceof E ? error.status : error.statusCode === 413 ? 413 : error.statusCode === 400 ? 400 : 500;
    reply.code(status).send({ error: { code: error instanceof E ? error.code : status === 413 ? 'payload_too_large' : 'internal_error',
      message: error instanceof E ? error.message : 'Shared request failed', committed: error.committed ?? (status === 500 ? null : false),
      retrySafe: error.retrySafe ?? (status !== 500 && error.committed !== true) } });
  });
  const requireOrigin = (request: FastifyRequest) => {
    if (request.headers.origin !== auth.origin || (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin'))
      throw new E('csrf', 'Same-origin browser request required', 403);
  };
  const session = (request: FastifyRequest, mutation = false) => {
    const cookie = browserCookie(request);
    const record = cookie ? core.store.get<BrowserSession>('shared_browser_session', hash(cookie)) : undefined;
    if (!record || record.expiresAt <= Date.now()) throw new E('session', 'Join or sign in to the shared room', 401);
    const m = core.store.get<HumanMembership>('human_membership', membershipId(record.roomId, record.actor.ownerId));
    if (!m || m.principalId !== record.actor.principalId || m.generation !== record.generation || m.status === 'revoked' ||
      (m.status === 'pending' && Number(m.pendingExpiresAt) <= Date.now())) throw new E('session', 'Membership is no longer available', 401);
    if (mutation) {
      requireOrigin(request);
      const body = request.body as ToolArgs | undefined;
      const csrf = String(request.headers['x-csrf-token'] ?? body?.csrf ?? '');
      if (!equal(hash(csrf), record.csrfHash)) throw new E('csrf', 'Refresh the shared session', 403);
    }
    return record;
  };
  const makeSession = (actor: Actor, member: HumanMembership) => {
    for (const row of core.store.list<BrowserSession>('shared_browser_session'))
      if (row.expiresAt <= Date.now()) core.store.remove('shared_browser_session', row.id);
    if (core.store.count('shared_browser_session') >= 1000) throw new E('session_limit', 'Shared session capacity reached', 429);
    const cookie = secret(), csrf = browserCsrf(cookie), id = hash(cookie);
    core.store.put('shared_browser_session', id, { id, actor, roomId: member.roomId, generation: member.generation,
      csrfHash: hash(csrf), expiresAt: Date.now() + 86400000 } satisfies BrowserSession);
    return { cookie: '__Host-converoom_shared=' + cookie + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400', csrf };
  };
  app.get('/.well-known/oauth-authorization-server', async () => auth.metadata);
  app.get('/.well-known/oauth-protected-resource/mcp', async () => ({ resource: auth.resource, authorization_servers: [auth.origin],
    bearer_methods_supported: ['header'], resource_name: 'Converoom private room' }));
  app.post<{ Body: ToolArgs }>('/shared/v1/join', async (request, reply) => {
    requireOrigin(request);
    if (Object.keys(request.body).some((key) => !['roomId', 'code', 'recovery'].includes(key)) ||
      request.body.recovery !== undefined && typeof request.body.recovery !== 'boolean') throw new E('identity', 'Identity supplied by transport', 403);
    let actor: Actor = { kind: 'human', principalId: randomUUID(), ownerId: randomUUID() };
    const member = await core.dispatch(actor, request.body.recovery === true ? 'membership_recover' : 'membership_redeem', request.body) as HumanMembership;
    if (request.body.recovery === true) actor = { kind: 'human', principalId: member.principalId, ownerId: member.ownerId };
    try {
      const credentials = makeSession(actor, member); reply.header('set-cookie', credentials.cookie);
      return { member, csrf: credentials.csrf };
    } catch (error) {
      if (error instanceof Error) throw Object.assign(error, { committed: true, retrySafe: false });
      throw error;
    }
  });
  app.get('/shared/v1/session', async (request) => {
    const record = session(request), csrf = browserCsrf(browserCookie(request)!);
    const member = core.store.get<HumanMembership>('human_membership', membershipId(record.roomId, record.actor.ownerId))!;
    return { actor: record.actor, roomId: record.roomId, generation: record.generation, csrf, membershipStatus: member.status, displayName: member.displayName, role: member.role };
  });
  app.get<{ Querystring: ToolArgs }>('/authorize', async (request, reply) => {
    const x = request.query;
    if (x.response_type !== 'code' || x.code_challenge_method !== 'S256') throw new E('oauth_request', 'Code flow with S256 PKCE required');
    const intent = auth.begin(str(x, 'client_id', 256), { redirectUri: str(x, 'redirect_uri', 2048), state: str(x, 'state', 256),
      codeChallenge: str(x, 'code_challenge', 256), scopes: str(x, 'scope', 512).split(' '), resource: new URL(str(x, 'resource', 2048)) });
    reply.redirect(intent.url);
  });
  app.get<{ Querystring: ToolArgs }>('/shared/authorize', async (request, reply) => {
    const intent = auth.request(str(request.query, 'request', 256));
    let record: BrowserSession;
    try { record = session(request); } catch (e) {
      if (e instanceof E && e.status === 401) return reply.redirect('/shared?authorization_request=' + encodeURIComponent(intent.id));
      throw e;
    }
    if (!activeMembership(core.store, intent.roomId, record.actor.ownerId, record.actor.principalId))
      throw new E('membership', 'Wait for the inviter to confirm membership', 403);
    const csrf = browserCsrf(browserCookie(request)!);
    const room = core.requireRoom(record.actor, intent.roomId);
    reply.header('referrer-policy', 'same-origin').header('content-security-policy', "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' " + intent.redirectUri)
      .type('text/html').send('<!doctype html><html lang="en"><meta name="viewport" content="width=device-width"><title>Connect Converoom</title><main><h1>Connect your Converoom bridge</h1><p>' + escape(room.title) + '</p><p>Room access does not approve spending or native execution on your machine.</p><form method="post" action="/shared/authorize"><input type="hidden" name="requestId" value="' + escape(intent.id) + '"><input type="hidden" name="csrf" value="' + escape(csrf) + '"><button>Allow room connection</button></form></main></html>');
  });
  app.post<{ Body: ToolArgs }>('/shared/authorize', async (request, reply) => {
    const record = session(request, true); reply.redirect(auth.approve(str(request.body, 'requestId', 256), record.actor));
  });
  app.post<{ Body: ToolArgs }>('/shared/v1/authorize', async (request) => {
    const record = session(request, true); return { redirect: auth.approve(str(request.body, 'requestId', 256), record.actor) };
  });
  app.post<{ Body: ToolArgs }>('/token', async (request) => {
    const x = request.body, client = await auth.clientsStore.getClient(str(x, 'client_id', 256));
    if (!client) throw new E('oauth_client', 'Registered bridge required', 401);
    const resource = new URL(str(x, 'resource', 2048));
    if (x.grant_type === 'authorization_code') return auth.exchangeAuthorizationCode(client, str(x, 'code', 256),
      str(x, 'code_verifier', 128), str(x, 'redirect_uri', 2048), resource);
    if (x.grant_type === 'refresh_token') return auth.exchangeRefreshToken(client, str(x, 'refresh_token', 256),
      typeof x.scope === 'string' ? x.scope.split(' ') : undefined, resource);
    throw new E('grant_type', 'Code or refresh grant required');
  });
  app.post<{ Body: ToolArgs }>('/revoke', async (request) => {
    const client = await auth.clientsStore.getClient(str(request.body, 'client_id', 256));
    if (!client) throw new E('oauth_client', 'Registered bridge required', 401);
    await auth.revokeToken(client, { token: str(request.body, 'token', 256) }); return {};
  });
  const bearer = async (request: FastifyRequest) => {
    const header = String(request.headers.authorization ?? '');
    if (!header.startsWith('Bearer ')) throw new InvalidTokenError('Bearer credential required');
    return { token: header.slice(7), info: await auth.verifyAccessToken(header.slice(7)) };
  };
  if (options.roomTools) {
    app.get('/shared/v1/browser/state', async (request) => {
      const s = session(request); return { ...sharedProjection(core, s.actor, s.roomId), generation: s.generation, actor: s.actor,
        ownerConsents: core.store.list<{ ownerId: string }>('owner_consent', { roomId: s.roomId }).filter((row) => row.ownerId === s.actor.ownerId) };
    });
    app.post<{ Body: { name: string; args: ToolArgs } }>('/shared/v1/browser/commands', async (request) => {
      const s = session(request, true), body = request.body;
      if (!body || Object.keys(body).some((key) => !['name', 'args'].includes(key)) || !body.args || typeof body.args !== 'object' || Array.isArray(body.args) ||
        (!SHARED_READS.has(body.name) && !SHARED_WRITES.has(body.name)) || body.name === 'shared_artefact_publish')
        throw new E('shared_command', 'Supported scoped browser command required', 403);
      if (body.name !== 'owner_consent_update') {
        const args = { ...body.args }; delete args.expectedGeneration; delete args.expectedPolicyVersion; validateToolArgs(body.name, args);
      }
      return { result: await sharedCommand(core, s.actor, s.roomId, s.generation, body.name, body.args), committed: SHARED_WRITES.has(body.name), retrySafe: true };
    });
    app.post<{ Body: ToolArgs }>('/shared/v1/artefacts', { bodyLimit: 3145728, onRequest: async (request) => {
      const s = session(request, true); core.requireRoom(s.actor, s.roomId);
    } }, async (request) => {
      const s = session(request, true);
      return { result: await sharedCommand(core, s.actor, s.roomId, s.generation, 'shared_artefact_publish', request.body), committed: true, retrySafe: true };
    });
    app.get<{ Querystring: { cursor?: string } }>('/shared/v1/export', async (request) => {
      const s = session(request); return sharedExport(core, s.actor, s.roomId, s.generation, Number(request.query.cursor ?? 0));
    });
    app.get<{ Querystring: { cursor?: string } }>('/shared/v1/events', async (request, reply) => {
      const s = session(request), key = s.actor.principalId + ':' + s.roomId;
      let cursor = Number(request.headers['last-event-id'] ?? request.query.cursor ?? 0);
      await sharedCommand(core, s.actor, s.roomId, s.generation, 'room_read', { roomId: s.roomId, cursor, limit: 1 });
      if (streams.size >= 10 || (streamCounts.get(key) ?? 0) >= 2) throw new E('stream_capacity', 'Shared stream capacity reached', 429);
      streamCounts.set(key, (streamCounts.get(key) ?? 0) + 1);
      reply.hijack(); reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); reply.raw.flushHeaders();
      let busy = false, finished = false;
      const finish = () => {
        if (finished) return; finished = true; clearInterval(timer); clearInterval(heartbeat); streams.delete(finish);
        streamCounts.set(key, Math.max(0, (streamCounts.get(key) ?? 1) - 1)); reply.raw.end();
      };
      const emit = async () => {
        if (busy || finished) return; busy = true;
        try {
          session(request); if (writer.blocked() || reply.raw.destroyed) return;
          const page = await sharedCommand(core, s.actor, s.roomId, s.generation, 'room_read', { roomId: s.roomId, cursor, limit: 100 }) as { events: ToolArgs[]; cursor: number };
          for (const event of page.events) {
            session(request);
            const accepted = writer.write('id: ' + event.seq + '\nevent: room\ndata: ' + JSON.stringify(event) + '\n\n');
            cursor = Number(event.seq);
            if (!accepted) break;
          }
          if (!writer.blocked()) cursor = page.cursor;
        } catch { finish(); } finally { busy = false; }
      };
      const writer = streamWriter(reply.raw, () => void emit());
      const timer = setInterval(() => void emit(), 250), heartbeat = setInterval(() => { if (!writer.blocked() && !finished) writer.write(': keepalive\n\n'); }, 15000);
      streams.add(finish); request.raw.on('close', finish); reply.raw.on('error', finish); void emit();
    });
    app.get('/shared/v1/identity', async (request) => (await bearer(request)).info.extra);
    app.get('/shared/v1/state', async (request) => {
      const { info } = await bearer(request); return sharedProjection(core, info.extra!.actor as Actor, String(info.extra!.roomId));
    });
    app.post<{ Body: ToolArgs }>('/shared/v1/agents', async (request) => {
      const { token, info } = await bearer(request), actor = info.extra!.actor as Actor, x = request.body;
      if (actor.kind !== 'human' || Object.keys(x).some((key) => !['product', 'name', 'role', 'clientKey', 'expectedGeneration', 'expectedPolicyVersion'].includes(key)))
        throw new E('identity', 'Human-owned polling registration required', 403);
      const roomId = String(info.extra!.roomId), room = core.requireRoom(actor, roomId);
      if (x.expectedGeneration !== info.extra!.generation || x.expectedPolicyVersion !== room.policyVersion)
        throw new E('shared_version', 'Current membership and policy required', 409);
      const seat = await core.dispatch(actor, 'seat_add', { roomId, product: str(x, 'product', 256), name: str(x, 'name', 256),
        role: x.role ?? 'member', mode: 'polling', clientKey: str(x, 'clientKey', 256) }) as Seat;
      let tokens;
      try { tokens = await auth.issueAgent(token, seat); }
      catch (error) { throw Object.assign(error instanceof Error ? error : new E('registration', 'Agent provisioning failed', 500), { committed: true, retrySafe: false }); }
      return { seat: { ...sharedSeat(seat), principalId: seat.principalId }, accessToken: tokens.access_token, refreshToken: tokens.refresh_token,
        expiresIn: tokens.expires_in, committed: true, retrySafe: false };
    });
  }
  app.post('/mcp', async (request, reply) => {
    let identity: Awaited<ReturnType<typeof bearer>>;
    try {
      identity = await bearer(request);
    } catch {
      reply.header('www-authenticate', 'Bearer resource_metadata="' + auth.origin + '/.well-known/oauth-protected-resource/mcp"');
      throw new InvalidTokenError('Room authentication required');
    }
    await handleSharedMcp(request.raw, reply.raw, request.body, options.roomTools ? { core, actor: identity.info.extra!.actor as Actor,
      roomId: String(identity.info.extra!.roomId), generation: Number(identity.info.extra!.generation) } : undefined); reply.hijack();
  });
  if (options.roomTools && options.uiDir && existsSync(resolve(options.uiDir, 'index.html'))) {
    const uiDir = resolve(options.uiDir);
    await app.register(fastifyStatic, { root: resolve(uiDir, 'assets'), prefix: '/assets/', index: false, dotfiles: 'deny' });
    app.get('/shared', (_request, reply) => reply.sendFile('index.html', uiDir));
    app.get('/shared/', (_request, reply) => reply.sendFile('index.html', uiDir));
    app.get('/', (_request, reply) => reply.redirect('/shared'));
  }
  const url = await app.listen({ host: '127.0.0.1', port: options.port ?? 0 });
  return { app, url, auth, close: async () => { for (const finish of [...streams]) finish(); await app.close(); } };
}
