import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import type { Actor, Core, HumanMembership, Room, Seat, Store, ToolArgs } from '../packages/shared/src/contracts.js';
const a: Actor = { kind: 'human', principalId: 'human-a', ownerId: 'owner-a' };
const b: Actor = { kind: 'human', principalId: 'human-b', ownerId: 'owner-b' };
let core: Core, store: Store, dir: string, room: Room;
type Invite = { id: string; code?: string; expiresAt: number; codeAvailable: boolean };
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = a) => core.dispatch(actor, name, args) as Promise<T>;
const invite = (args: ToolArgs = {}) => call<Invite>('membership_invite', { roomId: room.id,
  displayName: 'Owner B', role: 'participant', clientKey: crypto.randomUUID(), ...args });
async function joinParticipant(role = 'participant') {
  const invitation = await invite({ role });
  const member = await call<HumanMembership>('membership_redeem', { roomId: room.id, code: invitation.code, clientKey: crypto.randomUUID() }, b);
  await call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  return member;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'converoom-membership-'));
  store = createStore(join(dir, 'source.sqlite')); core = createCore(store);
  room = await call<Room>('room_create', { title: 'Shared discussion', objective: 'Separate owner authority' });
});
afterEach(async () => { vi.restoreAllMocks(); store?.close(); if (dir) await rm(dir, { recursive: true, force: true }); });
it('recovers the existing human identity only through a bound one-use owner invitation and fresh confirmation', async () => {
  const member = await joinParticipant();
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'codex', name: 'B retained' }, b);
  await expect(invite({ recoverMemberId: member.id, expectedGeneration: member.generation + 1 })).rejects.toThrow();
  const recovery = await invite({ recoverMemberId: member.id, expectedGeneration: member.generation });
  const stranger: Actor = { kind: 'human', ownerId: 'temporary-owner', principalId: 'temporary-human' };
  await expect(call('membership_redeem', { roomId: room.id, code: recovery.code }, stranger)).rejects.toThrow();
  const recovered = await call<HumanMembership>('membership_recover', { roomId: room.id, code: recovery.code }, stranger);
  expect(recovered).toMatchObject({ id: member.id, ownerId: b.ownerId, principalId: b.principalId, status: 'pending', generation: member.generation + 1 });
  expect(store.count('human_membership', { roomId: room.id })).toBe(2);
  expect(store.get<Seat>('seat', seat.id)).toMatchObject({ ownerId: b.ownerId, status: 'left', consent: false });
  await expect(call('room_get', { roomId: room.id }, b)).rejects.toThrow();
  await expect(call('membership_recover', { roomId: room.id, code: recovery.code }, stranger)).rejects.toThrow();
  await call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: recovered.generation });
  expect(await call('room_get', { roomId: room.id }, b)).toMatchObject({ id: room.id });
});
it('keeps pending membership private until the inviter confirms the authenticated participant', async () => {
  const invitation = await invite();
  expect(invitation.expiresAt - Date.now()).toBeGreaterThan(590000);
  const member = await call<HumanMembership>('membership_redeem', { roomId: room.id, code: invitation.code }, b);
  expect(member).toMatchObject({ ownerId: b.ownerId, principalId: b.principalId, status: 'pending', generation: 1 });
  await expect(call('room_get', { roomId: room.id }, b)).rejects.toThrow();
  await expect(call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: 1 }, b)).rejects.toThrow();
  await call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: 1 });
  expect(await call('room_get', { roomId: room.id }, b)).toMatchObject({ id: room.id });
  const other = await call<Room>('room_create', { title: 'Private A', objective: 'No cross-room access' });
  await expect(call('room_get', { roomId: other.id }, b)).rejects.toThrow();
  expect(await call('room_list', {}, b)).toEqual([expect.objectContaining({ id: room.id })]);
});
it('redeems once atomically and survives a restart while pending', async () => {
  const invitation = await invite();
  const results = await Promise.allSettled([
    call<HumanMembership>('membership_redeem', { roomId: room.id, code: invitation.code }, b),
    call<HumanMembership>('membership_redeem', { roomId: room.id, code: invitation.code }, { kind: 'human', principalId: 'human-c', ownerId: 'owner-c' }),
  ]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  const member = (results.find((r) => r.status === 'fulfilled') as PromiseFulfilledResult<HumanMembership>).value;
  core = createCore(store);
  await call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  await expect(call('membership_redeem', { roomId: room.id, code: invitation.code }, b)).rejects.toThrow();
});
it('shows an invitation secret once without persisting it in records or idempotency results', async () => {
  const first = await invite({ clientKey: 'create-once' });
  expect(typeof first.code).toBe('string');
  const repeated = await invite({ clientKey: 'create-once' });
  expect(repeated).toMatchObject({ id: first.id, codeAvailable: false });
  expect(repeated.code).toBeUndefined();
  expect(store.list('invitation')).toHaveLength(1);
  const path = join(dir, 'backup.sqlite'); await store.backup(path);
  expect((await readFile(path)).includes(Buffer.from(first.code!))).toBe(false);
  await expect(invite({ clientKey: 'create-once', displayName: 'Different scope' })).rejects.toThrow();
});
it('refuses expired, revoked and cross-room invitation codes without granting access', async () => {
  let now = 1000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const expired = await invite(); now = expired.expiresAt;
  await expect(call('membership_redeem', { roomId: room.id, code: expired.code }, b)).rejects.toThrow();
  const revoked = await invite(); await call('invitation_revoke', { roomId: room.id, invitationId: revoked.id });
  await expect(call('membership_redeem', { roomId: room.id, code: revoked.code }, b)).rejects.toThrow();
  const valid = await invite(), other = await call<Room>('room_create', { title: 'Other', objective: 'Bound code to room' });
  await expect(call('membership_redeem', { roomId: other.id, code: valid.code }, b)).rejects.toThrow();
});
it('denies identity injection, agent invitations, coding-room sharing and stale confirmation', async () => {
  await expect(invite({ ownerId: b.ownerId })).rejects.toThrow(/identity/i);
  await expect(call('membership_invite', { roomId: room.id, displayName: 'B' }, { kind: 'agent', principalId: 'agent-a', ownerId: a.ownerId })).rejects.toThrow();
  const coding = await call<Room>('room_create', { title: 'Coding', objective: 'Local only', workflow: 'coding' });
  await expect(invite({ roomId: coding.id })).rejects.toThrow();
  const invitation = await invite();
  const member = await call<HumanMembership>('membership_redeem', { roomId: room.id, code: invitation.code }, b);
  await expect(call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: 99 })).rejects.toThrow();
});
it('registers only an active participant owner’s agents and preserves permission ownership', async () => {
  await joinParticipant();
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'B agent', mode: 'polling' }, b);
  expect(seat.ownerId).toBe(b.ownerId);
  const agent: Actor = { kind: 'agent', principalId: seat.principalId, ownerId: seat.ownerId };
  await call('room_post', { roomId: room.id, text: 'B public response' }, agent);
  await expect(call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true })).rejects.toThrow();
  await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true }, b);
  const request = await call('permission_request', { roomId: room.id, action: 'artefact_review', scope: { content: 'Fixture' } }, agent);
  expect(request.ownerId).toBe(b.ownerId);
  await expect(call('permission_grant', { requestId: request.id })).rejects.toThrow();
  expect(await call('permission_grant', { requestId: request.id }, b)).toMatchObject({ ownerId: b.ownerId });
  await expect(call('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Foreign native' }, b)).rejects.toThrow();
  await expect(call('seat_add', { roomId: room.id, product: 'codex', ownerId: a.ownerId }, b)).rejects.toThrow(/identity/i);
});
it('keeps an observer human and their agent read-only', async () => {
  await joinParticipant('observer');
  expect(await call('room_get', { roomId: room.id }, b)).toMatchObject({ id: room.id });
  await expect(call('room_post', { roomId: room.id, text: 'Observer write' }, b)).rejects.toThrow();
  await expect(call('seat_add', { roomId: room.id, product: 'claude', name: 'Writer' }, b)).rejects.toThrow();
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', role: 'observer', name: 'Observer' }, b);
  await expect(call('room_post', { roomId: room.id, text: 'Agent write' }, { kind: 'agent', principalId: seat.principalId, ownerId: b.ownerId })).rejects.toThrow();
});
it('requires the target owner’s sender consent and bounds their turn budget', async () => {
  await joinParticipant();
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'B polling' }, b);
  const request = { roomId: room.id, seatId: seat.id, prompt: 'Public review' };
  await expect(call('turn_request', request)).rejects.toThrow();
  const consent = { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [a.ownerId], maxTurns: 1, maxTurnMs: 60000 };
  await expect(call('owner_consent_update', consent)).rejects.toThrow();
  await call('owner_consent_update', consent, b);
  expect(await call('turn_request', request)).toMatchObject({ seatId: seat.id, status: 'queued' });
  await expect(call('turn_request', request)).rejects.toThrow(/budget/i);
});
it('revokes membership generations, seats and pending work while preserving history', async () => {
  const member = await joinParticipant();
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'B agent' }, b);
  const agent: Actor = { kind: 'agent', principalId: seat.principalId, ownerId: b.ownerId };
  await call('owner_consent_update', { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [a.ownerId], maxTurns: 2, maxTurnMs: 60000 }, b);
  const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Pending review' });
  const request = await call('permission_request', { roomId: room.id, action: 'artefact_review', scope: { content: 'Fixture' } }, agent);
  await call('room_post', { roomId: room.id, text: 'Retained B history' }, agent);
  const revoked = await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  expect(revoked).toMatchObject({ status: 'revoked', generation: member.generation + 1 });
  expect(store.get('seat', seat.id)).toMatchObject({ status: 'left', consent: false });
  expect(store.get('turn', String(turn.id))).toMatchObject({ status: 'cancelled' });
  await expect(call('room_get', { roomId: room.id }, b)).rejects.toThrow();
  await expect(call('room_post', { roomId: room.id, text: 'Late reply' }, agent)).rejects.toThrow();
  await expect(call('permission_grant', { requestId: request.id }, b)).rejects.toThrow();
  expect(JSON.stringify(store.events(room.id))).toContain('Retained B history');
  const next = await joinParticipant(); expect(next.generation).toBeGreaterThan(member.generation);
  await expect(call('room_post', { roomId: room.id, text: 'Old seat after rejoin' }, agent)).rejects.toThrow();
});
it('audits human authority changes and keeps the room owner’s legacy IDs intact', async () => {
  const legacy = await call<Seat>('seat_add', { roomId: room.id, product: 'codex', name: 'Legacy', mode: 'managed' });
  const member = await joinParticipant();
  await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  expect(store.get('room', room.id)).toMatchObject({ ownerId: a.ownerId });
  expect(store.get('seat', legacy.id)).toMatchObject({ ownerId: a.ownerId, principalId: legacy.principalId });
  const audit = store.events(room.id).filter((e) => ['membership.invited', 'membership.confirmed', 'membership.revoked'].includes(e.type));
  expect(audit).toHaveLength(3);
  expect(audit.every((e) => e.actorId === a.principalId && typeof e.data.actionDigest === 'string' && e.data.policyVersion === 1)).toBe(true);
});
it('fences cached writes and permission grants after revocation', async () => {
  const member = await joinParticipant();
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'B agent' }, b);
  const agent: Actor = { kind: 'agent', principalId: seat.principalId, ownerId: b.ownerId };
  const args = { roomId: room.id, text: 'Before removal', clientKey: 'cached-post' };
  await call('room_post', args, agent);
  const request = await call('permission_request', { roomId: room.id, action: 'artefact_review', scope: { content: 'Fixture' } }, agent);
  await call('permission_grant', { requestId: request.id, clientKey: 'cached-grant' }, b);
  await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  await expect(call('room_post', args, agent)).rejects.toThrow();
  await expect(call('permission_grant', { requestId: request.id, clientKey: 'cached-grant' }, b)).rejects.toThrow();
});
it('expires pending confirmation and denies another participant’s room administration', async () => {
  let now = 1000000; vi.spyOn(Date, 'now').mockImplementation(() => now);
  const invitation = await invite();
  const pending = await call<HumanMembership>('membership_redeem', { roomId: room.id, code: invitation.code }, b);
  now += 600000;
  await expect(call('membership_confirm', { roomId: room.id, memberId: pending.id, expectedGeneration: pending.generation })).rejects.toThrow();
  await joinParticipant();
  await expect(call('room_pause', { roomId: room.id }, b)).rejects.toThrow();
  await expect(call('policy_update', { roomId: room.id, policy: { maxMessages: 5 } }, b)).rejects.toThrow();
});
it('fences a queued cross-owner turn after sender consent changes', async () => {
  await joinParticipant();
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'B agent' }, b);
  const consent = { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [a.ownerId], maxTurns: 2, maxTurnMs: 60000 };
  await call('owner_consent_update', consent, b);
  const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Queued' });
  await call('owner_consent_update', { ...consent, allowedSenderOwnerIds: [] }, b);
  await expect(call('turn_claim', { roomId: room.id, turnId: turn.id }, { kind: 'agent', principalId: seat.principalId, ownerId: b.ownerId })).rejects.toThrow();
});
it('bounds a claimed cross-owner turn by the target owner’s time limit', async () => {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  await joinParticipant();
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'B agent' }, b);
  const agent: Actor = { kind: 'agent', principalId: seat.principalId, ownerId: b.ownerId };
  await call('owner_consent_update', { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [a.ownerId], maxTurns: 2, maxTurnMs: 1000 }, b);
  const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Bounded' });
  await call('turn_claim', { roomId: room.id, turnId: turn.id }, agent); now += 1000;
  await expect(call('turn_complete', { roomId: room.id, turnId: turn.id, text: 'Late answer' }, agent)).rejects.toThrow();
  expect(JSON.stringify(store.events(room.id))).not.toContain('Late answer');
});
it('withdraws a removed sender’s queued work on another owner’s seat', async () => {
  const member = await joinParticipant();
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'A agent' });
  await call('owner_consent_update', { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [b.ownerId], maxTurns: 2, maxTurnMs: 60000 });
  const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'B proposed review' }, b);
  await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  expect(store.get('turn', String(turn.id))).toMatchObject({ status: 'cancelled' });
});
it('preserves a participant’s independent membership in a different room', async () => {
  const first = room, member = await joinParticipant();
  const firstSeat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'B first' }, b);
  room = await call<Room>('room_create', { title: 'Second room', objective: 'Independent membership' });
  await joinParticipant();
  const secondSeat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'B second' }, b);
  await call('membership_revoke', { roomId: first.id, memberId: member.id, expectedGeneration: member.generation });
  await expect(call('room_post', { roomId: first.id, text: 'Removed' }, { kind: 'agent', principalId: firstSeat.principalId, ownerId: b.ownerId })).rejects.toThrow();
  await call('room_post', { roomId: room.id, text: 'Still a member' }, { kind: 'agent', principalId: secondSeat.principalId, ownerId: b.ownerId });
  expect(await call('room_members', { roomId: room.id }, b)).toEqual(expect.arrayContaining([expect.objectContaining({ ownerId: b.ownerId, status: 'active' })]));
});
it('lets a participant withdraw their own turn without gaining another owner’s controls', async () => {
  await joinParticipant();
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'B agent' }, b);
  const other = await call<Seat>('seat_add', { roomId: room.id, product: 'codex', name: 'A agent' });
  const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Own turn' }, b);
  expect(await call('turn_cancel', { roomId: room.id, turnId: turn.id }, b)).toMatchObject({ status: 'cancelled' });
  const foreign = await call('turn_request', { roomId: room.id, seatId: other.id, prompt: 'A turn' });
  await expect(call('turn_cancel', { roomId: room.id, turnId: foreign.id }, b)).rejects.toThrow();
});
