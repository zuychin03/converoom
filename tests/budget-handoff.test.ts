import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import { createRuntime, type RuntimeOptions } from '../apps/daemon/src/runtime.js';
import { exportTranscript, type RoomExport } from '../packages/core/src/transcript.js';
import type { Actor, Core, Room, Runtime, Seat, Store, ToolArgs, Turn } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let store: Store, core: Core;
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
const agentOf = (s: Seat): Actor => ({ kind: 'agent', principalId: s.principalId, ownerId: s.ownerId });
const handoffs = (roomId: string) => store.events(roomId, 0, 1000).filter((e) => e.type === 'room.budget_exhausted');
const seq = (roomId: string, type: string) => store.events(roomId, 0, 1000).find((e) => e.type === type)!.seq;
beforeEach(() => { store = createStore(':memory:'); core = createCore(store); });
afterEach(() => { vi.restoreAllMocks(); store.close(); });

async function room(maxMessages: number) {
  const r = await call<Room>('room_create', { title: 'Budget', objective: 'Bounded debate' });
  await call('policy_update', { roomId: r.id, policy: { maxMessages } });
  return r;
}
const seat = (roomId: string, mode: 'managed' | 'polling', name: string) =>
  call<Seat>('seat_add', { roomId, product: mode === 'managed' ? 'codex' : 'claude', mode, name });

async function frozenRoom() {
  const r = await room(3);
  const worker = await seat(r.id, 'managed', 'Worker'), reviewer = await seat(r.id, 'polling', 'Reviewer');
  await call('seat_consent', { roomId: r.id, seatId: worker.id, consent: true });
  await call('room_set_agenda', { roomId: r.id, agenda: 'Pick a storage engine' });
  await call('room_post', { roomId: r.id, text: 'Which engine?', mentions: [{ seatId: reviewer.id, intent: 'question' }] });
  const managed = await call<Turn>('turn_request', { roomId: r.id, seatId: worker.id, prompt: 'Compare engines' });
  const polling = await call<Turn>('turn_request', { roomId: r.id, seatId: reviewer.id, prompt: 'Review the comparison' });
  await call('room_propose_decision', { roomId: r.id, decision: 'Use SQLite', dissent: ['Reviewer prefers files'], evidence: [] });
  await call('room_post', { roomId: r.id, text: 'Second' });
  expect(handoffs(r.id)).toHaveLength(0);
  await call('room_post', { roomId: r.id, text: 'Third, the last allowed' });
  return { r, worker, reviewer, managed, polling };
}

it('freezes dispatch when the message budget is used up and records one handoff', async () => {
  const { r, reviewer, managed, polling } = await frozenRoom();
  expect(store.get<Room>('room', r.id)?.exhaustedBudgets).toEqual(['message']);
  expect(handoffs(r.id)).toHaveLength(1);
  const [event] = handoffs(r.id);
  expect(event.actorId).toBe('runtime');
  expect(event.data).toMatchObject({
    budgets: ['message'], usage: { messages: 3, turns: 2 }, limits: { maxMessages: 3 }, policyVersion: 2, actionDigest: expect.any(String),
    handoff: {
      agendaSeq: seq(r.id, 'agenda'), decisionSeq: seq(r.id, 'decision'), stoppedTurnIds: [managed.id, polling.id],
      unresolved: [expect.objectContaining({ recipientId: reviewer.id, intent: 'question', status: 'stored' })],
    },
  });
  for (const t of [managed, polling])
    expect(store.get<Turn>('turn', t.id)).toMatchObject({ status: 'cancelled', error: expect.stringMatching(/message budget/i) });
  expect(store.get<ToolArgs>('permission', String(managed.permissionRequestId))).toMatchObject({ status: 'cancelled' });
  expect(store.list('grant')).toHaveLength(0);
  const types = store.events(r.id, 0, 1000).map((e) => e.type);
  expect(types.filter((t) => t === 'turn.cancelled')).toHaveLength(2);
  expect(types.at(-1)).toBe('room.budget_exhausted');

  await expect(call('room_post', { roomId: r.id, text: 'Fourth' })).rejects.toMatchObject({ code: 'budget_exhausted' });
  await expect(call('room_post', { roomId: r.id, text: 'Agent', clientKey: 'k' }, agentOf(reviewer))).rejects.toMatchObject({ code: 'budget_exhausted' });
  await expect(call('turn_request', { roomId: r.id, seatId: reviewer.id, prompt: 'Again' })).rejects.toMatchObject({ code: 'budget_exhausted' });
  await expect(call('turn_claim', { roomId: r.id, turnId: polling.id }, agentOf(reviewer))).rejects.toThrow(/not queued/i);
  expect(handoffs(r.id)).toHaveLength(1);
});

it('ends an adversarial mention loop within its hop and message counters', async () => {
  const r = await room(10);
  let speaker = await seat(r.id, 'polling', 'A'), other = await seat(r.id, 'polling', 'B');
  let replyTo: unknown, refusal: unknown, attempts = 0;
  while (!refusal && attempts++ < 100) {
    const args = { roomId: r.id, text: 'Round ' + attempts, ...(replyTo ? { replyToId: replyTo } : {}) };
    try {
      await call('room_post', { ...args, mentions: [{ seatId: other.id, intent: 'challenge' }] }, agentOf(speaker));
    } catch (e) {
      if ((e as { code?: string }).code !== 'hops') refusal = e;
      else await call('room_post', args, agentOf(speaker)).catch((e2: unknown) => { refusal = e2; });
    }
    [speaker, other] = [other, speaker];
    replyTo = store.list<ToolArgs>('interaction', { roomId: r.id }).filter((i) => i.recipientId === speaker.id).at(-1)?.id;
  }
  expect(refusal).toMatchObject({ code: 'budget_exhausted' });
  expect(attempts).toBe(11);
  expect(store.eventCount(r.id, 'message')).toBe(10);
  expect(Math.max(...store.list<ToolArgs>('interaction', { roomId: r.id }).map((i) => Number(i.hop)))).toBe(4);
  expect(handoffs(r.id)).toHaveLength(1);
  expect(store.list('permission')).toHaveLength(0);
});

it('refuses retried and broadcast turn requests past the turn budget but runs the turns it accepted', async () => {
  const r = await room(3);
  const seats = [await seat(r.id, 'polling', 'One'), await seat(r.id, 'polling', 'Two'), await seat(r.id, 'polling', 'Three')];
  const first = await call<Turn>('turn_request', { roomId: r.id, seatId: seats[0].id, prompt: 'Answer', clientKey: 'retry' });
  expect(await call<Turn>('turn_request', { roomId: r.id, seatId: seats[0].id, prompt: 'Answer', clientKey: 'retry' })).toMatchObject({ id: first.id });
  const broadcast = await Promise.allSettled(seats.slice(1).concat(seats[0]).map((s) =>
    call<Turn>('turn_request', { roomId: r.id, seatId: s.id, prompt: 'Broadcast', clientKey: 'broadcast-' + s.id })));
  expect(broadcast.map((b) => b.status)).toEqual(['fulfilled', 'fulfilled', 'rejected']);
  expect((broadcast[2] as PromiseRejectedResult).reason).toMatchObject({ code: 'budget_exhausted' });
  await expect(call('turn_request', { roomId: r.id, seatId: seats[0].id, prompt: 'Broadcast', clientKey: 'broadcast-' + seats[0].id }))
    .rejects.toMatchObject({ code: 'budget_exhausted' });
  expect(store.count('turn', { roomId: r.id })).toBe(3);
  expect(handoffs(r.id)).toHaveLength(1);
  expect(handoffs(r.id)[0].data).toMatchObject({ budgets: ['turn'], handoff: { stoppedTurnIds: [] } });
  expect(store.count('turn', { roomId: r.id, status: ['queued'] })).toBe(3);
  const args = { roomId: r.id, turnId: first.id };
  await call('turn_claim', args, agentOf(seats[0]));
  expect(await call('turn_complete', { ...args, text: 'Accepted work still finishes' }, agentOf(seats[0]))).toMatchObject({ status: 'completed' });
  expect(store.list('grant')).toHaveLength(0);
});

it('lets the owner lift a lowered limit and records a new handoff when it is used up again', async () => {
  const { r, reviewer } = await frozenRoom();
  await call('policy_update', { roomId: r.id, policy: { maxMessages: 5 } });
  expect(store.get<Room>('room', r.id)?.exhaustedBudgets ?? []).toEqual([]);
  const turn = await call<Turn>('turn_request', { roomId: r.id, seatId: reviewer.id, prompt: 'Resume' });
  await call('turn_claim', { roomId: r.id, turnId: turn.id }, agentOf(reviewer));
  await call('turn_complete', { roomId: r.id, turnId: turn.id, text: 'Resumed answer' }, agentOf(reviewer));
  await call('policy_update', { roomId: r.id, policy: { maxMessages: 4 } });
  expect(handoffs(r.id)).toHaveLength(2);
  expect(handoffs(r.id)[1].data).toMatchObject({ budgets: ['message'], policyVersion: 4 });
});

async function runtimeFixture(startSession: RuntimeOptions['startSession']) {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-handoff-'));
  const runtime: Runtime = await createRuntime(dir, { tickMs: 10, startSession });
  const run = <T = ToolArgs>(name: string, args: ToolArgs) => runtime.core.dispatch(owner, name, args) as Promise<T>;
  const close = async () => { await runtime.stop(); await rm(dir, { recursive: true, force: true }); };
  return { runtime, run, close };
}

it('records the time budget once when it runs out, withdrawing work that waits for approval', async () => {
  let offset = 0;
  const clock = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => clock() + offset);
  const { runtime, run, close } = await runtimeFixture(async () => { throw new Error('No session may start'); });
  try {
    const busy = await run<Room>('room_create', { title: 'Busy', objective: 'Waits for approval' });
    const idle = await run<Room>('room_create', { title: 'Idle', objective: 'Nothing queued' });
    const worker = await run<Seat>('seat_add', { roomId: busy.id, product: 'codex', mode: 'managed', name: 'Worker' });
    await run('seat_consent', { roomId: busy.id, seatId: worker.id, consent: true });
    const waiting = await run<Turn>('turn_request', { roomId: busy.id, seatId: worker.id, prompt: 'Needs approval' });
    offset = 5400001;
    for (const r of [busy, idle])
      await expect.poll(() => runtime.core.store.get<Room>('room', r.id)?.exhaustedBudgets).toEqual(['time']);
    expect(runtime.core.store.get<Turn>('turn', waiting.id)).toMatchObject({ status: 'cancelled', error: expect.stringMatching(/time budget/i) });
    expect(runtime.core.store.get<ToolArgs>('permission', String(waiting.permissionRequestId))).toMatchObject({ status: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    for (const r of [busy, idle])
      expect(runtime.core.store.events(r.id, 0, 1000).filter((e) => e.type === 'room.budget_exhausted')).toHaveLength(1);
  } finally { await close(); }
});

it('lets a turn that was already running finish and keeps the answer it can no longer post', async () => {
  let release!: (text: string) => void, running!: () => void;
  const prompting = new Promise<void>((resolve) => { running = resolve; });
  const { runtime, run, close } = await runtimeFixture(async (product) => ({ id: 'handoff-fixture', product, capabilities: ['prompt', 'cancel'],
    prompt: () => { running(); return new Promise<string>((resolve) => { release = resolve; }); }, cancel: async () => release(''), close: async () => true }));
  try {
    const r = await run<Room>('room_create', { title: 'Running', objective: 'Finish accepted work' });
    await run('policy_update', { roomId: r.id, policy: { maxMessages: 2 } });
    const worker = await run<Seat>('seat_add', { roomId: r.id, product: 'codex', mode: 'managed', name: 'Worker' });
    await run('seat_consent', { roomId: r.id, seatId: worker.id, consent: true });
    const turn = await run<Turn>('turn_request', { roomId: r.id, seatId: worker.id, prompt: 'Long answer' });
    await run('permission_grant', { requestId: turn.permissionRequestId });
    await prompting;
    await run('room_post', { roomId: r.id, text: 'One' });
    await run('room_post', { roomId: r.id, text: 'Two' });
    const current = () => runtime.core.store.get<Turn & { failure?: string; retainedAnswer?: ToolArgs }>('turn', turn.id)!;
    expect(runtime.core.store.get<Room>('room', r.id)?.exhaustedBudgets).toEqual(['message']);
    expect(current().status).toBe('running');
    release('Finished after the freeze');
    await expect.poll(() => current().status).toBe('failed');
    expect(current()).toMatchObject({ failure: 'budget_exhausted', retainedAnswer: { text: 'Finished after the freeze' } });
  } finally { await close(); }
});

it('renders the handoff in the Markdown transcript', async () => {
  const { r } = await frozenRoom();
  const records = ['room', 'seat', 'interaction'].flatMap((kind) => store.list<ToolArgs>(kind)
    .filter((v) => (kind === 'room' ? v.id : v.roomId) === r.id).map((value) => ({ kind, id: String(value.id), value })));
  const exported: RoomExport = { schemaVersion: 2, digest: 'digest', records, events: store.events(r.id, 0, 1000) as unknown as ToolArgs[] };
  const markdown = exportTranscript(exported);
  expect(markdown).toContain('Runtime · budget used up');
  expect(markdown).toContain('Message budget used up: 3 of 3 messages.');
  expect(markdown).toContain('New turns are refused. Nothing was approved or accepted.');
  expect(markdown).toContain('2 queued turns were cancelled before they started.');
  expect(markdown).toContain(`Latest agenda #${seq(r.id, 'agenda')}. Latest proposed decision #${seq(r.id, 'decision')}, not accepted.`);
  expect(markdown).toMatch(/Open obligations:\n\n- question for Reviewer \(Claude Code seat\) in #\d+, stored/);
});
