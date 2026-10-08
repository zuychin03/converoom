import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer } from '../apps/daemon/src/server.js';
import type { Actor, ToolArgs, Turn } from '../packages/shared/src/contracts.js';

it.each([false, true])('revokes a managed bridge and closes its worker when file cleanup fails: %s', async (cleanupFailure) => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-managed-tools-'));
  const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
  let bridge: { command: string; args: string[] } | undefined;
  let credentialFile = '', token = '', workerError: unknown, closed = false;
  const runtime = await createRuntime(dir, {
    tickMs: 10,
    startSession: async (...params) => {
      bridge = params[5];
      return {
        id: 'managed-bridge-fixture', product: params[0], capabilities: ['room-mcp'],
        prompt: async () => {
          try {
            if (!bridge) throw new Error('Managed bridge was not injected');
            credentialFile = bridge.args[bridge.args.indexOf('--credential-file') + 1];
            token = JSON.parse(await readFile(credentialFile, 'utf8')).token;
            const client = new Client({ name: 'managed-fixture', version: '1' }, { capabilities: {} });
            await client.connect(new StdioClientTransport({ ...bridge, stderr: 'pipe' }));
            try {
              const tools = (await client.listTools()).tools.map((tool) => tool.name);
              expect(tools).toContain('room_post');
              expect(tools).not.toContain('room_create');
              const roomId = String(room.id);
              const posted = await client.callTool({ name: 'room_post', arguments: {
                roomId, text: 'Public managed MCP message', clientKey: 'managed-post',
              } });
              expect(posted.isError).not.toBe(true);
              const otherRoom = await client.callTool({ name: 'room_read', arguments: { roomId: 'other' } });
              expect(otherRoom.isError).toBe(true);
              const grant = await fetch(server.url + '/agent/commands', {
                method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
                body: JSON.stringify({ name: 'permission_grant', args: {} }),
              });
              expect(grant.status).toBe(403);
            } finally { await client.close(); }
            if (cleanupFailure) {
              await rm(credentialFile);
              await mkdir(credentialFile);
            }
          } catch (e) { workerError = e; throw e; }
          return 'Public turn complete';
        },
        cancel: async () => {}, close: async () => { closed = true; return true; },
      };
    },
  });
  const server = await createServer(runtime, { port: 0 });
  const call = (name: string, args: ToolArgs) => runtime.core.dispatch(owner, name, args) as Promise<ToolArgs>;
  const room = await call('room_create', { title: 'Scoped tools', objective: 'Managed participation' });
  const seat = await call('seat_add', { roomId: room.id, name: 'Managed', product: 'codex', mode: 'managed' });
  await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
  try {
    await writeFile(join(dir, 'runtime.json'), JSON.stringify({ url: server.url }));
    const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Post through room tools' });
    await call('permission_grant', { requestId: turn.permissionRequestId });
    await expect.poll(() => bridge).toBeDefined();
    await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status, { timeout: 15000 }).toBe('completed');
    expect(workerError).toBeUndefined();
    await expect.poll(() => runtime.core.store.list('bridge').length).toBe(0);
    await expect.poll(() => closed).toBe(true);
    if (cleanupFailure)
      expect(runtime.core.store.events(String(room.id)).some((event) => event.type === 'bridge.cleanup_needed')).toBe(true);
    expect(JSON.stringify(runtime.core.store.events(String(room.id)))).toContain('Public managed MCP message');
    expect(JSON.stringify(runtime.core.store.events(String(room.id)))).not.toContain(token);
    const stale = await fetch(server.url + '/agent/commands', {
      method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'room_read', args: { roomId: room.id } }),
    });
    expect(stale.status).toBe(401);
  } finally {
    await server.close(); await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
