import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, scopeDigest } from '../packages/store/src/index.js';
import { createCore, turnExecutionScope, type Permission } from '../packages/core/src/index.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { resolveEffort } from '../packages/adapters/src/profile.js';
import { ConveroomError, type Actor, type Core, type Room, type Seat, type SeatProfile, type Store, type ToolArgs, type Turn } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let store: Store, core: Core, room: Room;
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
const agentOf = (s: Seat): Actor => ({ kind: 'agent', principalId: s.principalId, ownerId: s.ownerId });
beforeEach(async () => {
  store = createStore(':memory:');
  core = createCore(store);
  room = await call<Room>('room_create', { title: 'Profiles', objective: 'Pick the model and effort per seat' });
});
afterEach(() => store.close());

it('keeps an owner-chosen model and effort on a managed seat and refuses one on a polling seat', async () => {
  const worker = await call<Seat>('seat_add', { roomId: room.id, name: 'Worker', product: 'codex', mode: 'managed',
    profile: { model: 'gpt-5.5-codex', effort: 'high' } });
  expect(worker.profile).toEqual({ model: 'gpt-5.5-codex', effort: 'high' });
  const plain = await call<Seat>('seat_add', { roomId: room.id, name: 'Plain', product: 'cursor', mode: 'managed', profile: {} });
  expect(plain.profile).toBeUndefined();
  await expect(call('seat_add', { roomId: room.id, name: 'Reader', product: 'claude', mode: 'polling', profile: { effort: 'high' } }))
    .rejects.toMatchObject({ code: 'profile_unsupported' });
  for (const profile of [{ effort: 'extreme' }, { model: '' }, { model: 'a\nb' }, { model: 'x'.repeat(129) }, { speed: 'fast' }, 'high'])
    await expect(call('seat_add', { roomId: room.id, name: 'Bad', product: 'codex', mode: 'managed', profile })).rejects.toMatchObject({ code: 'invalid_argument' });
});

it('lets only the seat owner change or clear a profile, and records the change as an authority event', async () => {
  const worker = await call<Seat>('seat_add', { roomId: room.id, name: 'Worker', product: 'codex', mode: 'managed' });
  const updated = await call<Seat>('seat_profile_set', { roomId: room.id, seatId: worker.id, profile: { effort: 'max' } });
  expect(updated.profile).toEqual({ effort: 'max' });
  await expect(call('seat_profile_set', { roomId: room.id, seatId: worker.id, profile: { effort: 'low' } }, agentOf(worker)))
    .rejects.toMatchObject({ code: 'human_required' });
  const cleared = await call<Seat>('seat_profile_set', { roomId: room.id, seatId: worker.id, profile: {} });
  expect(cleared.profile).toBeUndefined();
  const changes = store.events(room.id, 0, 100).filter((e) => e.type === 'seat.profile');
  expect(changes.map((e) => e.data)).toEqual([
    expect.objectContaining({ seatId: worker.id, profile: { effort: 'max' }, previous: null, actionDigest: expect.any(String), policyVersion: 1 }),
    expect.objectContaining({ seatId: worker.id, profile: null, previous: { effort: 'max' } }),
  ]);
  const reader = await call<Seat>('seat_add', { roomId: room.id, name: 'Reader', product: 'claude', mode: 'polling' });
  await expect(call('seat_profile_set', { roomId: room.id, seatId: reader.id, profile: { effort: 'high' } }))
    .rejects.toMatchObject({ code: 'profile_unsupported' });
});

it('freezes the profile into each turn request, so the owner approves the exact model and effort', async () => {
  const worker = await call<Seat>('seat_add', { roomId: room.id, name: 'Worker', product: 'codex', mode: 'managed', profile: { effort: 'high' } });
  await call('seat_consent', { roomId: room.id, seatId: worker.id, consent: true });
  const turn = await call<Turn>('turn_request', { roomId: room.id, seatId: worker.id, prompt: 'Review the plan' });
  expect(turn.profile).toEqual({ effort: 'high' });
  const request = store.get<Permission>('permission', turn.permissionRequestId!)!;
  expect(request.scope.profile).toEqual({ effort: 'high' });
  await call('seat_profile_set', { roomId: room.id, seatId: worker.id, profile: { effort: 'low' } });
  const queued = store.get<Turn>('turn', turn.id)!;
  expect(queued.profile).toEqual({ effort: 'high' });
  expect(scopeDigest(turnExecutionScope(queued, store))).toBe(request.scopeDigest);
  const next = await call<Turn>('turn_request', { roomId: room.id, seatId: worker.id, prompt: 'Again' });
  expect(next.profile).toEqual({ effort: 'low' });
  const unprofiled = await call<Seat>('seat_add', { roomId: room.id, name: 'Default', product: 'cursor', mode: 'managed' });
  await call('seat_consent', { roomId: room.id, seatId: unprofiled.id, consent: true });
  const plain = await call<Turn>('turn_request', { roomId: room.id, seatId: unprofiled.id, prompt: 'Plain' });
  expect('profile' in store.get<Permission>('permission', plain.permissionRequestId!)!.scope).toBe(false);
});

it.each([
  ['low', ['minimal', 'medium', 'high', 'xhigh'], undefined],
  ['high', ['low', 'medium', 'high', 'xhigh'], 'high'],
  ['medium', ['Low', 'Medium', 'High'], 'Medium'],
  ['max', ['low', 'medium', 'high', 'xhigh'], 'xhigh'],
  ['max', ['xhigh', 'low', 'max'], 'max'],
  ['max', ['high', 'low'], 'high'],
  ['max', ['quick', 'thorough'], undefined],
] as const)('resolves %s effort against %j', (level, offered, expected) => {
  expect(resolveEffort(level, offered.map((value) => ({ value })))).toBe(expected);
});

async function managedRuntime(startSession: (profile?: SeatProfile) => Promise<unknown>) {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-profile-'));
  const runtime = await createRuntime(dir, { tickMs: 10, startSession: (async (...args: unknown[]) => startSession(args[6] as SeatProfile | undefined)) as never });
  const dispatch = <T = ToolArgs>(name: string, args: ToolArgs) => runtime.core.dispatch(owner, name, args) as Promise<T>;
  const r = await dispatch<Room>('room_create', { title: 'Runtime profiles', objective: 'Launch with the frozen profile' });
  const seat = await dispatch<Seat>('seat_add', { roomId: r.id, name: 'Worker', product: 'codex', mode: 'managed', profile: { model: 'gpt-fixture', effort: 'max' } });
  await dispatch('seat_consent', { roomId: r.id, seatId: seat.id, consent: true });
  const turn = await dispatch<Turn>('turn_request', { roomId: r.id, seatId: seat.id, prompt: 'Answer' });
  await dispatch('permission_grant', { requestId: turn.permissionRequestId });
  const current = () => runtime.core.store.get<Turn & ToolArgs>('turn', turn.id)!;
  return { runtime, r, seat, current, close: async () => { await runtime.stop(); await rm(dir, { recursive: true, force: true }); } };
}

it('launches with the frozen profile and records the values the vendor applied', async () => {
  let received: SeatProfile | undefined;
  const fixture = await managedRuntime(async (profile) => {
    received = profile;
    return { id: 'profile-session', product: 'codex', capabilities: ['prompt', 'cancel'], profile: { model: 'gpt-fixture', effort: 'xhigh' },
      prompt: async () => 'Answer with the chosen profile', cancel: async () => {}, close: async () => true };
  });
  try {
    await expect.poll(() => fixture.current().status).toBe('completed');
    expect(received).toEqual({ model: 'gpt-fixture', effort: 'max' });
    expect(fixture.current().applied).toEqual({ model: 'gpt-fixture', effort: 'xhigh' });
    const started = fixture.runtime.core.store.events(fixture.r.id, 0, 200).find((e) => e.type === 'turn.started');
    expect(started?.data).toMatchObject({ profile: { model: 'gpt-fixture', effort: 'max' }, applied: { model: 'gpt-fixture', effort: 'xhigh' } });
  } finally { await fixture.close(); }
});

it('records a profile the agent does not offer as a failed turn, not an uncertain one, once the adapter stopped its process', async () => {
  const fixture = await managedRuntime(async () => {
    throw Object.assign(new ConveroomError('profile_unsupported', 'gpt-fixture does not offer max effort. It offers: low, medium', 409),
      { notStarted: true, stopped: true });
  });
  try {
    await expect.poll(() => fixture.current().status).toBe('failed');
    expect(fixture.current()).toMatchObject({ failure: 'profile_unsupported', repair: expect.stringMatching(/model and effort/i) });
    expect(fixture.current().sessionStoppedAt).toBeUndefined();
    await expect.poll(() => fixture.runtime.core.store.get<Seat>('seat', fixture.seat.id)?.status).toBe('idle');
  } finally { await fixture.close(); }
});
