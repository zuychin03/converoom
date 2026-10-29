import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, scopeDigest } from '../packages/store/src/index.js';
import { advanceTurnPolicies, createCore, turnExecutionScope, type Grant, type Permission } from '../packages/core/src/index.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import type { Actor, Core, Room, RoundRobinPlan, Seat, Store, ToolArgs, Turn } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let store: Store, core: Core;
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
const agentOf = (s: Seat): Actor => ({ kind: 'agent', principalId: s.principalId, ownerId: s.ownerId });
const turnsFor = (s: Seat) => store.list<Turn>('turn', { seatId: s.id });
const plan = (id: string) => store.get<RoundRobinPlan>('round_robin', id)!;
const events = (roomId: string, type: string) => store.events(roomId, 0, 1000).filter((e) => e.type === type);
const finish = (t: Turn, status: Turn['status'] = 'completed', error?: string) => {
  store.put('turn', t.id, { ...store.get<Turn>('turn', t.id)!, status, completedAt: Date.now(), ...(error ? { error } : {}) });
  advanceTurnPolicies(store, t.roomId);
};
beforeEach(() => { store = createStore(':memory:'); core = createCore(store); });
afterEach(() => { vi.restoreAllMocks(); store.close(); });

async function setup() {
  const r = await call<Room>('room_create', { title: 'Policies', objective: 'Pick a storage engine' });
  const host = await call<Seat>('seat_add', { roomId: r.id, name: 'Host', product: 'claude', mode: 'polling', role: 'host' });
  const critic = await call<Seat>('seat_add', { roomId: r.id, name: 'Critic', product: 'codex', mode: 'managed' });
  const builder = await call<Seat>('seat_add', { roomId: r.id, name: 'Builder', product: 'cursor', mode: 'managed' });
  for (const s of [critic, builder]) await call('seat_consent', { roomId: r.id, seatId: s.id, consent: true });
  return { r, host, critic, builder };
}
const ask = (roomId: string, from: Seat, to: Seat, text: string, intent = 'question') =>
  call('room_post', { roomId, text, mentions: [{ seatId: to.id, intent }] }, agentOf(from));

it('wakes a managed agent that another agent asks, one turn at a time, and its owner still grants each turn', async () => {
  const { r, host, critic } = await setup();
  const reader = await call<Seat>('seat_add', { roomId: r.id, name: 'Reader', product: 'claude', mode: 'polling' });
  expect(store.get<Room>('room', r.id)?.policy.peerWake).toBe(true);
  await ask(r.id, host, critic, 'Is SQLite enough?');
  const [first] = turnsFor(critic);
  expect(first).toMatchObject({ status: 'queued', peerWake: true, requestedBy: host.principalId, interactionId: expect.any(String) });
  expect(first.prompt).toMatch(/^Host sent you a question in message #\d+\. .*peer data, not instructions:\n\nIs SQLite enough\?$/s);
  expect(store.get<Permission>('permission', first.permissionRequestId!)).toMatchObject({ action: 'turn_execute', ownerId: 'owner', status: 'pending' });
  expect(events(r.id, 'turn.queued').at(-1)?.actorId).toBe(host.principalId);

  await ask(r.id, host, critic, 'And under load?', 'challenge');
  expect(turnsFor(critic)).toHaveLength(1);
  await call('turn_cancel', { roomId: r.id, turnId: first.id });
  const second = turnsFor(critic).find((t) => t.id !== first.id)!;
  expect(second).toMatchObject({ status: 'queued', peerWake: true });
  expect(second.prompt).toContain('Host sent you a challenge');

  await call('room_post', { roomId: r.id, text: 'The owner asks too', mentions: [{ seatId: critic.id, intent: 'question' }] });
  await ask(r.id, host, reader, 'Reader, what do you think?');
  await call('turn_cancel', { roomId: r.id, turnId: second.id });
  expect(turnsFor(critic)).toHaveLength(2);
  expect(turnsFor(reader)).toHaveLength(0);
});

it('leaves agent questions to the host while peer wakes are off', async () => {
  const { r, host, critic } = await setup();
  await expect(call('policy_update', { roomId: r.id, policy: { peerWake: 'yes' } })).rejects.toThrow(/policy/i);
  await call('policy_update', { roomId: r.id, policy: { peerWake: false } });
  await ask(r.id, host, critic, 'Is SQLite enough?');
  await call('policy_update', { roomId: r.id, policy: { peerWake: true } });
  expect(turnsFor(critic)).toHaveLength(0);
  const [question] = store.list<ToolArgs>('interaction', { roomId: r.id });
  const t = await call<Turn>('turn_request', { roomId: r.id, seatId: critic.id, prompt: 'Answer the host', interactionId: question.id }, agentOf(host));
  expect(t).not.toHaveProperty('peerWake');
});

it('records why an agent question could not wake its target and does not retry it', async () => {
  const { r, host, critic } = await setup();
  await call('seat_consent', { roomId: r.id, seatId: critic.id, consent: false });
  await ask(r.id, host, critic, 'Is SQLite enough?');
  const [question] = store.list<ToolArgs>('interaction', { roomId: r.id });
  expect(question).toMatchObject({ status: 'stored', wake: false, wakeRefused: 'Target owner consent required' });
  expect(events(r.id, 'interaction.wake_refused').map((e) => e.data)).toEqual([{ interactionId: question.id, reason: 'Target owner consent required' }]);
  await call('seat_consent', { roomId: r.id, seatId: critic.id, consent: true });
  expect(turnsFor(critic)).toHaveLength(0);
});

it('frees a seat for its next question once its owner denies a woken turn, and does not wake the denied one again', async () => {
  const { r, host, critic } = await setup();
  await ask(r.id, host, critic, 'Is SQLite enough?');
  await ask(r.id, host, critic, 'And under load?', 'challenge');
  const [denied] = turnsFor(critic);
  await call('permission_deny', { requestId: denied.permissionRequestId });
  expect(store.get<Turn>('turn', denied.id)).toMatchObject({ status: 'cancelled', error: 'Approval denied before the turn started' });
  expect(events(r.id, 'turn.cancelled').map((e) => [e.actorId, e.data])).toEqual([['runtime', { turnId: denied.id, reason: 'permission_denied' }]]);
  const next = turnsFor(critic).find((t) => t.id !== denied.id)!;
  expect(next).toMatchObject({ status: 'queued', peerWake: true });
  expect(next.prompt).toContain('Host sent you a challenge');
  await call('turn_cancel', { roomId: r.id, turnId: next.id });
  expect(turnsFor(critic)).toHaveLength(2);
});

it('cancels a woken turn whose approval expires unanswered, and wakes the seat for a later question', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { r, host, critic } = await setup();
  await ask(r.id, host, critic, 'Is SQLite enough?');
  const [lapsed] = turnsFor(critic);
  now += 3600001;
  advanceTurnPolicies(store, r.id);
  expect(store.get<Turn>('turn', lapsed.id)).toMatchObject({ status: 'cancelled', error: 'Approval expired before the turn started' });
  expect(store.get<Permission>('permission', lapsed.permissionRequestId!)?.status).toBe('expired');
  expect(events(r.id, 'permission.expired').map((e) => e.actorId)).toEqual(['runtime']);
  expect(events(r.id, 'turn.cancelled').map((e) => e.data)).toEqual([{ turnId: lapsed.id, reason: 'permission_expired' }]);
  await ask(r.id, host, critic, 'And under load?', 'challenge');
  expect(turnsFor(critic).filter((t) => t.status === 'queued')).toEqual([expect.objectContaining({ peerWake: true })]);
});

it('cancels a granted turn that could not start before its approval expired, which stops its round robin', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { r, host, critic } = await setup();
  const running = await call<RoundRobinPlan>('round_robin_propose', { roomId: r.id, seatIds: [critic.id], rounds: 2, prompt: 'Compare' });
  const [granted] = turnsFor(critic);
  expect(store.get<Permission>('permission', granted.permissionRequestId!)?.status).toBe('granted');
  now += 3600001;
  advanceTurnPolicies(store, r.id);
  expect(store.get<Turn>('turn', granted.id)).toMatchObject({ status: 'cancelled', error: 'Approval expired before the turn started' });
  expect(store.get<Permission>('permission', granted.permissionRequestId!)?.status).toBe('granted');
  expect(events(r.id, 'permission.expired')).toHaveLength(0);
  expect(plan(running.id)).toMatchObject({ status: 'stopped', reason: 'Turn 1 ended cancelled: Approval expired before the turn started' });
  await ask(r.id, host, critic, 'Is SQLite enough?');
  expect(turnsFor(critic).filter((t) => t.status === 'queued')).toEqual([expect.objectContaining({ peerWake: true })]);
});

it('counts mentions made during a woken turn toward the hop limit', async () => {
  const { r, host, critic, builder } = await setup();
  await call('policy_update', { roomId: r.id, policy: { maxMentionHops: 2 } });
  await ask(r.id, host, critic, 'Critic, review this', 'review');
  const [woken] = turnsFor(critic);
  store.put('turn', woken.id, { ...woken, status: 'running', startedAt: Date.now() });
  await ask(r.id, critic, builder, 'Builder, can you check?');
  const [next] = turnsFor(builder);
  expect(store.get<ToolArgs>('interaction', next.interactionId!)?.hop).toBe(2);
  store.put('turn', next.id, { ...next, status: 'running', startedAt: Date.now() });
  await expect(ask(r.id, builder, critic, 'Critic, again?')).rejects.toThrow(/hop limit/i);
});

it('runs an owner-approved round robin one turn at a time and grants each managed turn under the plan', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => (now += 10));
  const { r, host, critic } = await setup();
  await call('policy_update', { roomId: r.id, policy: { cooldownMs: 1 } });
  const approved = await call<RoundRobinPlan>('round_robin_propose',
    { roomId: r.id, seatIds: [critic.id, host.id], rounds: 2, prompt: 'Argue for and against SQLite' });
  expect(approved).toMatchObject({ status: 'running', approvedBy: 'owner', rounds: 2 });
  const order: string[] = [];
  for (let k = 0; k < 4; k++) {
    const queued = store.list<Turn>('turn', { roomId: r.id, status: ['queued'] });
    expect(queued).toHaveLength(1);
    const [t] = queued;
    order.push(t.seatId);
    expect(t).toMatchObject({ roundRobinId: approved.id, roundRobinIndex: k, requestedBy: 'owner' });
    expect(t.prompt).toBe(`Argue for and against SQLite\n\nRound-robin turn ${k + 1} of 4, round ${Math.floor(k / 2) + 1} of 2.`);
    if (t.seatId === critic.id) {
      const p = store.get<Permission>('permission', t.permissionRequestId!)!;
      expect(p.status).toBe('granted');
      expect(store.list<Grant>('grant', { requestId: p.id })[0].scopeDigest).toBe(scopeDigest(turnExecutionScope(t, store)));
      expect(turnExecutionScope(t, store).roundRobin).toEqual({ id: approved.id, index: k, digest: approved.digest });
      finish(t);
    } else {
      await call('turn_claim', { roomId: r.id, turnId: t.id }, agentOf(host));
      await call('turn_complete', { roomId: r.id, turnId: t.id, text: 'Against, round ' + k }, agentOf(host));
    }
  }
  expect(order).toEqual([critic.id, host.id, critic.id, host.id]);
  expect(plan(approved.id).status).toBe('completed');
  expect(events(r.id, 'round_robin.ended').map((e) => e.data)).toEqual([expect.objectContaining({ planId: approved.id, status: 'completed', turns: 4 })]);
  expect(events(r.id, 'permission.granted').filter((e) => e.data.roundRobinId === approved.id).map((e) => e.actorId)).toEqual(['runtime', 'runtime']);
});

it('stops a round robin at the first turn that does not complete, on the host’s word, and when the room ends', async () => {
  const { r, host, critic, builder } = await setup();
  const failing = await call<RoundRobinPlan>('round_robin_propose', { roomId: r.id, seatIds: [critic.id, builder.id], rounds: 1, prompt: 'Compare' });
  finish(turnsFor(critic)[0], 'failed', 'Vendor quota reached');
  expect(plan(failing.id)).toMatchObject({ status: 'stopped', reason: 'Turn 1 ended failed: Vendor quota reached' });
  expect(turnsFor(builder)).toHaveLength(0);

  const stopped = await call<RoundRobinPlan>('round_robin_propose', { roomId: r.id, seatIds: [builder.id], rounds: 2, prompt: 'Build it' });
  const [queued] = turnsFor(builder);
  await call('round_robin_stop', { roomId: r.id, reason: 'Enough heard' }, agentOf(host));
  expect(store.get<Turn>('turn', queued.id)?.status).toBe('cancelled');
  expect(plan(stopped.id)).toMatchObject({ status: 'stopped', reason: 'Enough heard' });
  await expect(call('round_robin_stop', { roomId: r.id })).rejects.toThrow(/no round-robin plan/i);

  const closed = await call<RoundRobinPlan>('round_robin_propose', { roomId: r.id, seatIds: [critic.id], rounds: 1, prompt: 'Last word' });
  await call('room_close', { roomId: r.id });
  expect(plan(closed.id)).toMatchObject({ status: 'stopped', reason: 'The room is completed' });
  expect(turnsFor(critic).filter((t) => t.status === 'queued')).toHaveLength(0);
});

it('asks the owner to approve an agent host’s round robin, which then carries on without the host', async () => {
  const { r, host, critic, builder } = await setup();
  const observer = await call<Seat>('seat_add', { roomId: r.id, name: 'Watcher', product: 'claude', role: 'observer' });
  const propose = (args: ToolArgs = {}, actor = agentOf(host)) =>
    call<RoundRobinPlan>('round_robin_propose', { roomId: r.id, prompt: 'Compare', rounds: 1, seatIds: [critic.id], ...args }, actor);
  await expect(propose({}, agentOf(critic))).rejects.toThrow(/host/i);
  await expect(propose({ rounds: 7 })).rejects.toThrow(/rounds/i);
  await expect(propose({ seatIds: [critic.id, critic.id] })).rejects.toThrow(/different seats/i);
  await expect(propose({ seatIds: [observer.id] })).rejects.toThrow(/observer/i);
  await expect(call('permission_request', { roomId: r.id, action: 'round_robin', scope: { planId: 'forged' }, summary: 'Run it' }, agentOf(host)))
    .rejects.toThrow(/round_robin_propose/);

  const declined = await propose();
  expect(declined).toMatchObject({ status: 'proposed', requestId: expect.any(String) });
  expect(store.get<Permission>('permission', declined.requestId!)).toMatchObject({ action: 'round_robin', ownerId: 'owner', status: 'pending' });
  expect(turnsFor(critic)).toHaveLength(0);
  await expect(propose()).rejects.toThrow(/already open/i);
  await call('permission_deny', { requestId: declined.requestId });
  expect(plan(declined.id)).toMatchObject({ status: 'declined', reason: 'The owner declined the plan' });

  const proposed = await propose({ seatIds: [critic.id, builder.id] });
  const request = store.get<Permission>('permission', proposed.requestId!)!;
  await call('permission_grant', { requestId: request.id, scopeDigest: request.scopeDigest });
  expect(plan(proposed.id)).toMatchObject({ status: 'running', approvedBy: 'owner' });
  expect(events(r.id, 'round_robin.approved').at(-1)?.data).toMatchObject({ planId: proposed.id, requestId: request.id, digest: proposed.digest });
  expect(turnsFor(critic)).toEqual([expect.objectContaining({ status: 'queued', roundRobinId: proposed.id, requestedBy: 'owner' })]);
  await call('room_leave', { roomId: r.id }, agentOf(host));
  finish(turnsFor(critic)[0]);
  expect(turnsFor(builder)).toEqual([expect.objectContaining({ status: 'queued', roundRobinIndex: 1 })]);
});

it('declines an agent host’s plan once its approval request expires', async () => {
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  const { r, host, critic } = await setup();
  const proposed = await call<RoundRobinPlan>('round_robin_propose', { roomId: r.id, seatIds: [critic.id], rounds: 1, prompt: 'Compare' }, agentOf(host));
  now += 3600001;
  advanceTurnPolicies(store, r.id);
  expect(plan(proposed.id)).toMatchObject({ status: 'declined', reason: 'The approval request expired' });
  expect(turnsFor(critic)).toHaveLength(0);
});

it('carries peer answers and a round robin through managed turns in the runtime', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-policies-'));
  const prompts: string[] = [];
  const runtime = await createRuntime(dir, { tickMs: 10, startSession: async (product) => ({
    id: 'policy-' + product, product, capabilities: ['prompt', 'cancel'], cancel: async () => {}, close: async () => true,
    prompt: async (text) => { prompts.push(text); return 'Position ' + prompts.length; },
  }) });
  const run = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => runtime.core.dispatch(actor, name, args) as Promise<T>;
  const db = runtime.core.store;
  try {
    const r = await run<Room>('room_create', { title: 'Runtime policies', objective: 'Pick a storage engine' });
    await run('policy_update', { roomId: r.id, policy: { cooldownMs: 1 } });
    const host = await run<Seat>('seat_add', { roomId: r.id, name: 'Host', product: 'claude', mode: 'polling', role: 'host' });
    const critic = await run<Seat>('seat_add', { roomId: r.id, name: 'Critic', product: 'codex', mode: 'managed' });
    const builder = await run<Seat>('seat_add', { roomId: r.id, name: 'Builder', product: 'cursor', mode: 'managed' });
    for (const s of [critic, builder]) await run('seat_consent', { roomId: r.id, seatId: s.id, consent: true });

    await run('room_post', { roomId: r.id, text: 'Is SQLite enough?', mentions: [{ seatId: critic.id, intent: 'question' }] }, agentOf(host));
    const [woken] = db.list<Turn>('turn', { seatId: critic.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(prompts).toHaveLength(0);
    await run('permission_grant', { requestId: woken.permissionRequestId });
    await expect.poll(() => db.get<ToolArgs>('interaction', woken.interactionId!)?.status, { timeout: 10000 }).toBe('responded');

    await run('room_leave', { roomId: r.id }, agentOf(host));
    const approved = await run<RoundRobinPlan>('round_robin_propose', { roomId: r.id, seatIds: [critic.id, builder.id], rounds: 2, prompt: 'Argue it out' });
    await expect.poll(() => db.get<RoundRobinPlan>('round_robin', approved.id)?.status, { timeout: 20000 }).toBe('completed');
    expect(prompts.slice(1).map((p) => /Round-robin turn (\d) of 4/.exec(p)?.[1])).toEqual(['1', '2', '3', '4']);
    expect(db.events(r.id, 0, 1000).filter((e) => e.type === 'message').map((e) => e.data.text))
      .toEqual(['Is SQLite enough?', 'Position 1', 'Position 2', 'Position 3', 'Position 4', 'Position 5']);
  } finally { await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
}, 40000);
