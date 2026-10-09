import { beforeEach, afterEach, it, expect } from 'vitest';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import { TOOL_DEFINITIONS, validateToolArgs } from '../packages/mcp/src/tools.js';
import type { Actor, Core, Event, Seat, Store, ToolArgs, Turn } from '../packages/shared/src/contracts.js';
const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let store: Store, core: Core;
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
beforeEach(() => { store = createStore(':memory:'); core = createCore(store); });
afterEach(() => store.close());
async function fixture() {
  const room = await call('room_create', { title: 'Polling turn', objective: 'Complete an explicit manual turn' });
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', mode: 'polling', name: 'Reviewer' });
  const actor: Actor = { kind: 'agent', principalId: seat.principalId, ownerId: seat.ownerId };
  const turn = await call<Turn>('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Review this' });
  const args = { roomId: room.id, turnId: turn.id };
  return { room, seat, actor, turn, args };
}
it('claims and completes its own turn once with a public linked response', async () => {
  const { room, seat, actor } = await fixture();
  await call('room_post', { roomId: room.id, text: 'Question', mentions: [{ seatId: seat.id, intent: 'review' }] });
  const interaction = store.list<ToolArgs>('interaction')[0];
  const turn = await call<Turn>('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Answer', interactionId: interaction.id });
  const args = { roomId: room.id, turnId: turn.id, clientKey: 'claim' };
  expect(await call('turn_claim', args, actor)).toMatchObject({ status: 'running' });
  expect(await call('turn_claim', args, actor)).toMatchObject({ status: 'running' });
  const complete = { ...args, clientKey: 'complete', text: '<thinking>hidden</thinking>Public answer' };
  expect(await call('turn_complete', complete, actor)).toMatchObject({ status: 'completed' });
  await call('turn_complete', complete, actor);
  expect(store.get('interaction', String(interaction.id))).toMatchObject({ status: 'responded' });
  const events = store.events(String(room.id));
  expect(events.filter((e) => e.type === 'turn.started')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'turn.completed')).toHaveLength(1);
  expect(events.filter((e) => e.type === 'message')).toHaveLength(2);
  expect(JSON.stringify(events)).toContain('Public answer');
  expect(JSON.stringify(events)).not.toContain('hidden');
  expect((await call('room_inbox', { roomId: room.id }, actor)).turns).toEqual(
    expect.not.arrayContaining([expect.objectContaining({ id: turn.id })]),
  );
});
it('denies human impersonation, other agents and completion before claim', async () => {
  const { actor, args } = await fixture();
  await expect(call('turn_claim', args)).rejects.toThrow();
  await expect(call('turn_claim', args, { ...actor, principalId: 'outsider' })).rejects.toThrow();
  await expect(call('turn_complete', { ...args, text: 'Too early' }, actor)).rejects.toThrow();
  expect(await call('turn_claim', args, actor)).toMatchObject({ status: 'running' });
  await expect(call('turn_complete', { ...args, text: 'Forged' })).rejects.toThrow();
  await expect(call('turn_complete', { ...args, text: 'Forged' }, { ...actor, principalId: 'outsider' })).rejects.toThrow();
});
it('preserves paused queued work and accepts cancellation acknowledgement without a reply', async () => {
  const { room, actor, args } = await fixture();
  await call('room_pause', { roomId: room.id });
  await expect(call('turn_claim', args, actor)).rejects.toThrow();
  await call('room_resume', { roomId: room.id });
  await call('turn_claim', args, actor);
  await call('turn_cancel', args);
  await expect(call('turn_complete', { ...args, text: 'Late reply' }, actor)).rejects.toThrow();
  expect(await call('turn_complete', { ...args, outcome: 'cancelled' }, actor)).toMatchObject({ status: 'cancelled' });
  expect(store.events(String(room.id)).filter((e) => e.type === 'message')).toHaveLength(0);
});
it('bounds all active polling claims and does not replay a claim after restart', async () => {
  const first = await fixture(), second = await fixture(), third = await fixture();
  await call('turn_claim', first.args, first.actor);
  await call('turn_claim', second.args, second.actor);
  await expect(call('turn_claim', third.args, third.actor)).rejects.toThrow(/capacity|active/i);
  core = createCore(store);
  expect(store.get('turn', first.turn.id)).toMatchObject({ status: 'uncertain' });
  await expect(call('turn_claim', first.args, first.actor)).rejects.toThrow();
  await expect(call('turn_complete', { ...first.args, text: 'Replay' }, first.actor)).rejects.toThrow();
});
it('rolls back completion when publishing the reply exceeds its message budget', async () => {
  const { room, actor, args, turn } = await fixture();
  await call('policy_update', { roomId: room.id, policy: { maxMessages: 1 } });
  await call('room_post', { roomId: room.id, text: 'Budget used' });
  await call('turn_claim', args, actor);
  await expect(call('turn_complete', { ...args, text: 'Excess', clientKey: 'complete' }, actor)).rejects.toThrow(/budget/i);
  expect(store.get('turn', turn.id)).toMatchObject({ status: 'running' });
  expect(store.events(String(room.id)).filter((e) => e.type === 'message')).toHaveLength(1);
  await call('turn_cancel', args);
  await call('turn_complete', { ...args, outcome: 'cancelled' }, actor);
});
it('records a public failure and exposes strict polling lifecycle MCP tools', async () => {
  const { room, actor, args } = await fixture();
  await call('turn_claim', args, actor);
  expect(await call('turn_complete', { ...args, outcome: 'failed', reason: 'No subscription quota' }, actor)).toMatchObject({ status: 'failed' });
  expect(store.events(String(room.id)).some((e: Event) => e.type === 'turn.failed')).toBe(true);
  for (const name of ['turn_claim', 'turn_complete']) expect(TOOL_DEFINITIONS.some((t) => t.name === name)).toBe(true);
  expect(() => validateToolArgs('turn_complete', { ...args, text: 'Public reply', clientKey: 'schema' })).not.toThrow();
  expect(() => validateToolArgs('turn_claim', { ...args, ownerId: 'forged', clientKey: 'schema' })).toThrow();
});
