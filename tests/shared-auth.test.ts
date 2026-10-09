import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createCore } from '../packages/core/src/index.js';
import { createStore } from '../packages/store/src/index.js';
import { SharedOAuth } from '../packages/mcp/src/shared-auth.js';
import { startAuthorization } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Actor, Core, Room, HumanMembership } from '../packages/shared/src/contracts.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import { createHash } from 'node:crypto';
const a: Actor = { kind: 'human', ownerId: 'owner-a', principalId: 'human-a' };
const b: Actor = { kind: 'human', ownerId: 'owner-b', principalId: 'human-b' };
const origin = 'https://room.example.ts.net';
const client: OAuthClientInformationFull = { client_id: 'participant-bridge', client_name: 'Converoom participant bridge',
  redirect_uris: ['http://127.0.0.1:50181/oauth/callback'], token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] };
const verifier = 'v'.repeat(64), challenge = createHash('sha256').update(verifier).digest('base64url');
let core: Core, room: Room, member: HumanMembership, auth: SharedOAuth;
const call = (name: string, args: Record<string, unknown>, actor = a) => core.dispatch(actor, name, args);
const params = () => ({ state: 's'.repeat(32), scopes: ['room:' + room.id], codeChallenge: challenge,
  redirectUri: client.redirect_uris[0], resource: new URL(origin + '/mcp') });
async function code() {
  const request = auth.begin(client.client_id, params());
  return new URL(auth.approve(request.id, b)).searchParams.get('code')!;
}
async function tokens() {
  return auth.exchangeAuthorizationCode(client, await code(), verifier, client.redirect_uris[0], new URL(origin + '/mcp'));
}
beforeEach(async () => {
  core = createCore(createStore(':memory:'));
  room = await call('room_create', { title: 'Private HTTPS', objective: 'Keep identities separate' }) as Room;
  const invitation = await call('membership_invite', { roomId: room.id, displayName: 'Owner B', role: 'participant', clientKey: 'invite' }) as { code: string };
  member = await call('membership_redeem', { roomId: room.id, code: invitation.code }, b) as HumanMembership;
  await call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  auth = new SharedOAuth(core, origin, [client]);
});
afterEach(() => { vi.restoreAllMocks(); core?.store.close(); });
it('uses the pinned SDK authorization request and binds consent to the authenticated member', async () => {
  const started = await startAuthorization(new URL(origin), { clientInformation: client,
    metadata: auth.metadata, redirectUrl: client.redirect_uris[0], scope: 'room:' + room.id,
    state: 's'.repeat(32), resource: origin + '/mcp' });
  expect(started.authorizationUrl.origin).toBe(origin);
  const q = started.authorizationUrl.searchParams;
  const request = auth.begin(client.client_id, { ...params(), codeChallenge: q.get('code_challenge')! });
  const redirect = new URL(auth.approve(request.id, b));
  expect(redirect.origin).toBe('http://127.0.0.1:50181');
  expect(redirect.searchParams.get('state')).toBe('s'.repeat(32));
  expect(redirect.searchParams.get('iss')).toBe(origin);
  const result = await auth.exchangeAuthorizationCode(client, redirect.searchParams.get('code')!, started.codeVerifier,
    client.redirect_uris[0], new URL(origin + '/mcp'));
  expect((await auth.verifyAccessToken(result.access_token)).extra).toMatchObject({ actor: b, roomId: room.id, generation: member.generation });
});
it('rejects unknown clients, unsafe redirects, unsupported scopes and wrong resource audiences', () => {
  expect(() => auth.begin('unknown', params())).toThrow();
  for (const redirectUri of ['https://evil.test/callback', 'http://169.254.169.254/token', 'http://127.0.0.1:50182/oauth/callback'])
    expect(() => auth.begin(client.client_id, { ...params(), redirectUri })).toThrow();
  expect(() => auth.begin(client.client_id, { ...params(), resource: new URL('https://other.example.ts.net/mcp') })).toThrow();
  expect(() => auth.begin(client.client_id, { ...params(), scopes: ['local:owner'] })).toThrow();
  expect(auth.clientsStore.registerClient).toBeUndefined();
});
it('requires PKCE and exact redirect/resource binding for one-use authorization codes', async () => {
  const first = await code();
  await expect(auth.exchangeAuthorizationCode(client, first, 'x'.repeat(64), client.redirect_uris[0], new URL(origin + '/mcp'))).rejects.toThrow();
  await expect(auth.exchangeAuthorizationCode(client, first, verifier, 'http://127.0.0.1:50182/oauth/callback', new URL(origin + '/mcp'))).rejects.toThrow();
  await expect(auth.exchangeAuthorizationCode(client, first, verifier, client.redirect_uris[0], new URL(origin + '/other'))).rejects.toThrow();
  const result = await auth.exchangeAuthorizationCode(client, first, verifier, client.redirect_uris[0], new URL(origin + '/mcp'));
  expect(result.token_type).toBe('Bearer');
  await expect(auth.exchangeAuthorizationCode(client, first, verifier, client.redirect_uris[0], new URL(origin + '/mcp'))).rejects.toThrow();
});
it('denies agent approval and other-room membership', async () => {
  const request = auth.begin(client.client_id, params());
  expect(() => auth.approve(request.id, { kind: 'agent', ownerId: b.ownerId, principalId: 'agent-b' })).toThrow();
  expect(() => auth.approve(request.id, { kind: 'human', ownerId: 'owner-c', principalId: 'human-c' })).toThrow();
  const other = await call('room_create', { title: 'Other', objective: 'Private' }) as Room;
  const wrong = auth.begin(client.client_id, { ...params(), scopes: ['room:' + other.id] });
  expect(() => auth.approve(wrong.id, b)).toThrow();
});
it('checks membership generations on access and refresh after removal or restart', async () => {
  const result = await tokens();
  auth = new SharedOAuth(core, origin, [client]);
  expect((await auth.verifyAccessToken(result.access_token)).clientId).toBe(client.client_id);
  await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  await expect(auth.verifyAccessToken(result.access_token)).rejects.toThrow();
  await expect(auth.exchangeRefreshToken(client, result.refresh_token!, undefined, new URL(origin + '/mcp'))).rejects.toThrow();
});
it('rotates refresh tokens and revokes the complete credential family', async () => {
  const first = await tokens();
  const next = await auth.exchangeRefreshToken(client, first.refresh_token!, undefined, new URL(origin + '/mcp'));
  expect(next.refresh_token).not.toBe(first.refresh_token);
  await expect(auth.exchangeRefreshToken(client, first.refresh_token!, undefined, new URL(origin + '/mcp'))).rejects.toThrow();
  await auth.revokeToken(client, { token: next.refresh_token! });
  await expect(auth.verifyAccessToken(next.access_token)).rejects.toThrow();
  await expect(auth.verifyAccessToken(first.access_token)).rejects.toThrow();
});
it('expires requests and access tokens at their exact deadlines without persisting secrets', async () => {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const request = auth.begin(client.client_id, params()); now += 300000;
  expect(() => auth.approve(request.id, b)).toThrow();
  const result = await tokens();
  const rows = JSON.stringify([...core.store.list('shared_oauth_request'), ...core.store.list('shared_oauth_code'),
    ...core.store.list('shared_oauth_access'), ...core.store.list('shared_oauth_refresh')]);
  expect(rows).not.toContain(result.access_token); expect(rows).not.toContain(result.refresh_token);
  now += result.expires_in! * 1000;
  await expect(auth.verifyAccessToken(result.access_token)).rejects.toThrow();
});
it('fails closed on non-private or non-canonical origins and unsafe static clients', () => {
  for (const url of ['http://room.example.ts.net', 'https://public.example.com', origin + '/path', origin + '/?q=1', 'https://user@room.example.ts.net'])
    expect(() => new SharedOAuth(core, url, [client])).toThrow();
  expect(() => new SharedOAuth(core, origin, [{ ...client, redirect_uris: ['http://169.254.169.254/callback'] }])).toThrow();
});
