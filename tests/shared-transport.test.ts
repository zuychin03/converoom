import { beforeEach, afterEach, it, expect } from 'vitest';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { connectRoom } from '../packages/remote/src/client.js';
import { createServer as tlsServer, request as tlsRequest, Agent } from 'node:https';
import { request as proxyRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { exchangeAuthorization, refreshAuthorization, startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import { createSharedServer } from '../apps/daemon/src/shared-server.js';
import { createCore } from '../packages/core/src/index.js';
import { createStore } from '../packages/store/src/index.js';
import type { Actor, Core, Room, HumanMembership } from '../packages/shared/src/contracts.js';
const a: Actor = { kind: 'human', principalId: 'human-a', ownerId: 'owner-a' };
const b: Actor = { kind: 'human', principalId: 'human-b', ownerId: 'owner-b' };
const client = { client_id: 'participant-bridge', redirect_uris: ['http://127.0.0.1:50181/oauth/callback'], token_endpoint_auth_method: 'none' };
let core: Core, room: Room, member: HumanMembership, server: Awaited<ReturnType<typeof createSharedServer>>;
let proxy: ReturnType<typeof tlsServer>, agent: Agent, origin: string;
const call = (name: string, args: Record<string, unknown>, actor = a) => core.dispatch(actor, name, args);
async function tlsFetch(input: string | URL | Request, options: RequestInit = {}): Promise<Response> {
  const url = input instanceof Request ? new URL(input.url) : new URL(input);
  const body = options.body instanceof URLSearchParams ? options.body.toString() : options.body as string | undefined;
  return new Promise((resolve, reject) => {
    const request = tlsRequest(url, { agent, method: options.method ?? 'GET', headers: Object.fromEntries(new Headers(options.headers)) }, (response) => {
      const chunks: Buffer[] = []; response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(new Response(response.statusCode === 204 ? null : Buffer.concat(chunks),
        { status: response.statusCode, headers: response.headers as Record<string, string> })));
    });
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(new Error('TLS fixture timeout')));
    if (body) request.write(body); request.end();
  });
}
async function token() {
  const verifier = 'v'.repeat(64), resource = new URL(origin + '/mcp');
  const request = server!.auth.begin(client.client_id, { redirectUri: client.redirect_uris[0], state: 's'.repeat(32),
    codeChallenge: createHash('sha256').update(verifier).digest('base64url'), scopes: ['room:' + room.id], resource });
  const code = new URL(server!.auth.approve(request.id, b)).searchParams.get('code')!;
  return (await server!.auth.exchangeAuthorizationCode(client, code, verifier, client.redirect_uris[0], resource)).access_token;
}
beforeEach(async () => {
  core = createCore(createStore(':memory:'));
  room = await call('room_create', { title: 'Shared TLS', objective: 'Scoped connection' }) as Room;
  const invitation = await call('membership_invite', { roomId: room.id, displayName: 'B', role: 'participant', clientKey: 'invite' }) as { code: string };
  member = await call('membership_redeem', { roomId: room.id, code: invitation.code }, b) as HumanMembership;
  await call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  const cert = await readFile(new URL('./fixtures/shared-tls-cert.pem', import.meta.url));
  proxy = tlsServer({ cert, key: await readFile(new URL('./fixtures/shared-tls-key.pem', import.meta.url)) }, (request, response) => {
    const target = new URL(server!.url);
    const upstream = proxyRequest({ hostname: '127.0.0.1', port: target.port, path: request.url, method: request.method,
      headers: { ...request.headers, 'x-forwarded-host': request.headers.host, 'x-forwarded-proto': 'https' } }, (reply) => {
      response.writeHead(reply.statusCode!, reply.headers); reply.pipe(response);
    });
    upstream.on('error', () => response.destroy()); request.pipe(upstream);
    response.once('close', () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  origin = 'https://room.example.ts.net:' + (proxy.address() as AddressInfo).port;
  agent = new Agent({ ca: cert, lookup: (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]) });
  server = await createSharedServer(core, { enabled: true, origin, clients: [client], port: 0 });
});
afterEach(async () => {
  agent?.destroy(); if (proxy) { proxy.closeAllConnections(); await new Promise<void>((resolve) => proxy.close(() => resolve())); }
  await server?.close(); core?.store.close();
});
it('stays disabled without complete explicit private configuration', async () => {
  expect(await createSharedServer(core, { enabled: false })).toBeNull();
  await expect(createSharedServer(core, { enabled: true })).rejects.toThrow();
  expect(new URL(server!.url).hostname).toBe('127.0.0.1');
});
it('keeps one browser session CSRF valid while a second tab opens OAuth approval', async () => {
  const invite = await call('membership_invite', { roomId: room.id, displayName: 'Tabs', role: 'participant', clientKey: 'tabs' }) as { code: string };
  const joined = await tlsFetch(origin + '/shared/v1/join', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ roomId: room.id, code: invite.code }) });
  const cookie = joined.headers.get('set-cookie')!.split(';')[0];
  const value = await joined.json() as { member: HumanMembership; csrf: string };
  await call('membership_confirm', { roomId: room.id, memberId: value.member.id, expectedGeneration: value.member.generation });
  const before = await (await tlsFetch(origin + '/shared/v1/session', { headers: { cookie } })).json();
  const after = await (await tlsFetch(origin + '/shared/v1/session', { headers: { cookie } })).json();
  expect(after.csrf).toBe(before.csrf); expect(after.csrf).toBe(value.csrf);
});
it('serves only the shared browser entry and assets without a local API fallback', async () => {
  await server!.close();
  server = await createSharedServer(core, { enabled: true, origin, clients: [client], port: 0, roomTools: true, uiDir: join(process.cwd(), 'dist', 'ui') });
  const page = await tlsFetch(origin + '/shared'); expect(page.status).toBe(200); expect(await page.text()).toContain('<div id="root">');
  for (const path of ['/api/state', '/local/pair', '/agent/commands', '/shared/private', '/package.json'])
    expect((await tlsFetch(origin + path)).status).toBe(404);
});
it('recovers an expired browser session with the same identity and fences its old generation', async () => {
  const invite = await call('membership_invite', { roomId: room.id, displayName: 'Returning', role: 'participant', clientKey: 'returning' }) as { code: string };
  const joined = await tlsFetch(origin + '/shared/v1/join', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ roomId: room.id, code: invite.code }) });
  const cookie = joined.headers.get('set-cookie')!.split(';')[0], value = await joined.json() as { member: HumanMembership };
  await call('membership_confirm', { roomId: room.id, memberId: value.member.id, expectedGeneration: value.member.generation });
  const old = core.store.list<{ id: string; expiresAt: number }>('shared_browser_session')[0];
  core.store.put('shared_browser_session', old.id, { ...old, expiresAt: 1 });
  expect((await tlsFetch(origin + '/shared/v1/session', { headers: { cookie } })).status).toBe(401);
  const recovery = await call('membership_invite', { roomId: room.id, displayName: 'Returning', role: 'participant', recoverMemberId: value.member.id,
    expectedGeneration: value.member.generation, clientKey: 'recover-returning' }) as { code: string };
  const response = await tlsFetch(origin + '/shared/v1/join', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: room.id, code: recovery.code, recovery: true }) });
  expect(response.status).toBe(200);
  const fresh = response.headers.get('set-cookie')!.split(';')[0], recovered = await response.json() as { member: HumanMembership };
  expect(recovered.member).toMatchObject({ ownerId: value.member.ownerId, principalId: value.member.principalId, status: 'pending' });
  await call('membership_confirm', { roomId: room.id, memberId: recovered.member.id, expectedGeneration: recovered.member.generation });
  const current = await (await tlsFetch(origin + '/shared/v1/session', { headers: { cookie: fresh } })).json();
  expect(current.actor.ownerId).toBe(value.member.ownerId); expect(current.generation).toBe(value.member.generation + 1);
  expect((await tlsFetch(origin + '/shared/v1/session', { headers: { cookie } })).status).toBe(401);
});
it('advertises audience-bound protected resources and no dynamic registration', async () => {
  const metadata = await (await tlsFetch(origin + '/.well-known/oauth-protected-resource/mcp')).json();
  expect(metadata).toMatchObject({ resource: origin + '/mcp', authorization_servers: [origin] });
  const oauth = await (await tlsFetch(origin + '/.well-known/oauth-authorization-server')).json();
  expect(oauth).toMatchObject({ issuer: origin, code_challenge_methods_supported: ['S256'] });
  expect(oauth.registration_endpoint).toBeUndefined();
  expect((await tlsFetch(origin + '/register', { method: 'POST', body: '{}' })).status).toBe(404);
});
it('requires authentication regardless of protocol session IDs and forged identity headers', async () => {
  const response = await tlsFetch(origin + '/mcp', { method: 'POST', headers: { 'content-type': 'application/json',
    'mcp-session-id': 'stolen-session', 'tailscale-user-login': 'owner-a' }, body: '{}' });
  expect(response.status).toBe(401); expect(response.headers.get('www-authenticate')).toContain('resource_metadata=');
});
it('negotiates the pinned SDK over verified TLS and rejects unsupported protocol revisions', async () => {
  const credential = await token();
  const sdk = new Client({ name: 'Converoom fixture', version: '1' });
  try {
    await sdk.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), {
      fetch: tlsFetch, requestInit: { headers: { authorization: 'Bearer ' + credential } } }));
    const tools = await sdk.listTools(); expect(tools.tools.map((t) => t.name)).toEqual(['runtime_capabilities']);
    const result = await sdk.callTool({ name: 'runtime_capabilities', arguments: {} });
    expect(result.structuredContent).toMatchObject({ protocol: '2025-11-25', sharedWrites: false });
  } finally { await sdk.close(); }
  const rejected = await tlsFetch(origin + '/mcp', { method: 'POST', headers: {
    authorization: 'Bearer ' + credential, 'content-type': 'application/json', 'mcp-protocol-version': '2026-07-28' }, body: '{}' });
  expect(rejected.status).toBe(400);
  const sessionId = await tlsFetch(origin + '/mcp', { method: 'POST', headers: {
    authorization: 'Bearer ' + credential, 'content-type': 'application/json', 'mcp-session-id': 'another-session' }, body: '{}' });
  expect(sessionId.status).toBe(400);
});
it('checks exact Host and Origin without a forwarding-header bypass', async () => {
  const host = new URL(origin).host;
  for (const headers of [ { host: 'evil.test', 'x-forwarded-host': host }, { host, origin: 'https://evil.test' },
    { host, 'x-forwarded-host': 'evil.test' }, { host, 'x-forwarded-proto': 'http' }, { host, forwarded: 'host=evil.test;proto=https' },
    { host, 'tailscale-funnel-request': '?1' } ]) {
    expect((await server!.app.inject({ url: '/.well-known/oauth-authorization-server', headers })).statusCode).toBe(403);
  }
});
it('never routes shared requests to local control or complete owner snapshots', async () => {
  for (const path of ['/local/pair', '/local/commands', '/api/state', '/agent/commands', '/health'])
    expect((await tlsFetch(origin + path, { method: path.includes('commands') ? 'POST' : 'GET' })).status).toBe(404);
});
it('creates only a new pending remote identity and protects browser approval with CSRF', async () => {
  const invitation = await call('membership_invite', { roomId: room.id, displayName: 'C', role: 'participant', clientKey: 'invite-c' }) as { code: string };
  const response = await tlsFetch(origin + '/shared/v1/join', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: room.id, code: invitation.code }) });
  expect(response.status).toBe(200);
  const cookie = response.headers.get('set-cookie')!; expect(cookie).toContain('Secure'); expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict');
  const value = await response.json(); expect(value.member.status).toBe('pending'); expect(value.member.ownerId).not.toBe(a.ownerId);
  const session = await tlsFetch(origin + '/shared/v1/session', { headers: { cookie } });
  expect((await session.json()).actor.ownerId).toBe(value.member.ownerId);
  const request = server!.auth.begin(client.client_id, { redirectUri: client.redirect_uris[0], state: 's'.repeat(32),
    codeChallenge: createHash('sha256').update('v'.repeat(64)).digest('base64url'), scopes: ['room:' + room.id], resource: new URL(origin + '/mcp') });
  expect((await tlsFetch(origin + '/shared/v1/authorize', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify({ requestId: request.id }) })).status).toBe(403);
});
it('rejects removed credentials on every request and limits invitation attempts', async () => {
  const credential = await token();
  await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  const response = await tlsFetch(origin + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' }, body: '{}' });
  expect(response.status).toBe(401);
  const statuses: number[] = [];
  for (let i = 0; i < 11; i++) statuses.push((await tlsFetch(origin + '/shared/v1/join', { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ roomId: room.id, code: 'wrong' }) })).status);
  expect(statuses.at(-1)).toBe(429);
});
it('completes human confirmation, browser consent and SDK token exchange over verified TLS', async () => {
  const invitation = await call('membership_invite', { roomId: room.id, displayName: 'C', role: 'participant', clientKey: 'invite-c' }) as { code: string };
  const joined = await tlsFetch(origin + '/shared/v1/join', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: room.id, code: invitation.code }) });
  const value = await joined.json(), cookie = joined.headers.get('set-cookie')!;
  await call('membership_confirm', { roomId: room.id, memberId: value.member.id, expectedGeneration: value.member.generation });
  const started = await startAuthorization(new URL(origin), { clientInformation: client, metadata: server!.auth.metadata,
    redirectUrl: client.redirect_uris[0], scope: 'room:' + room.id, resource: origin + '/mcp', state: 's'.repeat(32) });
  const authorization = await tlsFetch(started.authorizationUrl);
  expect(authorization.status).toBe(302);
  const consent = await tlsFetch(authorization.headers.get('location')!, { headers: { cookie } });
  expect(consent.status).toBe(200); const html = await consent.text();
  const requestId = /name="requestId" value="([^"]+)"/.exec(html)![1], csrf = /name="csrf" value="([^"]+)"/.exec(html)![1];
  const approved = await tlsFetch(origin + '/shared/authorize', { method: 'POST', headers: { origin, cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ requestId, csrf }) });
  expect(approved.status).toBe(302); const callback = new URL(approved.headers.get('location')!);
  expect(callback.searchParams.get('iss')).toBe(origin); expect(callback.searchParams.get('state')).toBe('s'.repeat(32));
  const result = await exchangeAuthorization(new URL(origin), { metadata: server!.auth.metadata, clientInformation: client,
    authorizationCode: callback.searchParams.get('code')!, codeVerifier: started.codeVerifier, redirectUri: client.redirect_uris[0], resource: origin + '/mcp', fetchFn: tlsFetch });
  expect((await server!.auth.verifyAccessToken(result.access_token)).extra).toMatchObject({ actor: { ownerId: value.member.ownerId } });
  const refreshed = await refreshAuthorization(new URL(origin), { metadata: server!.auth.metadata, clientInformation: client,
    refreshToken: result.refresh_token!, resource: origin + '/mcp', fetchFn: tlsFetch });
  expect(refreshed.refresh_token).not.toBe(result.refresh_token);
});
it('reports committed membership honestly if browser credential issuance fails afterwards', async () => {
  for (let i = 0; i < 1000; i++) core.store.put('shared_browser_session', String(i), { id: String(i), expiresAt: Date.now() + 86400000 });
  const invitation = await call('membership_invite', { roomId: room.id, displayName: 'C', role: 'participant', clientKey: 'invite-c' }) as { code: string };
  const response = await tlsFetch(origin + '/shared/v1/join', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: room.id, code: invitation.code }) });
  expect(response.status).toBe(429);
  expect((await response.json()).error).toMatchObject({ committed: true, retrySafe: false });
  expect(core.store.list<HumanMembership>('human_membership').filter((m) => m.displayName === 'C')).toEqual([expect.objectContaining({ status: 'pending' })]);
});
it('bounds shared input without executing oversized JSON', async () => {
  const response = await tlsFetch(origin + '/shared/v1/join', { method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ roomId: room.id, code: 'x'.repeat(70000) }) });
  expect(response.status).toBe(413);
  expect(core.store.list<HumanMembership>('human_membership')).toHaveLength(2);
});
it('registers an owner-bound polling credential and routes only scoped shared tools', async () => {
  await server!.close(); server = await createSharedServer(core, { enabled: true, origin, clients: [client], port: 0, roomTools: true });
  const credential = await token();
  const registration = await tlsFetch(origin + '/shared/v1/agents', { method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
    body: JSON.stringify({ product: 'claude', name: 'B polling agent', clientKey: 'register', expectedGeneration: member.generation, expectedPolicyVersion: 1 }) });
  expect(registration.status).toBe(200); const value = await registration.json();
  expect(value.seat).toMatchObject({ ownerId: b.ownerId, mode: 'polling' });
  const sdk = new Client({ name: 'Participant fixture', version: '1' });
  try {
    await sdk.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { fetch: tlsFetch, requestInit: { headers: { authorization: 'Bearer ' + value.accessToken } } }));
    const tools = await sdk.listTools(); expect(tools.tools.some((t) => t.name === 'permission_grant')).toBe(false);
    const posted = await sdk.callTool({ name: 'room_post', arguments: { roomId: room.id, text: 'Scoped remote response',
      clientKey: 'post', expectedGeneration: member.generation, expectedPolicyVersion: 1 } });
    expect(posted.isError).not.toBe(true); expect(JSON.stringify(core.store.events(room.id))).toContain('Scoped remote response');
  } finally { await sdk.close(); }
});
it('completes durable participant OAuth and agent registration over verified TLS', async () => {
  await server!.close(); server = await createSharedServer(core, { enabled: true, origin, clients: [client], port: 0, roomTools: true });
  const dir = await mkdtemp(join(tmpdir(), 'converoom-oauth-participant-'));
  let loseRefresh = false, renewals = 0;
  const participant = await createRuntime(dir, { noScheduler: true, remoteFetch: async (input, options) => {
    const result = await tlsFetch(input, options);
    if (options?.body instanceof URLSearchParams && options.body.get('grant_type') === 'refresh_token') {
      renewals++; if (loseRefresh) throw new Error('Fixture acknowledgement lost after token rotation');
    }
    return result;
  },
    remoteTransport: (c, credentials) => connectRoom(c, credentials, tlsFetch) });
  const local: Actor = { kind: 'human', ownerId: 'participant-local', principalId: 'participant-human' };
  participant.core.store.put('identity', 'human', local);
  try {
    const prepared = await participant.core.dispatch(local, 'remote_connection_prepare', { origin, remoteRoomId: room.id, product: 'claude' }) as { connectionId: string; authorizationUrl: string };
    const q = new URL(prepared.authorizationUrl).searchParams;
    const request = server!.auth.begin(client.client_id, { redirectUri: client.redirect_uris[0], state: q.get('state')!,
      codeChallenge: q.get('code_challenge')!, scopes: ['room:' + room.id], resource: new URL(origin + '/mcp') });
    const callback = server!.auth.approve(request.id, b);
    const result = await fetch(callback);
    expect(result.status).toBe(200);
    const connection = participant.core.store.get<Record<string, unknown>>('remote_connection', prepared.connectionId)!;
    expect(connection).toMatchObject({ status: 'connected', remoteOwnerId: b.ownerId, localOwnerId: local.ownerId, product: 'claude', mode: 'polling' });
    expect(JSON.stringify(connection)).not.toContain('accessToken');
    await expect(participant.core.dispatch(local, 'remote_connection_finish', { connectionId: prepared.connectionId, callback })).rejects.toThrow();
    await participant.core.dispatch(local, 'remote_refresh', { connectionId: prepared.connectionId });
    expect(participant.core.store.get<Record<string, unknown>>('remote_connection', prepared.connectionId)?.status).toBe('connected');
    const credentialPath = join(dir, 'remote', prepared.connectionId + '.json');
    const credentials = JSON.parse(await readFile(credentialPath, 'utf8'));
    await writeFile(credentialPath, JSON.stringify({ ...credentials, accessExpiresAt: 0 }));
    for (const row of core.store.list<{ id: string; expiresAt: number }>('shared_oauth_access'))
      core.store.put('shared_oauth_access', row.id, { ...row, expiresAt: 0 });
    await participant.core.dispatch(local, 'remote_refresh', { connectionId: prepared.connectionId });
    expect(participant.core.store.get<Record<string, unknown>>('remote_connection', prepared.connectionId)?.status).toBe('connected');
    const renewed = JSON.parse(await readFile(credentialPath, 'utf8'));
    expect(renewed.refreshToken).not.toBe(credentials.refreshToken);
    await expect(server!.auth.verifyAccessToken(credentials.accessToken)).rejects.toThrow();
    loseRefresh = true;
    await writeFile(credentialPath, JSON.stringify({ ...renewed, accessExpiresAt: 0 }));
    await participant.core.dispatch(local, 'remote_refresh', { connectionId: prepared.connectionId });
    expect(participant.core.store.get<Record<string, unknown>>('remote_connection', prepared.connectionId)?.status).toBe('uncertain');
    await participant.core.dispatch(local, 'remote_refresh', { connectionId: prepared.connectionId });
    expect(renewals).toBe(2);
  } finally { await participant.stop(); await rm(dir, { recursive: true, force: true }); }
});
it('serves scoped MCP resources and read-only review prompts without arbitrary identifiers', async () => {
  await server!.close(); server = await createSharedServer(core, { enabled: true, origin, clients: [client], port: 0, roomTools: true });
  const content = '# Reviewed public text', artefact = await call('shared_artefact_publish', { roomId: room.id, name: 'review.md', mimeType: 'text/markdown',
    content, digest: createHash('sha256').update(content).digest('hex'), clientKey: 'share' }, b) as { id: string };
  const sdk = new Client({ name: 'Resource fixture', version: '1' });
  try {
    await sdk.connect(new StreamableHTTPClientTransport(new URL(origin + '/mcp'), { fetch: tlsFetch, requestInit: { headers: { authorization: 'Bearer ' + await token() } } }));
    expect((await sdk.listResources()).resources.some((r) => r.uri.endsWith('/state'))).toBe(true);
    const uri = 'converoom://rooms/' + room.id + '/artefacts/' + artefact.id;
    expect(JSON.stringify(await sdk.readResource({ uri }))).toContain(content);
    for (const value of ['file:///C:/private', 'https://evil.test', 'converoom://rooms/other/state', uri + '/../private', uri + '?path=private'])
      await expect(sdk.readResource({ uri: value })).rejects.toThrow();
    expect((await sdk.listPrompts()).prompts.map((p) => p.name)).toEqual(['review_shared_artefact']);
    expect(JSON.stringify(await sdk.getPrompt({ name: 'review_shared_artefact', arguments: { roomId: room.id, artefactId: artefact.id } }))).toContain(content);
    await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
    await expect(sdk.readResource({ uri })).rejects.toThrow();
  } finally { await sdk.close(); }
});
it('keeps browser state, Markdown export and live events scoped through removal', async () => {
  await server!.close(); server = await createSharedServer(core, { enabled: true, origin, clients: [client], port: 0, roomTools: true });
  const invite = await call('membership_invite', { roomId: room.id, displayName: 'C', role: 'participant', clientKey: 'browser-c' }) as { code: string };
  const joined = await tlsFetch(origin + '/shared/v1/join', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ roomId: room.id, code: invite.code }) });
  const cookie = joined.headers.get('set-cookie')!, value = await joined.json();
  await call('membership_confirm', { roomId: room.id, memberId: value.member.id, expectedGeneration: value.member.generation });
  core.store.append(room.id, 'permission.requested', 'runtime', { path: 'C:\\private', token: 'private-fixture' });
  await call('room_post', { roomId: room.id, text: 'Public stream message' });
  const state = await tlsFetch(origin + '/shared/v1/browser/state', { headers: { cookie } });
  expect(state.status).toBe(200); expect(JSON.stringify(await state.json())).not.toContain('C:\\private');
  const exported = await tlsFetch(origin + '/shared/v1/export?cursor=0', { headers: { cookie } });
  expect(exported.status).toBe(200); expect((await exported.json()).markdown).toContain('Public stream message');
  const content = 'x'.repeat(1048576);
  const upload = { roomId: room.id, name: 'review.txt', mimeType: 'text/plain', content,
    digest: createHash('sha256').update(content).digest('hex'), clientKey: 'big-review', expectedGeneration: value.member.generation, expectedPolicyVersion: 1 };
  const uploadBody = JSON.stringify(upload);
  expect((await server!.app.inject({ method: 'POST', url: '/shared/v1/artefacts', headers: { host: new URL(origin).host, origin, 'content-type': 'application/json' }, payload: uploadBody })).statusCode).toBe(401);
  expect((await server!.app.inject({ method: 'POST', url: '/shared/v1/artefacts', headers: { host: new URL(origin).host, origin, cookie, 'x-csrf-token': 'wrong', 'content-type': 'application/json' }, payload: uploadBody })).statusCode).toBe(403);
  const uploaded = await tlsFetch(origin + '/shared/v1/artefacts', { method: 'POST', headers: { origin, cookie, 'x-csrf-token': value.csrf, 'content-type': 'application/json' }, body: uploadBody });
  expect(uploaded.status).toBe(200); expect((await uploaded.json()).result).toMatchObject({ bytes: 1048576 });
  const opened = await Promise.all([0, 1].map(() => new Promise<ReturnType<typeof tlsRequest>>((resolve, reject) => {
    const request = tlsRequest(origin + '/shared/v1/events', { agent, headers: { cookie } }, (response) => { expect(response.statusCode).toBe(200); response.resume(); resolve(request); });
    request.on('error', reject); request.end();
  })));
  expect((await tlsFetch(origin + '/shared/v1/events', { headers: { cookie } })).status).toBe(429);
  for (const request of opened) request.destroy();
  await expect.poll(async () => (await server!.app.inject({ url: '/shared/v1/browser/state', headers: { host: new URL(origin).host, cookie } })).statusCode).toBe(200);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const buffer = await new Promise<string>((resolve, reject) => {
    let text = '', removed = false;
    const request = tlsRequest(origin + '/shared/v1/events?cursor=0', { agent, headers: { cookie } }, (response) => {
      expect(response.statusCode).toBe(200);
      response.on('data', (chunk) => {
        text += chunk;
        if (!removed && text.includes('Public stream message')) {
          removed = true; void call('membership_revoke', { roomId: room.id, memberId: value.member.id, expectedGeneration: value.member.generation });
        }
      });
      response.on('end', () => resolve(text)); response.on('error', reject);
    });
    request.on('error', reject); request.setTimeout(5000, () => request.destroy(new Error('Scoped stream did not end'))); request.end();
  });
  expect(buffer).toContain('Public stream message'); expect(buffer).not.toContain('private-fixture');
  expect((await tlsFetch(origin + '/shared/v1/browser/state', { headers: { cookie } })).status).not.toBe(200);
});
it('reports committed registration honestly when credential provisioning fails afterwards', async () => {
  await server!.close(); server = await createSharedServer(core, { enabled: true, origin, clients: [client], port: 0, roomTools: true });
  const credential = await token();
  for (let i = 0; i < 1000; i++) core.store.put('shared_oauth_access', 'capacity-' + i, { id: 'capacity-' + i, expiresAt: Date.now() + 60000 });
  const response = await tlsFetch(origin + '/shared/v1/agents', { method: 'POST', headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json' },
    body: JSON.stringify({ product: 'claude', name: 'Committed polling seat', clientKey: 'partial', expectedGeneration: member.generation, expectedPolicyVersion: 1 }) });
  expect(response.status).toBe(429); expect((await response.json()).error).toMatchObject({ committed: true, retrySafe: false });
  expect(core.store.list<{ name: string }>('seat').some((s) => s.name === 'Committed polling seat')).toBe(true);
});
