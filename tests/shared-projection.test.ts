import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createCore } from '../packages/core/src/index.js';
import { createStore } from '../packages/store/src/index.js';
import { sharedProjection, sharedCommand } from '../packages/core/src/membership.js';
import type { Actor, Core, HumanMembership, Room, Seat, ToolArgs } from '../packages/shared/src/contracts.js';
const a: Actor = { kind: 'human', principalId: 'human-a', ownerId: 'owner-a' };
const b: Actor = { kind: 'human', principalId: 'human-b', ownerId: 'owner-b' };
let core: Core, room: Room, member: HumanMembership, seat: Seat;
const call = (name: string, args: ToolArgs, actor = a) => core.dispatch(actor, name, args);
beforeEach(async () => {
  core = createCore(createStore(':memory:')); room = await call('room_create', { title: 'Shared', objective: 'Private projection' }) as Room;
  const invitation = await call('membership_invite', { roomId: room.id, displayName: 'B', role: 'participant', clientKey: 'invite' }) as { code: string };
  member = await call('membership_redeem', { roomId: room.id, code: invitation.code }, b) as HumanMembership;
  await call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  seat = await call('seat_add', { roomId: room.id, product: 'claude', name: 'B agent' }, b) as Seat;
});
afterEach(() => core?.store.close());
it('advances only receipts for actual shared message content and exposes their public status', async () => {
  const message = await call('room_post', { roomId: room.id, text: 'Review this', mentions: [{ seatId: seat.id, intent: 'review' }] }) as { id: string };
  const agent: Actor = { kind: 'agent', principalId: seat.principalId, ownerId: b.ownerId };
  await sharedCommand(core, agent, room.id, member.generation, 'room_inbox', { roomId: room.id });
  expect(core.store.list<ToolArgs>('interaction')[0].status).toBe('delivered');
  await sharedCommand(core, agent, room.id, member.generation, 'room_read', { roomId: room.id, cursor: 0, limit: 100 });
  expect(core.store.list<ToolArgs>('interaction')[0].status).toBe('read');
  expect(sharedProjection(core, b, room.id).interactions).toEqual([expect.objectContaining({ messageId: message.id, status: 'read' })]);
});
it('selects one authorised room and omits local paths, credentials and execution internals', async () => {
  const other = await call('room_create', { title: 'Private other room', objective: 'Never share' }) as Room;
  core.store.put('seat', seat.id, { ...seat, sessionId: 'private-session', pid: 999, cwd: 'C:\\private\\repo', token: 'fixture-private-token' });
  core.store.put('repo', 'private-repo', { roomId: room.id, path: 'C:\\private\\repo' });
  core.store.append(room.id, 'turn.started', 'runtime', { workspace: 'C:\\private\\repo', sessionId: 'private-session', pid: 999 });
  core.store.append(room.id, 'permission.requested', 'runtime', { scope: { path: 'C:\\private\\repo' } });
  await call('room_post', { roomId: room.id, text: 'Public answer' }, b);
  const projection = sharedProjection(core, b, room.id), json = JSON.stringify(projection);
  expect(json).toContain('Public answer');
  for (const privateValue of ['C:\\private', 'fixture-private-token', 'private-session', 'Private other room', 'permission.requested']) expect(json).not.toContain(privateValue);
  await expect(sharedCommand(core, b, room.id, member.generation, 'room_get', { roomId: other.id })).rejects.toThrow();
});
it('returns only the authenticated agent’s pending turns', async () => {
  const otherSeat = await call('seat_add', { roomId: room.id, product: 'codex', name: 'A private', mode: 'managed' }) as Seat;
  await call('seat_consent', { roomId: room.id, seatId: otherSeat.id, consent: true });
  await call('turn_request', { roomId: room.id, seatId: otherSeat.id, prompt: 'A private turn' });
  await call('owner_consent_update', { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [a.ownerId], maxTurns: 2, maxTurnMs: 60000 }, b);
  await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'B public review' });
  const inbox = await sharedCommand(core, { kind: 'agent', principalId: seat.principalId, ownerId: b.ownerId }, room.id,
    member.generation, 'room_inbox', { roomId: room.id });
  const json = JSON.stringify(inbox); expect(json).toContain('B public review'); expect(json).not.toContain('A private turn');
  expect(json).not.toContain('permissionRequestId');
});
it('rejects private commands and coding rooms before their handlers run', async () => {
  for (const name of ['permission_grant', 'candidate_apply', 'repo_register', 'managed_stop', 'task_claim', 'profile_register', 'backup_request'])
    await expect(sharedCommand(core, b, room.id, member.generation, name, { roomId: room.id, clientKey: name, expectedGeneration: member.generation, expectedPolicyVersion: 1 })).rejects.toThrow();
  const coding = await call('room_create', { title: 'Coding', objective: 'Local only', workflow: 'coding' }) as Room;
  await expect(sharedCommand(core, a, coding.id, 1, 'room_get', { roomId: coding.id })).rejects.toThrow();
});
it('requires membership/policy versions and idempotency before accepting shared writes', async () => {
  await expect(sharedCommand(core, b, room.id, member.generation, 'room_post', { roomId: room.id, text: 'Missing versions' })).rejects.toThrow();
  const args = { roomId: room.id, text: 'Once', clientKey: 'post-once', expectedGeneration: member.generation, expectedPolicyVersion: 1 };
  await sharedCommand(core, b, room.id, member.generation, 'room_post', args);
  await sharedCommand(core, b, room.id, member.generation, 'room_post', args);
  expect(core.store.eventCount(room.id, 'message')).toBe(1);
  await call('policy_update', { roomId: room.id, policy: { maxMessages: 50 } });
  await expect(sharedCommand(core, b, room.id, member.generation, 'room_post', args)).rejects.toThrow();
  await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  expect(() => sharedProjection(core, b, room.id)).toThrow();
});
it('bounds retained history while advancing over private events', async () => {
  for (let i = 0; i < 1100; i++) core.store.append(room.id, 'private.fixture', 'runtime', { privatePath: 'C:\\private' });
  await call('room_post', { roomId: room.id, text: 'Latest public message' }, b);
  const projection = sharedProjection(core, b, room.id);
  expect((projection.events as ToolArgs[]).length).toBeLessThanOrEqual(100);
  expect(JSON.stringify(projection)).toContain('Latest public message');
  expect(JSON.stringify(projection)).not.toContain('privatePath');
  const page = await sharedCommand(core, b, room.id, member.generation, 'room_read', { roomId: room.id, cursor: 0, limit: 100 });
  expect((page as ToolArgs).cursor).toBeGreaterThan(0);
});
it('bounds shared state and event pages in bytes with visible omission metadata', async () => {
  for (let i = 0; i < 20; i++) core.store.append(room.id, 'message', 'owner', { text: 'x'.repeat(60000) });
  const projection = sharedProjection(core, b, room.id);
  expect(Buffer.byteLength(JSON.stringify(projection))).toBeLessThanOrEqual(524288);
  expect((projection.omitted as ToolArgs).events).toBeGreaterThan(0);
  const page = await sharedCommand(core, b, room.id, member.generation, 'room_read', { roomId: room.id });
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(524288);
  expect((page as ToolArgs).cursor).toBeLessThan(room.seq + 20);
});
it('avoids materialising a thousand large events at once while building a projection', async () => {
  for (let i = 0; i < 200; i++) core.store.append(room.id, 'message', 'owner', { text: 'x'.repeat(60000) });
  const events = vi.spyOn(core.store, 'events');
  sharedProjection(core, b, room.id);
  await sharedCommand(core, b, room.id, member.generation, 'room_read', { roomId: room.id, limit: 100 });
  expect(Math.max(...events.mock.calls.map((args) => Number(args[2])))).toBeLessThanOrEqual(100);
});
