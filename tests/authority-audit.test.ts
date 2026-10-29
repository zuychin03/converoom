import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, humanIdentity } from '../apps/daemon/src/server.js';
import { createStore, scopeDigest } from '../packages/store/src/index.js';
import { createCore, exhaustBudgets } from '../packages/core/src/index.js';
import type { Actor, Core, HumanMembership, Room, Seat, Store, ToolArgs, Turn } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner-principal', ownerId: 'owner' };
const guest: Actor = { kind: 'human', principalId: 'guest-principal', ownerId: 'guest' };
let store: Store, core: Core, room: Room;
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
beforeEach(async () => {
  store = createStore(':memory:');
  core = createCore(store);
  room = await call<Room>('room_create', { title: 'Audit', objective: 'Record authority' });
});
afterEach(() => store.close());

// NFR-09 fields beyond the actor, digest and policy that every event carries: the scope and expiry each change binds.
const AUTHORITY: Record<string, string[]> = {
  'seat.joined': ['id', 'role', 'mode'],
  'seat.consent': ['seatId', 'consent'],
  'seat.profile': ['seatId', 'profile', 'previous'],
  'policy.changed': ['version', 'previousVersion', 'policy'],
  'permission.requested': ['id', 'action', 'scope', 'scopeDigest', 'expiresAt'],
  'permission.granted': ['requestId', 'action', 'scope', 'scopeDigest', 'expiresAt'],
  'permission.denied': ['requestId', 'action', 'scopeDigest', 'expiresAt'],
  'permission.cancelled': ['requestId', 'action', 'scopeDigest'],
  'host.transferred': ['requestId', 'seatId', 'previousSeatId', 'scopeDigest'],
  'membership.invited': ['invitationId', 'role', 'expiresAt'],
  'membership.pending': ['memberId', 'generation', 'expiresAt'],
  'membership.confirmed': ['memberId', 'generation', 'role'],
  'membership.revoked': ['memberId', 'generation'],
  'owner.consent_changed': ['seatId', 'allowedSenderOwnerIds', 'maxTurns', 'maxTurnMs'],
};

it('records the human actor, an action digest, scope, expiry and policy for every authority change', async () => {
  const worker = await call<Seat>('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Worker' });
  const reviewer = await call<Seat>('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Reviewer' });
  await call<Seat>('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Lead', role: 'host' });
  for (const seat of [worker, reviewer]) await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
  await call('seat_profile_set', { roomId: room.id, seatId: worker.id, profile: { effort: 'high' } });
  await call('policy_update', { roomId: room.id, policy: { maxMessages: 30 } });
  const granted = await call<Turn>('turn_request', { roomId: room.id, seatId: worker.id, prompt: 'Review' });
  await call('permission_grant', { requestId: granted.permissionRequestId });
  const denied = await call<Turn>('turn_request', { roomId: room.id, seatId: reviewer.id, prompt: 'Challenge' });
  await call('permission_deny', { requestId: denied.permissionRequestId });
  const transfer = await call<ToolArgs>('host_transfer_request', { roomId: room.id, seatId: worker.id });
  await call('host_transfer_confirm', { requestId: transfer.id });
  const invitation = await call<{ code: string }>('membership_invite', { roomId: room.id, displayName: 'Guest', role: 'participant', clientKey: 'invite' });
  const member = await call<HumanMembership>('membership_redeem', { roomId: room.id, code: invitation.code }, guest);
  await call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  const guestSeat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', name: 'Guest agent' }, guest);
  await call('owner_consent_update', { roomId: room.id, seatId: guestSeat.id, allowedSenderOwnerIds: [owner.ownerId], maxTurns: 2, maxTurnMs: 60000 }, guest);
  store.put('permission', 'guest-request', { id: 'guest-request', roomId: room.id, ownerId: guest.ownerId, action: 'vendor_tool',
    scope: { tool: 'read' }, scopeDigest: scopeDigest({ tool: 'read' }), summary: 'Guest tool', status: 'pending', expiresAt: Date.now() + 60000 });
  await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  const events = store.events(room.id, 0, 1000);
  for (const [type, fields] of Object.entries(AUTHORITY)) {
    const recorded = events.filter((e) => e.type === type);
    expect(recorded.length, type).toBeGreaterThan(0);
    for (const e of recorded) {
      const { actionDigest, policyVersion, ...content } = e.data as ToolArgs;
      expect(actionDigest, type).toBe(scopeDigest(content));
      expect(policyVersion, type).toEqual(expect.any(Number));
      for (const field of fields) expect(content, type + ' ' + field).toHaveProperty(field);
      expect([owner.principalId, guest.principalId], type).toContain(e.actorId);
    }
  }
});

it.each<[string, (turn: Turn, lead: Actor) => unknown, (lead: Actor) => string]>([
  ['its turn is cancelled', (turn) => call('turn_cancel', { roomId: room.id, turnId: turn.id }), () => owner.principalId],
  ['the room closes', () => call('room_close', { roomId: room.id }), () => owner.principalId],
  ['the agent host stops the round robin it proposed', async (turn, lead) => {
    await call('round_robin_propose', { roomId: room.id, seatIds: [turn.seatId], rounds: 1, prompt: 'Debate' }, lead);
    await call('round_robin_stop', { roomId: room.id }, lead);
  }, (lead) => lead.principalId],
  ['a room budget is used up', () => exhaustBudgets(store, room.id, Date.now() + 86400000), () => 'runtime'],
])('records who withdrew a pending approval, and what it covered, when %s', async (_, stop, actor) => {
  const worker = await call<Seat>('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Worker' });
  const host = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', mode: 'polling', name: 'Lead', role: 'host' });
  await call('seat_consent', { roomId: room.id, seatId: worker.id, consent: true });
  const lead: Actor = { kind: 'agent', principalId: host.principalId, ownerId: owner.ownerId };
  await stop(await call<Turn>('turn_request', { roomId: room.id, seatId: worker.id, prompt: 'Review' }), lead);
  const withdrawn = store.events(room.id, 0, 1000).filter((e) => e.type === 'permission.cancelled');
  expect(withdrawn).toHaveLength(1);
  const { actionDigest, policyVersion, ...content } = withdrawn[0].data as ToolArgs;
  expect(store.get('permission', String(content.requestId))).toMatchObject({ status: 'cancelled', action: content.action, scopeDigest: content.scopeDigest });
  expect(content).toEqual({ requestId: expect.any(String), action: expect.any(String), scopeDigest: expect.any(String) });
  expect(actionDigest).toBe(scopeDigest(content));
  expect(policyVersion).toEqual(expect.any(Number));
  expect(withdrawn[0].actorId).toBe(actor(lead));
});

it('refuses every authority change from an agent, so agent tools cannot add to or rewrite the audit trail', async () => {
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Worker' });
  await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
  const agent: Actor = { kind: 'agent', principalId: seat.principalId, ownerId: owner.ownerId };
  const turn = await call<Turn>('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Review' });
  const transfer = await call<ToolArgs>('host_transfer_request', { roomId: room.id, seatId: seat.id });
  const invitation = await call<{ id: string }>('membership_invite', { roomId: room.id, displayName: 'Guest', role: 'participant', clientKey: 'invite' });
  const before = store.events(room.id, 0, 1000).length;
  const attempts: [string, ToolArgs][] = [
    ['seat_consent', { roomId: room.id, seatId: seat.id, consent: false }],
    ['policy_update', { roomId: room.id, policy: { maxMessages: 5 } }],
    ['permission_grant', { requestId: turn.permissionRequestId }],
    ['permission_deny', { requestId: turn.permissionRequestId }],
    ['host_transfer_confirm', { requestId: transfer.id }],
    ['membership_invite', { roomId: room.id, displayName: 'Other', role: 'participant', clientKey: 'agent-invite' }],
    ['invitation_revoke', { roomId: room.id, invitationId: invitation.id }],
    ['owner_consent_update', { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [], maxTurns: 1, maxTurnMs: 1000 }],
  ];
  for (const [name, args] of attempts) await expect(call(name, args, agent), name).rejects.toThrow();
  expect(store.events(room.id, 0, 1000)).toHaveLength(before);
});

it('keeps an append-only audit record when a local bridge credential is issued or revoked', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-audit-'));
  const runtime = await createRuntime(dir, { noScheduler: true });
  const server = await createServer(runtime, { port: 0, controlToken: 'audit-fixture' });
  try {
    const post = async (path: string, body: unknown) => (await fetch(server.url + path, { method: 'POST', body: JSON.stringify(body),
      headers: { authorization: 'Bearer audit-fixture', 'content-type': 'application/json' } })).json() as Promise<{ principalId: string; token: string }>;
    const credential = await post('/local/credentials', { product: 'codex' });
    await post('/local/revoke', { principalId: credential.principalId });
    await post('/local/revoke', { principalId: 'never-issued' });
    const records = runtime.core.store.list<{ type: string; actorId: string; at: number; data: ToolArgs }>('authority_audit')
      .filter((r) => r.type.startsWith('bridge.'));
    expect(records.map((r) => r.type).sort()).toEqual(['bridge.credential_issued', 'bridge.credential_revoked']);
    for (const r of records) {
      expect(r.actorId).toBe(humanIdentity(runtime).principalId);
      const { actionDigest, ...content } = r.data;
      expect(actionDigest).toBe(scopeDigest(content));
      expect(content).toMatchObject({ principalId: credential.principalId });
    }
    expect(JSON.stringify(records)).not.toContain(credential.token);
  } finally { await server.close(); await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
}, 30000);

it('keeps an append-only audit record when a pairing code is issued or opens a human session', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-audit-'));
  const runtime = await createRuntime(dir, { noScheduler: true });
  let rotated = '';
  const server = await createServer(runtime, { port: 0, pairingCode: 'audit-start-code', controlToken: 'audit-fixture',
    onPairingCode: (code) => { rotated = code; } });
  try {
    const pair = (code: string) => fetch(server.url + '/api/pair', { method: 'POST', body: JSON.stringify({ code }),
      headers: { origin: server.url, 'content-type': 'application/json' } });
    expect((await pair('wrong-code')).status).toBe(401);
    const session = (await pair('audit-start-code')).headers.get('set-cookie')!.split(';')[0].slice('converoom_session='.length);
    await fetch(server.url + '/local/pair', { method: 'POST', body: '{}', headers: { authorization: 'Bearer audit-fixture', 'content-type': 'application/json' } });
    expect((await pair('audit-start-code')).status).toBe(401);
    expect(rotated).toHaveLength(12);
    const records = runtime.core.store.list<{ type: string; actorId: string; at: number; data: ToolArgs }>('authority_audit');
    expect(records.map((r) => r.type).sort()).toEqual(['pairing.code_issued', 'pairing.code_issued', 'pairing.session_issued']);
    expect(records.filter((r) => r.type === 'pairing.code_issued').map((r) => r.data.reason).sort()).toEqual(['rotation', 'startup']);
    for (const r of records) {
      expect(r.actorId).toBe(humanIdentity(runtime).principalId);
      const { actionDigest, ...content } = r.data;
      expect(actionDigest).toBe(scopeDigest(content));
      expect(content.expiresAt).toBeGreaterThan(r.at);
    }
    for (const secret of ['audit-start-code', rotated, session]) expect(JSON.stringify(records)).not.toContain(secret);
  } finally { await server.close(); await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
}, 30000);
