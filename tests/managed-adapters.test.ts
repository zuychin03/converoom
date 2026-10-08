import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Actor, ToolArgs, Turn, Seat } from '../packages/shared/src/contracts.js';
vi.mock('../packages/adapters/src/process.js', async (original) => ({
  ...await original<typeof import('../packages/adapters/src/process.js')>(),
  executable: async (name: string) => ({ command: process.execPath,
    args: [join(process.cwd(), 'tests', 'fixtures', 'managed-vendor.mjs'), name === 'agent' ? 'cursor' : name] }),
}));
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer } from '../apps/daemon/src/server.js';

it.each(['codex', 'cursor'])('injects the scoped MCP bridge through the %s native wire format', async (product) => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-protocol-'));
  const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
  const runtime = await createRuntime(dir, { tickMs: 10 });
  const server = await createServer(runtime, { port: 0 });
  const call = (name: string, args: ToolArgs) => runtime.core.dispatch(owner, name, args) as Promise<ToolArgs>;
  try {
    await writeFile(join(dir, 'runtime.json'), JSON.stringify({ url: server.url }));
    const room = await call('room_create', { title: 'Native wire fixture', objective: 'Check room tools' });
    const seat = await call('seat_add', { roomId: room.id, product, mode: 'managed', name: 'Fixture' });
    await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
    const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Post with Converoom MCP' });
    await call('permission_grant', { requestId: turn.permissionRequestId });
    await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status, { timeout: 15000 }).toBe('completed');
    await expect.poll(() => runtime.core.store.list('bridge').length).toBe(0);
    const events = runtime.core.store.events(String(room.id));
    expect(JSON.stringify(events)).toContain(product + ' protocol fixture MCP message');
    expect(runtime.core.store.get<Seat>('seat', String(seat.id))?.capabilities.probed).not.toContain('room-mcp');
    expect(events.find((event) => event.type === 'turn.started')?.data.mcpInjected).toBe(true);
  } finally {
    await server.close(); await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
