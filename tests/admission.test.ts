import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import type { Actor, ToolArgs, Turn } from '../packages/shared/src/contracts.js';
const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
it('does not execute a changed prompt under a previous execution grant', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-admission-'));
  let prompts = 0;
  const runtime = await createRuntime(dir, {
    tickMs: 10,
    startSession: async (product) => ({
      id: 'fixture',
      product,
      capabilities: [],
      prompt: async () => {
        prompts++;
        return 'reply';
      },
      cancel: async () => {},
      close: async () => true,
    }),
  });
  const call = (n: string, x: ToolArgs) => runtime.core.dispatch(owner, n, x) as Promise<ToolArgs>;
  try {
    const room = await call('room_create', { title: 'Scoped grant', objective: 'Test admission' }),
      seat = await call('seat_add', {
        roomId: room.id,
        name: 'Codex',
        mode: 'managed',
        product: 'codex',
      });
    await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
    const turn = await call('turn_request', {
      roomId: room.id,
      seatId: seat.id,
      prompt: 'Approved prompt',
    });
    await call('permission_grant', { requestId: turn.permissionRequestId });
    runtime.core.store.put('turn', String(turn.id), { ...turn, prompt: 'Changed prompt' });
    await new Promise((r) => setTimeout(r, 150));
    expect(prompts).toBe(0);
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
it('blocks queued inference from a revoked host principal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-revoked-'));
  let prompts = 0;
  const runtime = await createRuntime(dir, {
    tickMs: 10,
    startSession: async (product) => ({
      id: 'fixture',
      product,
      capabilities: [],
      prompt: async () => {
        prompts++;
        return 'reply';
      },
      cancel: async () => {},
      close: async () => true,
    }),
  });
  try {
    const host: Actor = { kind: 'agent', principalId: 'host', ownerId: 'owner' },
      room = (await runtime.core.dispatch(host, 'room_create', {
        title: 'Revocation',
        objective: 'Sender check',
      })) as ToolArgs,
      seat = (await runtime.core.dispatch(owner, 'seat_add', {
        roomId: room.id,
        name: 'Worker',
        product: 'codex',
        mode: 'managed',
      })) as ToolArgs;
    await runtime.core.dispatch(owner, 'seat_consent', {
      roomId: room.id,
      seatId: seat.id,
      consent: true,
    });
    const turn = (await runtime.core.dispatch(host, 'turn_request', {
      roomId: room.id,
      seatId: seat.id,
      prompt: 'Queued',
    })) as ToolArgs;
    runtime.core.store.put('revoked', 'host', { at: Date.now() });
    await runtime.core.dispatch(owner, 'permission_grant', { requestId: turn.permissionRequestId });
    await new Promise((r) => setTimeout(r, 150));
    expect(prompts).toBe(0);
    expect(runtime.core.store.get<Turn>('turn', String(turn.id))?.status).toBe('cancelled');
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
it('awaits in-flight session initialisation before closing the store on shutdown', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-shutdown-'));
  let initialising = false,
    closed = false,
    prompts = 0;
  const runtime = await createRuntime(dir, {
    tickMs: 10,
    startSession: async (product) => {
      initialising = true;
      await new Promise((r) => setTimeout(r, 2250));
      return {
        id: 'delayed',
        product,
        capabilities: [],
        prompt: async () => {
          prompts++;
          return 'reply';
        },
        cancel: async () => {},
        close: async () => {
          closed = true;
          return true;
        },
      };
    },
  });
  const call = (n: string, x: ToolArgs) => runtime.core.dispatch(owner, n, x) as Promise<ToolArgs>;
  try {
    const room = await call('room_create', { title: 'Shutdown', objective: 'Pending admission' }),
      seat = await call('seat_add', {
        roomId: room.id,
        name: 'Codex',
        mode: 'managed',
        product: 'codex',
      });
    await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
    const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Task' });
    await call('permission_grant', { requestId: turn.permissionRequestId });
    for (let i = 0; i < 100 && !initialising; i++) await new Promise((r) => setTimeout(r, 10));
    expect(initialising).toBe(true);
    await runtime.stop();
    expect(closed).toBe(true);
    expect(prompts).toBe(0);
    const recovered = await createRuntime(dir, { noScheduler: true });
    try {
      expect(recovered.core.store.get<Turn>('turn', String(turn.id))?.status).toBe('cancelled');
    } finally {
      await recovered.stop();
    }
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
