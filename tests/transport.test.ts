import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, issueBridgeCredential } from '../apps/daemon/src/server.js';
import type { Actor, Runtime, Store } from '../packages/shared/src/contracts.js';
import { humanCommand } from '../apps/cli/src/human.js';
import { createHash } from 'node:crypto';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
function memoryRuntime(dataDir: string): Runtime {
  const records = new Map<string, unknown>();
  const store = {
    get: (k: string, id: string) => records.get(`${k}:${id}`),
    put: (k: string, id: string, v: unknown) => records.set(`${k}:${id}`, v),
    list: (k: string) => [...records].filter(([key]) => key.startsWith(`${k}:`)).map(([, v]) => v),
    remove: (k: string, id: string) => records.delete(`${k}:${id}`),
    events: () => [],
    recentEvents: () => [],
    eventsAfter: () => [],
    close: () => {},
  } as unknown as Store;
  return {
    dataDir,
    core: {
      store,
      dispatch: async (actor: Actor, name: string) => ({ actor, name }),
    } as unknown as Runtime['core'],
    stop: async () => {},
  };
}
async function fixture(onPairingCode?: (code: string) => void) {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-http-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const runtime = memoryRuntime(dir);
  const server = await createServer(runtime, {
    port: 0,
    pairingCode: 'local-pair-code',
    controlToken: 'installation-fixture-token',
    onPairingCode,
  });
  cleanup.push(() => server.close());
  const headers = { host: new URL(server.url).host, origin: server.url };
  return { runtime, server, headers };
}
describe('local identity boundary', () => {
  it('returns the prepared OAuth navigation only to the paired human without credentials', async () => {
    const { server, runtime, headers } = await fixture();
    runtime.core.dispatch = async () => ({ authorizationUrl: 'https://room.example.ts.net/authorize?client_id=participant-bridge', accessToken: 'fixture-private-token', connectionId: 'connection' });
    const pair = await server.app.inject({ method: 'POST', url: '/api/pair', headers, payload: { code: 'local-pair-code' } });
    const cookie = String(pair.headers['set-cookie']).split(';')[0];
    const session = await server.app.inject({ method: 'GET', url: '/api/session', headers: { ...headers, cookie } });
    const response = await server.app.inject({ method: 'POST', url: '/api/commands', headers: { ...headers, cookie, 'x-csrf-token': session.json().csrf }, payload: { name: 'remote_connection_prepare', args: {} } });
    expect(response.json()).toMatchObject({ result: { authorizationUrl: 'https://room.example.ts.net/authorize?client_id=participant-bridge' }, committed: true, retrySafe: false });
    expect(response.body).not.toContain('fixture-private-token');
    const credential = issueBridgeCredential(runtime, 'codex');
    expect((await server.app.inject({ method: 'POST', url: '/agent/commands', headers: { host: headers.host, authorization: 'Bearer ' + credential.token }, payload: { name: 'remote_connection_prepare', args: {} } })).statusCode).toBe(400);
  });
  it('accepts bounded human artefacts on a dedicated route with authentication before body parsing', async () => {
    const { server, headers } = await fixture();
    const pair = await server.app.inject({ method: 'POST', url: '/api/pair', headers, payload: { code: 'local-pair-code' } });
    const cookie = String(pair.headers['set-cookie']).split(';')[0];
    const session = await server.app.inject({ method: 'GET', url: '/api/session', headers: { ...headers, cookie } });
    const payload = { name: 'shared_artefact_publish', args: { roomId: 'room', content: 'x'.repeat(1048576) } };
    expect((await server.app.inject({ method: 'POST', url: '/api/artefacts', headers: { ...headers, cookie, 'x-csrf-token': session.json().csrf }, payload })).statusCode).toBe(200);
    expect((await server.app.inject({ method: 'POST', url: '/api/artefacts', headers, payload })).statusCode).toBe(401);
    expect((await server.app.inject({ method: 'POST', url: '/api/commands', headers: { ...headers, cookie, 'x-csrf-token': session.json().csrf }, payload })).statusCode).toBe(413);
  });
  it('does not let the on-disk installation token act as a human or obtain a pairing code', async () => {
    let terminalCode = '';
    const { server, headers } = await fixture((code) => { terminalCode = code; });
    const installationHeaders = { host: headers.host, authorization: 'Bearer installation-fixture-token' };
    for (const name of ['permission_grant', 'candidate_apply', 'room_list']) {
      const response = await server.app.inject({
        method: 'POST', url: '/local/commands', headers: installationHeaders,
        payload: { name, args: { roomId: 'room', requestId: 'request' } },
      });
      expect(response.statusCode).toBe(403);
    }
    const pair = await server.app.inject({
      method: 'POST', url: '/local/pair', headers: installationHeaders, payload: {},
    });
    expect(pair.statusCode).toBe(200);
    expect(terminalCode.length).toBeGreaterThanOrEqual(12);
    expect(pair.body).not.toContain(terminalCode);
    expect(pair.json()).not.toHaveProperty('code');
    expect((await server.app.inject({
      method: 'POST', url: '/api/pair', headers,
      payload: { code: 'local-pair-code' },
    })).statusCode).toBe(401);
    expect((await server.app.inject({
      method: 'POST', url: '/api/pair', headers,
      payload: { code: terminalCode },
    })).statusCode).toBe(200);
  });
  it('rejects unpaired browser access and reusing a pairing code', async () => {
    const { server, headers } = await fixture();
    expect(
      (await server.app.inject({ method: 'GET', url: '/api/state', headers })).statusCode,
    ).toBe(401);
    const pair = await server.app.inject({
      method: 'POST',
      url: '/api/pair',
      headers,
      payload: { code: 'local-pair-code' },
    });
    expect(pair.statusCode).toBe(200);
    expect(pair.headers['set-cookie']).toContain('HttpOnly');
    expect(pair.headers['set-cookie']).toContain('SameSite=Strict');
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/pair',
          headers,
          payload: { code: 'local-pair-code' },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('pairs an explicit CLI human command without storing its session credential', async () => {
    const { server, runtime } = await fixture();
    const result = await humanCommand(server.url, 'local-pair-code', 'room_list', {}) as { actor: Actor };
    expect(result.actor.kind).toBe('human');
    expect(runtime.core.store.list('bridge')).toEqual([]);
    await expect(humanCommand(server.url, 'local-pair-code', 'room_list', {})).rejects.toThrow(/invalid|expired/);
    await expect(humanCommand('https://example.com', 'fixture', 'room_list', {})).rejects.toThrow(/loopback/);
  });
  it('requires exact host, browser origin and CSRF for human mutations', async () => {
    const { server, headers } = await fixture();
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/pair',
          headers: { ...headers, origin: 'https://evil.invalid' },
          payload: { code: 'local-pair-code' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await server.app.inject({
          method: 'GET',
          url: '/api/state',
          headers: { ...headers, host: 'evil.invalid' },
        })
      ).statusCode,
    ).toBe(403);
    const pair = await server.app.inject({
      method: 'POST',
      url: '/api/pair',
      headers,
      payload: { code: 'local-pair-code' },
    });
    const cookie = String(pair.headers['set-cookie']).split(';')[0];
    const session = await server.app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { ...headers, cookie },
    });
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/api/commands',
          headers: { ...headers, cookie },
          payload: { name: 'room_list', args: {} },
        })
      ).statusCode,
    ).toBe(403);
    const response = await server.app.inject({
      method: 'POST',
      url: '/api/commands',
      headers: { ...headers, cookie, 'x-csrf-token': session.json().csrf },
      payload: { name: 'room_list', args: {} },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result.actor.kind).toBe('human');
  });
  it('binds agent tokens to server principals and rejects token substitution for human routes', async () => {
    const { server, headers, runtime } = await fixture();
    const credential = issueBridgeCredential(runtime, 'codex');
    const agentHeaders = { host: headers.host, authorization: `Bearer ${credential.token}` };
    expect(
      (await server.app.inject({ method: 'GET', url: '/api/state', headers: agentHeaders }))
        .statusCode,
    ).toBe(401);
    const result = await server.app.inject({
      method: 'POST',
      url: '/agent/commands',
      headers: agentHeaders,
      payload: { name: 'room_list', args: {} },
    });
    expect(result.statusCode).toBe(200);
    expect(result.json().result.actor.principalId).toBe(credential.principalId);
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/agent/commands',
          headers: agentHeaders,
          payload: { name: 'room_list', args: { ownerId: 'forged-owner' } },
        })
      ).statusCode,
    ).toBe(400);
    expect(JSON.stringify(runtime.core.store.list('bridge'))).not.toContain(credential.token);
  });
  it('rejects oversized payloads and never discloses internal errors', async () => {
    const { server, headers, runtime } = await fixture();
    const credential = issueBridgeCredential(runtime, 'codex');
    runtime.core.dispatch = async () => {
      throw new Error('secret-runtime-value');
    };
    const agentHeaders = { host: headers.host, authorization: `Bearer ${credential.token}` };
    const response = await server.app.inject({
      method: 'POST',
      url: '/agent/commands',
      headers: agentHeaders,
      payload: { name: 'room_list', args: {} },
    });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain('secret-runtime-value');
    expect(
      (
        await server.app.inject({
          method: 'POST',
          url: '/agent/commands',
          headers: agentHeaders,
          payload: { name: 'room_post', args: { text: 'x'.repeat(70000) } },
        })
      ).statusCode,
    ).toBe(413);
  });
  it('rejects an expired or replaced managed attempt directly at authentication', async () => {
    const { server, runtime, headers } = await fixture();
    const credential = issueBridgeCredential(runtime, 'codex');
    const key = createHash('sha256').update(credential.token).digest('hex');
    runtime.core.store.put('bridge', key, { ...runtime.core.store.get<Actor>('bridge', key),
      scope: { roomId: 'scoped-room', seatId: 'scoped-seat', turnId: 'scoped-turn', attemptId: 'scoped-attempt', generation: 1 } });
    runtime.core.store.put('seat', 'scoped-seat', { principalId: credential.principalId, consent: true, status: 'busy' });
    runtime.core.store.put('turn', 'scoped-turn', { roomId: 'scoped-room', seatId: 'scoped-seat', attemptId: 'scoped-attempt', status: 'running' });
    const attempt = { taskId: 'task', status: 'running', generation: 1, leaseExpiresAt: Date.now() + 60000 };
    runtime.core.store.put('attempt', 'scoped-attempt', attempt);
    runtime.core.store.put('task', 'scoped-room:task', { generation: 1 });
    const request = () => server.app.inject({
      method: 'POST', url: '/agent/commands',
      headers: { host: headers.host, authorization: 'Bearer ' + credential.token },
      payload: { name: 'room_post', args: { roomId: 'scoped-room', text: 'Public fixture', clientKey: 'post' } },
    });
    expect((await request()).statusCode).toBe(200);
    runtime.core.store.put('attempt', 'scoped-attempt', { ...attempt, leaseExpiresAt: Date.now() - 1 });
    expect((await request()).statusCode).toBe(401);
    runtime.core.store.put('attempt', 'scoped-attempt', attempt);
    runtime.core.store.put('task', 'scoped-room:task', { generation: 2 });
    expect((await request()).statusCode).toBe(401);
  });
});
