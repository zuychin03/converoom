import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import type { Actor, ToolArgs, Turn } from '../packages/shared/src/contracts.js';
const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
it('requires human grants, limits busy seats, records public replies and recovers without replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-scheduler-'));
  let started = 0,
    busy = 0,
    max = 0;
  const runtime = await createRuntime(dir, {
    tickMs: 20,
    startSession: async (product) => ({
      id: 'fixture-session-' + started++,
      product,
      capabilities: ['prompt', 'cancel'],
      prompt: async () => {
        busy++;
        max = Math.max(max, busy);
        await new Promise((r) => setTimeout(r, 100));
        busy--;
        return '<thinking>private analysis</thinking>Public reply';
      },
      cancel: async () => {},
      close: async () => true,
    }),
  });
  const call = (name: string, args: ToolArgs = {}) =>
    runtime.core.dispatch(owner, name, {
      ...args,
      clientKey: crypto.randomUUID(),
    }) as Promise<ToolArgs>;
  try {
    const room = await call('room_create', { title: 'Room', objective: 'Fixture debate' });
    const seat = await call('seat_add', {
      roomId: room.id,
      product: 'codex',
      mode: 'managed',
      name: 'Worker',
    });
    await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
    await call('policy_update', { roomId: room.id, policy: { cooldownMs: 1 } });
    const first = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'First' });
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toBe(0);
    const second = await call('turn_request', {
      roomId: room.id,
      seatId: seat.id,
      prompt: 'Second',
    });
    await call('permission_grant', { requestId: first.permissionRequestId });
    await call('permission_grant', { requestId: second.permissionRequestId });
    for (let i = 0; i < 100; i++) {
      if (runtime.core.store.get<Turn>('turn', String(second.id))?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runtime.core.store.get<Turn>('turn', String(second.id))?.status).toBe('completed');
    expect(max).toBe(1);
    expect(started).toBe(2);
    expect(JSON.stringify(runtime.core.store.events(String(room.id)))).not.toContain(
      'private analysis',
    );
    await runtime.stop();
    const recovered = await createRuntime(dir, { noScheduler: true });
    expect(recovered.core.store.list<Turn>('turn').every((t) => t.status === 'completed')).toBe(
      true,
    );
    await recovered.stop();
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
