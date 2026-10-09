import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import type { Actor, Runtime, Room, Seat, Turn, HumanMembership, ToolArgs } from '../packages/shared/src/contracts.js';
const a: Actor = { kind: 'human', ownerId: 'owner-a', principalId: 'human-a' };
const b: Actor = { kind: 'human', ownerId: 'owner-b', principalId: 'human-b' };
let runtime: Runtime, dir: string, room: Room, seat: Seat, member: HumanMembership;
let started: number, cancelled: number, answer: (value: string) => void;
const call = (name: string, args: ToolArgs, actor = a) => runtime.core.dispatch(actor, name, args);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'converoom-managed-authority-')); started = 0; cancelled = 0;
  const prompt = new Promise<string>((resolve) => { answer = resolve; });
  runtime = await createRuntime(dir, { tickMs: 100, startSession: async (product) => {
    started++; return { id: 'authority-fixture', product, capabilities: ['prompt', 'cancel'], prompt: async () => prompt,
      cancel: async () => { cancelled++; answer('Withheld revoked answer'); }, close: async () => true };
  } });
  room = await call('room_create', { title: 'Shared managed authority', objective: 'Consent remains current' }) as Room;
  const invitation = await call('membership_invite', { roomId: room.id, displayName: 'B', role: 'participant', clientKey: 'invite' }) as { code: string };
  member = await call('membership_redeem', { roomId: room.id, code: invitation.code }, b) as HumanMembership;
  await call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  seat = await call('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'A owned' }) as Seat;
  await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
  await call('owner_consent_update', { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [b.ownerId], maxTurns: 3, maxTurnMs: 60000 });
});
afterEach(async () => {
  answer?.('Fixture ended'); await runtime?.stop();
  const target = resolve(dir); if (!relative(tmpdir(), target) || relative(tmpdir(), target).startsWith('..')) throw new Error('Unsafe cleanup');
  await rm(target, { recursive: true, force: true });
});
async function request() {
  const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Review only' }, b) as Turn;
  await call('permission_grant', { requestId: turn.permissionRequestId }); return turn;
}
it('does not admit a granted cross-owner turn after its exact consent changes', async () => {
  const turn = await request();
  await call('owner_consent_update', { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [], maxTurns: 3, maxTurnMs: 60000 });
  await expect.poll(() => runtime.core.store.get<Turn>('turn', turn.id)?.status, { timeout: 2000 }).toBe('cancelled');
  expect(started).toBe(0);
});
it('cancels active work after sender removal and never publishes or completes uncertain work', async () => {
  const turn = await request(); await expect.poll(() => runtime.core.store.get<Turn>('turn', turn.id)?.status).toBe('running');
  await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  await expect.poll(() => cancelled, { timeout: 2000 }).toBe(1);
  await expect.poll(() => runtime.core.store.get<Seat>('seat', seat.id)?.status).toBe('idle');
  expect(runtime.core.store.get<Turn>('turn', turn.id)?.status).toBe('uncertain');
  expect(runtime.core.store.eventCount(room.id, 'message')).toBe(0);
});
it('withholds an answer when consent changes before the next scheduler tick', async () => {
  const turn = await request(); await expect.poll(() => runtime.core.store.get<Turn>('turn', turn.id)?.status).toBe('running');
  await call('owner_consent_update', { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [], maxTurns: 3, maxTurnMs: 60000 });
  answer('Answer after consent withdrawal');
  await expect.poll(() => runtime.core.store.get<Seat>('seat', seat.id)?.status).toBe('idle');
  expect(runtime.core.store.get<Turn>('turn', turn.id)?.status).not.toBe('completed');
  expect(runtime.core.store.eventCount(room.id, 'message')).toBe(0);
});
