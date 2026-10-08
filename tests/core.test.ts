import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  return call<Seat>('seat_add', { roomId, product: 'claude', name: 'Reviewer', mode, role });
}
beforeEach(() => {
  store = createStore(':memory:');
  core = createCore(store);
});
afterEach(() => store?.close());

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
    await expect(
      call('turn_request', { roomId: r.id, seatId: s.id, prompt: 'Run' }, agent),
    ).rejects.toThrow(/paused/i);
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
