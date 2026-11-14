import { beforeEach, afterEach, it, expect } from 'vitest';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import {
  OPENCODE_POLL_MS, OPENCODE_POST_TIMEOUT_MS, WAKE_GIVE_UP_MS, planPushes, planWakes, recordOpenCodeInbox, recordOpenCodePost,
  type Attachment, type OpenCodeAction, type OpenCodeServerState,
} from '../packages/core/src/attachments.js';
import type { Actor, Core, Room, Seat, Store, ToolArgs } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
const SESSION = 'ses_e2b26ac8cffeQgLalD4VBfmHoi';
let store: Store, core: Core, start: number;
const ready: OpenCodeServerState = { ready: true };
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
const plan = (at: number, server = ready): OpenCodeAction[] =>
  planPushes(store, at, { connected: () => false, lastSeen: () => undefined, since: start }, server).actions;
const attachment = (seat: Seat) => store.get<Attachment>('attachment', seat.id);
const ended = (room: Room) => store.events(room.id).filter((e) => e.type === 'seat.attachment_ended').map((e) => e.data.reason);
beforeEach(() => { store = createStore(':memory:'); core = createCore(store); start = Date.now(); });
afterEach(() => store.close());

async function fixture() {
  const room = await call<Room>('room_create', { title: 'OpenCode push', objective: 'Wake an attached OpenCode session' });
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'opencode', mode: 'polling', name: 'OpenCode' });
  const agent: Actor = { kind: 'agent', principalId: seat.principalId, ownerId: seat.ownerId, sessionId: SESSION };
  return { room, seat, agent };
}
type Attached = Awaited<ReturnType<typeof attached>>;
async function attached() {
  const f = await fixture();
  await call('push_bridge_enable', { bridge: 'opencode' });
  const request = await call<ToolArgs>('seat_attach', { roomId: f.room.id }, f.agent);
  await call('permission_grant', { requestId: request.id });
  const [check] = plan(start);
  expect(check).toMatchObject({ type: 'post', kind: 'check', sessionId: SESSION, roomId: f.room.id, seatId: f.seat.id });
  recordOpenCodePost(store, f.seat.id, SESSION, (check as { wakeId: string }).wakeId, { inboxId: 'msg_check' });
  await call('room_inbox', { roomId: f.room.id }, f.agent);
  expect(attachment(f.seat)).toMatchObject({ status: 'attached', tested: true });
  expect(plan(start + 1)).toEqual([{ type: 'withdraw', id: expect.any(String), sessionId: SESSION, inboxId: 'msg_check' }]);
  return f;
}
const mention = (f: Attached, at: number) =>
  call('room_post', { roomId: f.room.id, text: 'Over to you', mentions: [{ seatId: f.seat.id, intent: 'question' }] }).then(() => {
    const [post] = plan(at);
    expect(post).toMatchObject({ type: 'post', kind: 'room' });
    return (post as { wakeId: string }).wakeId;
  });

it('attaches a polling OpenCode seat only from a session that came through Converoom\'s OpenCode server', async () => {
  const { room, seat, agent } = await fixture();
  await expect(call('seat_attach', { roomId: room.id }, agent)).rejects.toThrow(/converoom bridge enable opencode/);
  await call('push_bridge_enable', { bridge: 'opencode' });
  for (const sessionId of [undefined, '6f1c1c9e-6c55-4a5e-9f1d-2b1c3d4e5f60'])
    await expect(call('seat_attach', { roomId: room.id }, { ...agent, sessionId })).rejects.toThrow(/converoom opencode/);
  const claude = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', mode: 'polling', name: 'Claude' });
  await call('push_bridge_enable', { bridge: 'claude' });
  await expect(call('seat_attach', { roomId: room.id }, { kind: 'agent', principalId: claude.principalId, ownerId: 'owner', sessionId: SESSION }))
    .rejects.toThrow(/Restart Claude Code/);
  const request = await call<ToolArgs>('seat_attach', { roomId: room.id }, agent);
  expect(request).toMatchObject({ action: 'seat_attach', scope: { seatId: seat.id, bridge: 'opencode', sessionId: SESSION },
    summary: expect.stringContaining('OpenCode session') });
});

it('posts the test wake once, tracks it until it leaves the inbox, and counts the session\'s inbox read as the acknowledgement', async () => {
  const { room, seat, agent } = await fixture();
  await call('push_bridge_enable', { bridge: 'opencode' });
  await call('permission_grant', { requestId: (await call<ToolArgs>('seat_attach', { roomId: room.id }, agent)).id });
  const [post] = plan(start);
  const wakeId = (post as { wakeId: string }).wakeId;
  expect(plan(start + 1000)).toEqual([]);
  recordOpenCodePost(store, seat.id, SESSION, wakeId, { inboxId: 'msg_1' });
  expect(plan(start + OPENCODE_POLL_MS - 1)).toEqual([]);
  expect(plan(start + OPENCODE_POLL_MS)).toEqual([{ type: 'poll', sessionId: SESSION, wakeId, seatId: seat.id, inboxId: 'msg_1' }]);
  recordOpenCodeInbox(store, seat.id, wakeId, 'pending', start + OPENCODE_POLL_MS);
  expect(plan(start + 2 * OPENCODE_POLL_MS)).toMatchObject([{ type: 'poll' }]);
  recordOpenCodeInbox(store, seat.id, wakeId, 'gone', start + 2 * OPENCODE_POLL_MS);
  expect(attachment(seat)?.wake).toMatchObject({ inboxId: 'msg_1', deliveredAt: start + 2 * OPENCODE_POLL_MS });
  expect(plan(start + 3 * OPENCODE_POLL_MS)).toEqual([]);
  await call('room_inbox', { roomId: room.id }, agent);
  expect(attachment(seat)).toMatchObject({ status: 'attached', tested: true });
  expect(attachment(seat)?.wake).toBeUndefined();
  expect(plan(start + 4 * OPENCODE_POLL_MS)).toEqual([]);
});

it('never re-sends a wake that a busy session still holds, and pauses push only when a delivered wake goes unread', async () => {
  const f = await attached();
  const wakeId = await mention(f, start + 10000);
  recordOpenCodePost(store, f.seat.id, SESSION, wakeId, { inboxId: 'msg_2' });
  for (let t = start + 10000 + OPENCODE_POLL_MS; t < start + 10000 + 10 * WAKE_GIVE_UP_MS; t += OPENCODE_POLL_MS) {
    for (const a of plan(t)) expect(a.type).toBe('poll');
    recordOpenCodeInbox(store, f.seat.id, wakeId, 'pending', t);
  }
  expect(attachment(f.seat)).toMatchObject({ status: 'attached' });
  const delivered = start + 10000 + 10 * WAKE_GIVE_UP_MS;
  recordOpenCodeInbox(store, f.seat.id, wakeId, 'gone', delivered);
  expect(plan(delivered + WAKE_GIVE_UP_MS - 1)).toEqual([]);
  expect(attachment(f.seat)?.status).toBe('attached');
  expect(plan(delivered + WAKE_GIVE_UP_MS)).toEqual([]);
  expect(attachment(f.seat)).toMatchObject({ status: 'suspended', reason: expect.stringMatching(/did not read its inbox/) });
  await call('room_inbox', { roomId: f.room.id }, { ...f.agent, sessionId: 'ses_someOtherSession1' });
  expect(attachment(f.seat)?.status).toBe('suspended');
  await call('room_inbox', { roomId: f.room.id }, f.agent);
  expect(attachment(f.seat)?.status).toBe('attached');
});

it('withdraws a wake still in the inbox once it stops mattering: nothing due, read elsewhere, answered late or detached', async () => {
  const f = await attached();
  await call('turn_request', { roomId: f.room.id, seatId: f.seat.id, prompt: 'Review the plan' });
  const [post] = plan(start + 10000);
  const wakeId = (post as { wakeId: string }).wakeId;
  recordOpenCodePost(store, f.seat.id, SESSION, wakeId, { inboxId: 'msg_turn' });
  const [turn] = store.list<{ id: string }>('turn', { seatId: f.seat.id, status: ['queued'] });
  await call('turn_cancel', { roomId: f.room.id, turnId: turn!.id });
  expect(plan(start + 20000)).toEqual([{ type: 'withdraw', id: wakeId, sessionId: SESSION, inboxId: 'msg_turn' }]);
  expect(attachment(f.seat)?.wake).toBeUndefined();

  const second = await mention(f, start + 30000);
  recordOpenCodePost(store, f.seat.id, SESSION, second, { inboxId: 'msg_read' });
  await call('room_inbox', { roomId: f.room.id }, { ...f.agent, sessionId: 'ses_someOtherSession1' });
  expect(plan(start + 31000)).toEqual([{ type: 'withdraw', id: second, sessionId: SESSION, inboxId: 'msg_read' }]);

  const third = await mention(f, start + 40000);
  await call('room_inbox', { roomId: f.room.id }, f.agent);
  recordOpenCodePost(store, f.seat.id, SESSION, third, { inboxId: 'msg_late' });
  expect(plan(start + 41000)).toEqual([{ type: 'withdraw', id: third, sessionId: SESSION, inboxId: 'msg_late' }]);

  const fourth = await mention(f, start + 50000);
  recordOpenCodePost(store, f.seat.id, SESSION, fourth, { inboxId: 'msg_detach' });
  await call('seat_detach', { roomId: f.room.id, seatId: f.seat.id });
  expect(plan(start + 51000, { ready: false })).toEqual([]);
  expect(plan(start + 52000)).toEqual([{ type: 'withdraw', id: fourth, sessionId: SESSION, inboxId: 'msg_detach' }]);
  expect(ended(f.room)).toEqual([expect.stringMatching(/owner detached/i)]);
});

it('ends the attachment when OpenCode no longer has the session, and pauses push when it refuses a wake', async () => {
  const cases: [(f: Attached, wakeId: string) => void, RegExp, 'ended' | 'suspended'][] = [
    [(f, w) => recordOpenCodePost(store, f.seat.id, SESSION, w, { status: 404, message: 'Session not found' }), /session was deleted/, 'ended'],
    [(f, w) => { recordOpenCodePost(store, f.seat.id, SESSION, w, { inboxId: 'msg_x' }); recordOpenCodeInbox(store, f.seat.id, w, 'missing'); },
      /session was deleted/, 'ended'],
    [(f, w) => recordOpenCodePost(store, f.seat.id, SESSION, w, { status: 500, message: 'Internal error' }), /refused the wake \(500\)/, 'suspended'],
  ];
  for (const [act, reason, outcome] of cases) {
    const f = await attached();
    act(f, await mention(f, start + 10000));
    if (outcome === 'ended') expect(ended(f.room)).toEqual([expect.stringMatching(reason)]);
    else expect(attachment(f.seat)).toMatchObject({ status: 'suspended', reason: expect.stringMatching(reason) });
  }
});

it('posts again when a post gets no answer, waits while the server is down, and pauses push when it cannot start', async () => {
  const f = await attached();
  const lost = await mention(f, start + 10000);
  expect(plan(start + 10000 + OPENCODE_POST_TIMEOUT_MS - 1)).toEqual([]);
  expect(plan(start + 10000 + OPENCODE_POST_TIMEOUT_MS)).toEqual([]);
  const [again] = plan(start + 10001 + OPENCODE_POST_TIMEOUT_MS);
  expect(again).toMatchObject({ type: 'post', kind: 'room' });
  expect((again as { wakeId: string }).wakeId).not.toBe(lost);
  recordOpenCodePost(store, f.seat.id, SESSION, lost, { inboxId: 'msg_stale' });
  expect(plan(start + 50000, { ready: false })).toEqual([]);
  expect(attachment(f.seat)?.status).toBe('attached');
  expect(plan(start + 60000, { ready: false, failure: 'OpenCode 2.0.1 is too old; Converoom needs 2.1 or later' })).toEqual([]);
  expect(attachment(f.seat)).toMatchObject({ status: 'suspended', reason: expect.stringMatching(/too old/) });
  expect(plan(start + 70000)).toEqual([{ type: 'withdraw', id: lost, sessionId: SESSION, inboxId: 'msg_stale' }]);
});

it('leaves OpenCode attachments out of the Claude Code channel plan', async () => {
  const f = await attached();
  await mention(f, start + 10000);
  expect(planWakes(store, start + 20000, { connected: () => true, lastSeen: () => undefined, since: start })).toEqual([]);
});
