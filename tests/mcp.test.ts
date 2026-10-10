import { it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, issueBridgeCredential } from '../apps/daemon/src/server.js';
import type { ToolArgs } from '../packages/shared/src/contracts.js';
it('runs the same stdio room corpus for all eight vendor bridge identities', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-mcp-')),
    runtime = await createRuntime(dir, { noScheduler: true }),
    server = await createServer(runtime, { port: 0 });
  const clients: Client[] = [];
  const call = async (c: Client, name: string, args: ToolArgs) => {
    const r = await c.callTool({ name, arguments: args });
    expect(r.isError).not.toBe(true);
    return JSON.parse((r.content as { text: string }[])[0].text).result as ToolArgs;
  };
  try {
    await writeFile(join(dir, 'runtime.json'), JSON.stringify({ url: server.url }));
    await mkdir(join(dir, 'clients'));
    let firstRoom = '';
    for (const product of ['codex', 'cursor', 'claude', 'opencode', 'antigravity', 'kiro', 'qoder', 'grok'] as const) {
      const credential = issueBridgeCredential(runtime, product);
      await writeFile(join(dir, 'clients', product + '.json'), JSON.stringify(credential));
      const c = new Client({ name: 'fixture-' + product, version: '1.0' }, { capabilities: {} });
      await c.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [
            join(process.cwd(), 'dist', 'cli.js'),
            'mcp',
            '--client',
            product,
            '--data-dir',
            dir,
          ],
          stderr: 'pipe',
        }),
      );
      clients.push(c);
      expect((await c.listTools()).tools.some((t) => t.name === 'room_create')).toBe(true);
      const room = await call(c, 'room_create', {
        title: product + ' room',
        objective: 'Common contract',
        product,
        clientKey: 'create',
      });
      expect(room.appUrl).toContain('/?room=');
      let targetId: string;
      if (!firstRoom) { firstRoom = String(room.id); targetId = String(room.hostSeatId); }
      else
        targetId = String((await call(c, 'room_join', {
          roomId: firstRoom,
          name: product,
          product,
          clientKey: 'join',
        })).id);
      await call(c, 'room_post', {
        roomId: firstRoom,
        text: product + ' public position',
        clientKey: 'post',
      });
      const read = await call(c, 'room_read', { roomId: firstRoom, cursor: 0 });
      expect(JSON.stringify(read)).toContain(product + ' public position');
      const turn = await call(clients[0], 'turn_request', { roomId: firstRoom, seatId: targetId,
        prompt: 'Public polling response', clientKey: 'request-' + product });
      await call(c, 'turn_claim', { roomId: firstRoom, turnId: turn.id, clientKey: 'claim' });
      expect(await call(c, 'turn_complete', { roomId: firstRoom, turnId: turn.id,
        text: product + ' completed polling turn', clientKey: 'complete' })).toMatchObject({ status: 'completed' });
      if (product !== 'codex') await call(c, 'room_leave', { roomId: firstRoom, clientKey: 'leave' });
    }
    await call(clients[0], 'room_close', { roomId: firstRoom, clientKey: 'close' });
  } finally {
    for (const c of clients) await c.close();
    await server.close();
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
