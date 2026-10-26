import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import type { Actor, Core, Event, Room, Seat, Store, ToolArgs, Turn } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let store: Store, core: Core;
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
const agentOf = (s: Seat): Actor => ({ kind: 'agent', principalId: s.principalId, ownerId: s.ownerId });
const room = (id: string) => store.get<Room>('room', id)!;
const changes = (roomId: string, type: 'room.lifecycle' | 'room.phase') =>
  store.events(roomId, 0, 1000).filter((e: Event) => e.type === type).map((e) => e.data);
beforeEach(() => { store = createStore(':memory:'); core = createCore(store); });
afterEach(() => { vi.restoreAllMocks(); store.close(); });

async function setup(args: ToolArgs = {}) {
  const r = await call<Room>('room_create', { title: 'States', objective: 'Pick a storage engine', ...args });
  const host = await call<Seat>('seat_add', { roomId: r.id, name: 'Host', product: 'claude', mode: 'polling', role: 'host' });
  const worker = await call<Seat>('seat_add', { roomId: r.id, name: 'Worker', product: 'claude', mode: 'polling' });
  return { r, host: agentOf(host), worker, workerAgent: agentOf(worker) };
}

it('starts rooms active in deliberation, and a draft only after it is started', async () => {
  const { r } = await setup();
  expect(room(r.id)).toMatchObject({ lifecycle: 'active', phase: 'deliberation' });
  expect(room(r.id)).not.toHaveProperty('status');
  let now = 1_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const draft = await setup({ draft: true });
  expect(room(draft.r.id)).toMatchObject({ lifecycle: 'draft', phase: 'deliberation' });
  await expect(call('room_post', { roomId: draft.r.id, text: 'Too early' })).rejects.toThrow(/draft/i);
  await expect(call('turn_request', { roomId: draft.r.id, seatId: draft.worker.id, prompt: 'Too early' })).rejects.toThrow(/draft/i);
  await call('policy_update', { roomId: draft.r.id, policy: { maxDurationMs: 60000 } });
  now += 120000;
  await expect(call('room_start', { roomId: draft.r.id }, draft.workerAgent)).rejects.toThrow(/host/i);
  await call('room_start', { roomId: draft.r.id });
  expect(room(draft.r.id)).toMatchObject({ lifecycle: 'active', startedAt: now });
  await call('room_post', { roomId: draft.r.id, text: 'The time budget runs from the start' });
  now += 61000;
  await expect(call('room_post', { roomId: draft.r.id, text: 'Out of time' })).rejects.toThrow(/time budget/i);
  expect(changes(draft.r.id, 'room.lifecycle')).toEqual([expect.objectContaining({ lifecycle: 'active', previous: 'draft' })]);
  await expect(call('room_start', { roomId: draft.r.id })).rejects.toThrow(/active/i);
});

it('reports pausing until active turns drain, then paused', async () => {
  const { r, host, worker, workerAgent } = await setup();
  await call('room_pause', { roomId: r.id }, host);
  expect(room(r.id).lifecycle).toBe('paused');
  await expect(call('room_pause', { roomId: r.id })).rejects.toThrow(/paused/i);
  await call('room_resume', { roomId: r.id });
  const turn = await call<Turn>('turn_request', { roomId: r.id, seatId: worker.id, prompt: 'Compare engines' }, host);
  await call('turn_claim', { roomId: r.id, turnId: turn.id }, workerAgent);
  await call('room_pause', { roomId: r.id });
  expect(room(r.id).lifecycle).toBe('pausing');
  expect(store.get<Turn>('turn', turn.id)?.status).toBe('cancelling');
  await expect(call('room_post', { roomId: r.id, text: 'Still pausing' })).rejects.toThrow(/pausing/i);
  await call('turn_complete', { roomId: r.id, turnId: turn.id, outcome: 'cancelled' }, workerAgent);
  expect(room(r.id).lifecycle).toBe('paused');
  expect(changes(r.id, 'room.lifecycle').map((d) => [d.previous, d.lifecycle])).toEqual([
    ['active', 'paused'], ['paused', 'active'], ['active', 'pausing'], ['pausing', 'paused']]);
  expect(store.events(r.id, 0, 1000).find((e) => e.data.lifecycle === 'paused' && e.data.previous === 'pausing')?.actorId).toBe('runtime');
  await call('room_resume', { roomId: r.id });
  expect(room(r.id).lifecycle).toBe('active');
});

it('settles a pausing room on restart once interrupted turns become uncertain', async () => {
  const { r, host, worker, workerAgent } = await setup();
  const turn = await call<Turn>('turn_request', { roomId: r.id, seatId: worker.id, prompt: 'Compare engines' }, host);
  await call('turn_claim', { roomId: r.id, turnId: turn.id }, workerAgent);
  await call('room_pause', { roomId: r.id });
  expect(room(r.id).lifecycle).toBe('pausing');
  core = createCore(store);
  expect(store.get<Turn>('turn', turn.id)?.status).toBe('uncertain');
  expect(room(r.id).lifecycle).toBe('paused');
});

it('completes or cancels a room, and only a cancellation carries a handoff', async () => {
  const done = await setup();
  const queued = await call<Turn>('turn_request', { roomId: done.r.id, seatId: done.worker.id, prompt: 'Later' }, done.host);
  await call('room_close', { roomId: done.r.id });
  expect(room(done.r.id).lifecycle).toBe('completed');
  expect(store.get<Turn>('turn', queued.id)?.status).toBe('cancelled');
  expect(changes(done.r.id, 'room.lifecycle')).toEqual([expect.not.objectContaining({ handoff: expect.anything() })]);
  await expect(call('room_close', { roomId: done.r.id })).rejects.toThrow(/completed/i);
  await expect(call('room_resume', { roomId: done.r.id })).rejects.toThrow(/completed/i);

  const stopped = await setup();
  await call('room_set_agenda', { roomId: stopped.r.id, agenda: 'Pick one' }, stopped.host);
  const managed = await call<Seat>('seat_add', { roomId: stopped.r.id, name: 'Managed', product: 'codex', mode: 'managed' });
  await call('seat_consent', { roomId: stopped.r.id, seatId: managed.id, consent: true });
  const pending = await call<Turn>('turn_request', { roomId: stopped.r.id, seatId: managed.id, prompt: 'Compare' });
  await expect(call('room_close', { roomId: stopped.r.id, outcome: 'abandoned' })).rejects.toThrow(/outcome/i);
  await call('room_close', { roomId: stopped.r.id, outcome: 'cancelled', reason: 'Requirements changed' }, stopped.host);
  expect(room(stopped.r.id).lifecycle).toBe('cancelled');
  expect(store.get<ToolArgs>('permission', String(pending.permissionRequestId))?.status).toBe('cancelled');
  const [event] = changes(stopped.r.id, 'room.lifecycle');
  expect(event).toMatchObject({ lifecycle: 'cancelled', previous: 'active', reason: 'Requirements changed', actionDigest: expect.any(String),
    handoff: { agendaSeq: expect.any(Number), decisionSeq: null, stoppedTurnIds: [pending.id] } });
});

it('archives only a completed room, on the owner’s word', async () => {
  const done = await setup();
  await expect(call('room_archive', { roomId: done.r.id })).rejects.toThrow(/active/i);
  await call('room_close', { roomId: done.r.id }, done.host);
  await expect(call('room_archive', { roomId: done.r.id }, done.host)).rejects.toThrow(/human/i);
  await call('room_archive', { roomId: done.r.id });
  expect(room(done.r.id).lifecycle).toBe('archived');
  await expect(call('room_post', { roomId: done.r.id, text: 'Late' })).rejects.toThrow(/archived/i);
  const stopped = await setup();
  await call('room_close', { roomId: stopped.r.id, outcome: 'cancelled' });
  await expect(call('room_archive', { roomId: stopped.r.id })).rejects.toThrow(/cancelled/i);
});

it('moves through phases, and only the owner approves or returns a decision', async () => {
  const { r, host } = await setup();
  await expect(call('room_set_phase', { roomId: r.id, phase: 'verification' }, host)).rejects.toThrow(/deliberation/i);
  await expect(call('room_set_phase', { roomId: r.id, phase: 'decision_proposed' }, host)).rejects.toThrow(/room_propose_decision/);
  await call('room_propose_decision', { roomId: r.id, decision: 'Use SQLite', dissent: [], evidence: [] }, host);
  expect(room(r.id).phase).toBe('decision_proposed');
  await call('room_set_phase', { roomId: r.id, phase: 'owner_review' }, host);
  await expect(call('room_set_phase', { roomId: r.id, phase: 'execution' }, host)).rejects.toThrow(/human/i);
  await expect(call('room_set_phase', { roomId: r.id, phase: 'deliberation' }, host)).rejects.toThrow(/human/i);
  await call('room_set_phase', { roomId: r.id, phase: 'deliberation', reason: 'Compare cost first' });
  await call('room_propose_decision', { roomId: r.id, decision: 'Use SQLite, costs compared', dissent: [], evidence: [] }, host);
  await call('room_set_phase', { roomId: r.id, phase: 'owner_review' });
  await call('room_pause', { roomId: r.id });
  await call('room_set_phase', { roomId: r.id, phase: 'execution' });
  await call('room_resume', { roomId: r.id });
  await call('room_set_phase', { roomId: r.id, phase: 'verification' }, host);
  await call('room_set_phase', { roomId: r.id, phase: 'execution', reason: 'A check failed' }, host);
  await call('room_set_phase', { roomId: r.id, phase: 'verification' }, host);
  await call('room_set_phase', { roomId: r.id, phase: 'handoff' }, host);
  expect(changes(r.id, 'room.phase').map((d) => d.phase)).toEqual(['decision_proposed', 'owner_review', 'deliberation',
    'decision_proposed', 'owner_review', 'execution', 'verification', 'execution', 'verification', 'handoff']);
  expect(changes(r.id, 'room.phase')[2]).toMatchObject({ previous: 'owner_review', reason: 'Compare cost first', actionDigest: expect.any(String) });
  await expect(call('room_set_phase', { roomId: r.id, phase: 'verification' })).rejects.toThrow(/handoff/i);
  await call('room_close', { roomId: r.id });
  await expect(call('room_set_phase', { roomId: r.id, phase: 'handoff' })).rejects.toThrow(/completed/i);
  const draft = await setup({ draft: true });
  await expect(call('room_set_phase', { roomId: draft.r.id, phase: 'owner_review' })).rejects.toThrow(/draft/i);
});

it('skips owner review for nothing to execute and keeps a revised decision under review', async () => {
  const { r, host } = await setup();
  await call('room_propose_decision', { roomId: r.id, decision: 'Use SQLite', dissent: [], evidence: [] }, host);
  await call('room_set_phase', { roomId: r.id, phase: 'owner_review' }, host);
  await call('room_propose_decision', { roomId: r.id, decision: 'Use SQLite with WAL', dissent: [], evidence: [] }, host);
  expect(room(r.id).phase).toBe('decision_proposed');
  await call('room_set_phase', { roomId: r.id, phase: 'owner_review' });
  await call('room_set_phase', { roomId: r.id, phase: 'handoff' });
  expect(room(r.id).phase).toBe('handoff');
  await call('room_propose_decision', { roomId: r.id, decision: 'Recorded after the handoff', dissent: [], evidence: [] }, host);
  expect(room(r.id).phase).toBe('handoff');
});
