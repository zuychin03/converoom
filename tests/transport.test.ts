import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, issueBridgeCredential } from '../apps/daemon/src/server.js';
import type { Actor, Runtime, Store } from '../packages/shared/src/contracts.js';

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
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-http-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const runtime = memoryRuntime(dir);
  const server = await createServer(runtime, { port: 0, pairingCode: 'local-pair-code' });
  cleanup.push(() => server.close());
  const headers = { host: new URL(server.url).host, origin: server.url };
  return { runtime, server, headers };
}
describe('local identity boundary', () => {
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
});
