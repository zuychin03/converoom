import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import type {
  Actor,
  Core,
  Event,
  Room,
  Seat,
  Store,
  ToolArgs,
  Turn,
} from '../packages/shared/src/contracts.js';
const human: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
const agent: Actor = { kind: 'agent', principalId: 'agent-a', ownerId: 'owner' };
let store: Store;
let core: Core;
const call = <T>(name: string, args: ToolArgs = {}, actor = human) =>
  core.dispatch(actor, name, args) as Promise<T>;
async function room(actor = agent) {
  return call<Room>(
    'room_create',
    {
      title: 'Room',
      objective: 'Review design',
      workflow: 'discussion',
      clientKey: crypto.randomUUID(),
    },
    actor,
  );
}
async function seat(roomId: string, mode = 'managed', role = 'member') {
  return call<Seat>('seat_add', { roomId, product: 'codex', name: 'Reviewer', mode, role });
}
beforeEach(() => {
  store = createStore(':memory:');
  core = createCore(store);
});
afterEach(() => { vi.restoreAllMocks(); store?.close(); });
it('forgets stored read results at startup but keeps mutation results for safe retries', () => {
  const previous = createStore(':memory:');
  try {
    previous.idempotent('owner', 'room_export', 'export-key', { roomId: 'room' }, () => ({ events: ['Retained history copy'] }));
    previous.idempotent('owner', 'room_post', 'post-key', { roomId: 'room', text: 'Hello' }, () => ({ id: 'event' }));
    createCore(previous);
    expect(previous.idempotent('owner', 'room_export', 'export-key', { roomId: 'room', rerun: true }, () => 'rerun')).toBe('rerun');
    expect(() => previous.idempotent('owner', 'room_post', 'post-key', { roomId: 'room', text: 'Changed' }, () => 'duplicate'))
      .toThrow(/different payload/i);
  } finally { previous.close(); }
});
it('removes stored mutation results a week after a later startup pass, so expired keys run again', async () => {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const create = () => call<Room>('room_create', { title: 'Room', objective: 'Retry later', clientKey: 'create-key' });
  const first = await create();
  now += 3600000; createCore(store);
  expect((await create()).id).toBe(first.id);
  now += 7 * 86400000; createCore(store);
  expect((await create()).id).not.toBe(first.id);
});
it('applies the discussion duration to ordinary rooms but not to a remote connection’s local room', async () => {
  let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
  const ordinary = await room(human), local = await room(human);
  store.put('room', local.id, { ...store.get<Room>('room', local.id)!, remoteConnectionId: 'connection' });
  const first = await seat(ordinary.id, 'polling'), second = await seat(local.id, 'polling');
  now += 5400001;
  await expect(call('turn_request', { roomId: ordinary.id, seatId: first.id, prompt: 'Late' })).rejects.toThrow(/budget/i);
  await expect(call('room_post', { roomId: ordinary.id, text: 'Late' })).rejects.toThrow(/budget/i);
  const turn = await call<Turn>('turn_request', { roomId: local.id, seatId: second.id, prompt: 'Still bounded by turns' });
  expect(await call('turn_claim', { roomId: local.id, turnId: turn.id }, { kind: 'agent', principalId: second.principalId, ownerId: second.ownerId }))
    .toMatchObject({ status: 'running' });
  expect(await call('room_post', { roomId: local.id, text: 'Still bounded by messages' })).toMatchObject({ type: 'message' });
});

describe('room authority and interactions', () => {
  it('creates a polling host for agents and deduplicates 100 create retries', async () => {
    const args = {
      title: 'Room',
      objective: 'Review',
      workflow: 'discussion',
      clientKey: 'create',
    };
    const rooms = await Promise.all(
      Array.from({ length: 100 }, () => call<Room>('room_create', args, agent)),
    );
    expect(new Set(rooms.map((r) => r.id)).size).toBe(1);
    expect(store.list('room')).toHaveLength(1);
    expect(store.get<Seat>('seat', rooms[0].hostSeatId!)).toMatchObject({
      mode: 'polling',
      principalId: agent.principalId,
      role: 'host',
    });
    await expect(call('room_create', { ...args, title: 'Different' }, agent)).rejects.toThrow(
      /payload/i,
    );
  });
  it('rejects forged identity, nonmembers, observers and agent owner grants', async () => {
    const r = await room();
    await expect(
      call('room_post', { roomId: r.id, text: 'x', ownerId: 'owner' }, agent),
    ).rejects.toThrow(/identity/i);
    await expect(
      call('room_get', { roomId: r.id }, { ...agent, principalId: 'outsider' }),
    ).rejects.toThrow(/member/i);
    await expect(
      call('room_join', { roomId: r.id }, { ...agent, principalId: 'outsider' }),
    ).rejects.toThrow(/member/i);
    const observer = await seat(r.id, 'polling', 'observer');
    await expect(
      call(
        'room_post',
        { roomId: r.id, text: 'x' },
        { ...agent, principalId: observer.principalId },
      ),
    ).rejects.toThrow(/observer/i);
    await expect(
      call('seat_consent', { roomId: r.id, seatId: observer.id, consent: true }, agent),
    ).rejects.toThrow(/human/i);
  });
  it('stores directed receipts separately and only lets recipient answer', async () => {
    const r = await room();
    const target = await seat(r.id, 'polling');
    const reader = { ...agent, principalId: target.principalId };
    await call(
      'room_post',
      { roomId: r.id, text: '@Reviewer text alone', clientKey: 'raw' },
      agent,
    );
    expect(store.list('interaction')).toHaveLength(0);
    const post = await call<Event>(
      'room_post',
      {
        roomId: r.id,
        text: 'Review?',
        mentions: [{ seatId: target.id, intent: 'review' }],
        clientKey: 'q',
      },
      agent,
    );
    let interaction = store.list<ToolArgs>('interaction')[0];
    expect(interaction.status).toBe('stored');
    await call('room_inbox', { roomId: r.id }, reader);
    interaction = store.list<ToolArgs>('interaction')[0];
    expect(interaction.status).toBe('delivered');
    await call('room_read', { roomId: r.id, cursor: 0 }, reader);
    expect(store.list<ToolArgs>('interaction')[0].status).toBe('read');
    await expect(
      call('room_post', { roomId: r.id, text: 'wrong reply', replyToId: interaction.id }, agent),
    ).rejects.toThrow(/recipient/i);
    const response = await call<Event>(
      'room_post',
      { roomId: r.id, text: 'Reviewed', replyToId: interaction.id },
      reader,
    );
    expect(store.list<ToolArgs>('interaction')[0]).toMatchObject({
      status: 'responded',
      messageId: post.id,
      responseId: response.id,
    });
    await call(
      'interaction_resolve',
      { roomId: r.id, interactionId: interaction.id, reason: 'Accepted' },
      agent,
    );
    expect(store.list<ToolArgs>('interaction')[0].status).toBe('resolved');
  });
  it('bounds seats, pending obligations, payloads and immutable policies', async () => {
    const r = await room();
    const target = await seat(r.id, 'polling');
    await call('policy_update', {
      roomId: r.id,
      policy: { maxPending: 1, maxMessages: 2, maxActiveTurns: 999 },
    });
    await call(
      'room_post',
      { roomId: r.id, text: 'Question', mentions: [{ seatId: target.id, intent: 'question' }] },
      agent,
    );
    await expect(
      call(
        'room_post',
        { roomId: r.id, text: 'Second', mentions: [{ seatId: target.id, intent: 'question' }] },
        agent,
      ),
    ).rejects.toThrow(/pending/i);
    await expect(
      call('room_post', { roomId: r.id, text: 'x'.repeat(65537) }, agent),
    ).rejects.toThrow(/payload|text/i);
    expect(store.list<ToolArgs>('policy')).toHaveLength(2);
    expect(
      (await call<Room>('room_get', { roomId: r.id })).policy.maxActiveTurns,
    ).toBeLessThanOrEqual(5);
    await seat(r.id);
    await seat(r.id);
    await seat(r.id);
    await expect(seat(r.id)).rejects.toThrow(/seat/i);
    await expect(seat(r.id, 'polling', 'observer')).resolves.toMatchObject({ role: 'observer' });
  });
  it.each(['claude', 'opencode'])('refuses a managed %s seat at setup because it has no managed adapter', async (product) => {
    const r = await room(human);
    await expect(call('seat_add', { roomId: r.id, product, mode: 'managed', name: 'Unsupported' })).rejects.toMatchObject({ code: 'managed_unsupported' });
    expect(store.list<Seat>('seat', { roomId: r.id })).toHaveLength(0);
    await expect(call<Seat>('seat_add', { roomId: r.id, product, mode: 'polling', name: 'Polling' })).resolves.toMatchObject({ product, mode: 'polling' });
  });
  it('records an owner inspection of an uncertain turn without changing or rerunning it', async () => {
    const r = await room(human);
    const target = await seat(r.id);
    await call('seat_consent', { roomId: r.id, seatId: target.id, consent: true });
    const turn = await call<Turn>('turn_request', { roomId: r.id, seatId: target.id, prompt: 'Review' });
    const inspect = (finding: unknown, actor = human, turnId = turn.id) => call<Turn & { inspection?: ToolArgs }>('turn_inspect',
      { roomId: r.id, turnId, finding, note: 'Checked the workspace: no files changed' }, actor);
    await expect(inspect('not_acted')).rejects.toMatchObject({ code: 'turn_state' });
    store.put('turn', turn.id, { ...store.get<Turn>('turn', turn.id)!, status: 'uncertain' });
    await expect(inspect('not_acted', { kind: 'agent', principalId: target.principalId, ownerId: human.ownerId })).rejects.toMatchObject({ code: 'human_required' });
    await expect(inspect('maybe')).rejects.toMatchObject({ code: 'invalid_argument' });
    const inspected = await inspect('not_acted');
    expect(inspected).toMatchObject({ status: 'uncertain', inspection: { finding: 'not_acted', note: 'Checked the workspace: no files changed', by: human.principalId } });
    expect(store.get<Turn>('turn', turn.id)).toMatchObject({ status: 'uncertain', inspection: { finding: 'not_acted' } });
    const event = store.events(r.id).at(-1)!;
    expect(event).toMatchObject({ type: 'turn.inspected', data: { turnId: turn.id, finding: 'not_acted' } });
    expect(JSON.stringify(event)).not.toContain('no files changed');
    expect(store.list<Turn>('turn', { roomId: r.id })).toHaveLength(1);
  });
  it('requires consent and human grant bound to exact turn scope', async () => {
    const r = await room();
    const target = await seat(r.id);
    await expect(
      call('turn_request', { roomId: r.id, seatId: target.id, prompt: 'Review' }, agent),
    ).rejects.toThrow(/consent/i);
    await call('seat_consent', { roomId: r.id, seatId: target.id, consent: true });
    const turn = await call<Turn & { permissionRequestId: string }>(
      'turn_request',
      { roomId: r.id, seatId: target.id, prompt: 'Review' },
      agent,
    );
    const request = store.get<ToolArgs>('permission', turn.permissionRequestId)!;
    expect(request).toMatchObject({
      action: 'turn_execute',
      ownerId: 'owner',
      status: 'pending',
      scope: { turnId: turn.id, seatId: target.id, prompt: 'Review', policyVersion: 1 },
    });
    await expect(
      call('permission_grant', { roomId: r.id, requestId: request.id }, agent),
    ).rejects.toThrow(/human/i);
    await expect(
      call('permission_grant', { roomId: r.id, requestId: request.id, scopeDigest: 'forged' }),
    ).rejects.toThrow(/scope/i);
    const grant = await call<ToolArgs>('permission_grant', { roomId: r.id, requestId: request.id });
    expect(grant).toMatchObject({
      requestId: request.id,
      scopeDigest: request.scopeDigest,
      action: 'turn_execute',
      ownerId: 'owner',
    });
  });
  it('recovers interrupted turns as uncertain without replay and retains unsent work', async () => {
    const r = await room();
    const s = await seat(r.id);
    await call('seat_consent', { roomId: r.id, seatId: s.id, consent: true });
    const t = await call<Turn>(
      'turn_request',
      { roomId: r.id, seatId: s.id, prompt: 'Run' },
      agent,
    );
    store.put('turn', 'interrupted', { ...t, id: 'interrupted', status: 'running' });
    core = createCore(store);
    expect(store.get<Turn>('turn', t.id)?.status).toBe('queued');
    expect(store.get<Turn>('turn', 'interrupted')?.status).toBe('uncertain');
  });
  it('pauses new turns and keeps cancellation honest until supervisor confirmation', async () => {
    const r = await room();
    const s = await seat(r.id);
    await call('seat_consent', { roomId: r.id, seatId: s.id, consent: true });
    const t = await call<Turn>(
      'turn_request',
      { roomId: r.id, seatId: s.id, prompt: 'Run' },
      agent,
    );
    store.put('turn', t.id, { ...t, status: 'running' });
    await call('turn_cancel', { roomId: r.id, turnId: t.id });
    expect(store.get<ToolArgs>('turn', t.id)?.status).toBe('cancelling');
    await call('room_pause', { roomId: r.id });
    expect(store.get<Room>('room', r.id)?.lifecycle).toBe('pausing');
    await expect(
      call('turn_request', { roomId: r.id, seatId: s.id, prompt: 'Run' }, agent),
    ).rejects.toThrow(/pausing/i);
  });
  it('withdraws the approval request of a queued turn when it is cancelled', async () => {
    const r = await room();
    const s = await seat(r.id);
    await call('seat_consent', { roomId: r.id, seatId: s.id, consent: true });
    const t = await call<Turn>('turn_request', { roomId: r.id, seatId: s.id, prompt: 'Run' }, agent);
    await call('turn_cancel', { roomId: r.id, turnId: t.id });
    expect(store.get<Turn>('turn', t.id)?.status).toBe('cancelled');
    expect(store.get<ToolArgs>('permission', t.permissionRequestId!)?.status).toBe('cancelled');
    expect(store.events(r.id, 0, 100).filter((e) => e.type === 'permission.cancelled')).toEqual([
      expect.objectContaining({ data: expect.objectContaining({ requestId: t.permissionRequestId }) }),
    ]);
    await expect(call('permission_grant', { requestId: t.permissionRequestId })).rejects.toThrow();
  });
  it('preserves queued turns and approvals across pause and resume', async () => {
    const r = await room();
    const target = await seat(r.id);
    await call('seat_consent', { roomId: r.id, seatId: target.id, consent: true });
    const turn = await call<Turn>('turn_request', { roomId: r.id, seatId: target.id, prompt: 'Retain this work' });
    const permission = store.get<ToolArgs>('permission', turn.permissionRequestId!)!;
    await call('room_pause', { roomId: r.id });
    expect(store.get<Turn>('turn', turn.id)).toEqual(turn);
    expect(store.get('permission', String(permission.id))).toEqual(permission);
    await call('room_resume', { roomId: r.id });
    expect(store.get<Turn>('turn', turn.id)).toEqual(turn);
    await call('permission_grant', { requestId: permission.id });
    expect(store.get<Turn>('turn', turn.id)?.status).toBe('queued');
    await call('room_close', { roomId: r.id });
    expect(store.get<Turn>('turn', turn.id)?.status).toBe('cancelled');
  });
  it('requires a human confirmation for host transfer', async () => {
    const r = await room();
    const s = await seat(r.id, 'polling');
    const request = await call<ToolArgs>(
      'host_transfer_request',
      { roomId: r.id, seatId: s.id },
      agent,
    );
    expect((await call<Room>('room_get', { roomId: r.id })).hostSeatId).toBe(r.hostSeatId);
    await expect(
      call('host_transfer_confirm', { roomId: r.id, requestId: request.id }, agent),
    ).rejects.toThrow(/human/i);
    await call('host_transfer_confirm', { roomId: r.id, requestId: request.id });
    expect((await call<Room>('room_get', { roomId: r.id })).hostSeatId).toBe(s.id);
  });
});
it('creates a room with the owner\'s chosen roster in one step, and refuses a roster from an agent or one that cannot be seated', async () => {
  const r = await call<Room>('room_create', { title: 'Roster', objective: 'Pick a storage engine',
    seats: [{ product: 'codex', mode: 'managed' }, { product: 'claude', mode: 'polling' }] });
  expect(store.list<Seat>('seat', { roomId: r.id }).map((s) => [s.name, s.product, s.mode, s.role])).toEqual([
    ['Codex', 'codex', 'managed', 'member'], ['Claude Code', 'claude', 'polling', 'member']]);
  await expect(call('room_create', { title: 'Agent roster', objective: 'Add seats', seats: [{ product: 'codex', mode: 'managed' }] }, agent))
    .rejects.toMatchObject({ code: 'human_required' });
  await expect(call('room_create', { title: 'Unseatable', objective: 'Managed Claude Code', seats: [{ product: 'claude', mode: 'managed' }] }))
    .rejects.toMatchObject({ code: 'managed_unsupported' });
  expect(store.list<Room>('room').map((room) => room.title)).toEqual(['Roster']);
});
