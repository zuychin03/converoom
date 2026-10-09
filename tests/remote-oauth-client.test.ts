import { it, expect } from 'vitest';
import { RoomOAuthClient, pinnedFetch } from '../packages/mcp/src/remote.js';
const origin = 'https://room.example.ts.net', redirect = 'http://127.0.0.1:50181/oauth/callback';
it('binds the callback to its exact redirect, state and issuer before accepting a code', () => {
  const client = new RoomOAuthClient(origin, 'room-id', 'participant-bridge', redirect);
  const state = client.state();
  const callback = new URL(redirect); callback.searchParams.set('code', 'fixture-code');
  callback.searchParams.set('state', state); callback.searchParams.set('iss', origin);
  for (const value of [callback.href.replace(state, 'wrong'), callback.href.replace('iss=' + encodeURIComponent(origin), 'iss=' + encodeURIComponent('https://evil.test')),
    callback.href.replace(':50181', ':50182')]) expect(() => client.acceptCallback(new URL(value))).toThrow();
  expect(client.acceptCallback(callback)).toBe('fixture-code');
  expect(() => client.acceptCallback(callback)).toThrow();
});
it('pins client metadata, authorization redirects and stored token issuers', () => {
  const client = new RoomOAuthClient(origin, 'room-id', 'participant-bridge', redirect);
  expect(client.clientInformation()).toMatchObject({ client_id: 'participant-bridge', issuer: origin });
  expect(() => client.redirectToAuthorization(new URL('https://evil.test/authorize'))).toThrow();
  expect(() => client.saveTokens({ access_token: 'fixture', token_type: 'Bearer', issuer: 'https://evil.test' })).toThrow();
  client.saveCodeVerifier('v'.repeat(64)); expect(client.codeVerifier()).toBe('v'.repeat(64));
});
it('blocks metadata and token fetches outside the configured HTTPS origin before sending credentials', async () => {
  let requests = 0;
  const fetcher = pinnedFetch(origin, async (_url, options) => { requests++; expect(options?.redirect).toBe('error'); return new Response('{}'); });
  for (const url of ['http://169.254.169.254/latest', 'https://evil.test/token', 'https://user@room.example.ts.net/token'])
    await expect(fetcher(url)).rejects.toThrow();
  expect(requests).toBe(0); await fetcher(origin + '/token'); expect(requests).toBe(1);
});
it('retains the pending callback binding across a participant daemon restart', () => {
  const first = new RoomOAuthClient(origin, 'room-id', 'participant-bridge', redirect);
  first.saveCodeVerifier('v'.repeat(64));
  const restarted = new RoomOAuthClient(origin, 'room-id', 'participant-bridge', redirect, first.snapshot());
  const callback = new URL(redirect); callback.searchParams.set('code', 'fixture');
  callback.searchParams.set('state', first.state()); callback.searchParams.set('iss', origin);
  expect(restarted.acceptCallback(callback)).toBe('fixture'); expect(restarted.codeVerifier()).toBe('v'.repeat(64));
});
