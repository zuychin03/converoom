import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import { planWakes, SESSION_GRACE_MS, WAKE_GIVE_UP_MS, WAKE_RESENDS_MS, type Attachment } from '../packages/core/src/attachments.js';
import { TOOL_DEFINITIONS, validateToolArgs } from '../packages/mcp/src/tools.js';
import type { Actor, Core, Room, Seat, Store, ToolArgs } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let store: Store, core: Core, start: number;
const sessions = { live: new Set<string>(), seen: new Map<string, number>() };
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
const plan = (at: number) => planWakes(store, at, {
  connected: (id) => sessions.live.has(id), lastSeen: (id) => sessions.seen.get(id), since: start });
const attachment = (seat: Seat) => store.get<Attachment>('attachment', seat.id);
const types = (room: Room) => store.events(room.id).map((e) => e.type);
const ended = (room: Room) => store.events(room.id).filter((e) => e.type === 'seat.attachment_ended').map((e) => e.data.reason);
beforeEach(() => {
  store = createStore(':memory:');
  core = createCore(store);
  start = Date.now();
  sessions.live = new Set(['s1']);
  sessions.seen = new Map();
});
afterEach(() => { vi.restoreAllMocks(); store.close(); });

async function fixture() {
  const room = await call<Room>('room_create', { title: 'Push bridge', objective: 'Wake an attached Claude Code session' });
  const seat = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', mode: 'polling', name: 'Claude' });
  const agent: Actor = { kind: 'agent', principalId: seat.principalId, ownerId: seat.ownerId, sessionId: 's1' };
  return { room, seat, agent };
}
type Attached = Awaited<ReturnType<typeof attached>>;
async function attached() {
  const f = await fixture();
  await call('push_bridge_enable', { bridge: 'claude' });
  const request = await call<ToolArgs>('seat_attach', { roomId: f.room.id }, f.agent);
  await call('permission_grant', { requestId: request.id });
  expect(plan(start)).toMatchObject([{ kind: 'check' }]);
  await call('room_inbox', { roomId: f.room.id }, f.agent);
  return f;
}
const mention = (room: Room, seat: Seat, actor = owner) =>
  call('room_post', { roomId: room.id, text: 'Over to you', mentions: [{ seatId: seat.id, intent: 'question' }] }, actor);

it('keeps the Claude Code push bridge off until the owner enables it, for polling Claude seats with a session', async () => {
  const { room, agent } = await fixture();
  await expect(call('seat_attach', { roomId: room.id }, agent)).rejects.toThrow(/converoom bridge enable claude/);
  await expect(call('push_bridge_enable', { bridge: 'claude' }, agent)).rejects.toThrow();
  await expect(call('push_bridge_enable', { bridge: 'cursor' })).rejects.toThrow();
  await call('push_bridge_enable', { bridge: 'claude' });
  expect(store.get('push_bridge', 'claude')).toMatchObject({ enabled: true });
  await expect(call('seat_attach', { roomId: room.id }, { ...agent, sessionId: undefined })).rejects.toThrow(/session/);
  const codex = await call<Seat>('seat_add', { roomId: room.id, product: 'codex', mode: 'polling', name: 'Codex' });
  await expect(call('seat_attach', { roomId: room.id }, { kind: 'agent', principalId: codex.principalId, ownerId: codex.ownerId, sessionId: 's9' }))
    .rejects.toThrow(/Claude Code/);
  expect(store.list('attachment')).toEqual([]);
});

it('attaches a session only after the owner approves, then sends one test wake that the session\'s inbox read confirms', async () => {
  const { room, seat, agent } = await fixture();
  await call('push_bridge_enable', { bridge: 'claude' });
  const stale = await call<ToolArgs>('seat_attach', { roomId: room.id, clientKey: 'attach' }, { ...agent, sessionId: 's0' });
  const request = await call<ToolArgs>('seat_attach', { roomId: room.id, clientKey: 'attach' }, agent);
  expect(request.id).not.toBe(stale.id);
  expect(request).toMatchObject({ action: 'seat_attach', status: 'pending', ownerId: 'owner', scope: { seatId: seat.id, bridge: 'claude', sessionId: 's1' } });
  expect(await call<ToolArgs>('seat_attach', { roomId: room.id }, agent)).toMatchObject({ id: request.id });
  expect(attachment(seat)).toBeUndefined();
  expect(plan(start)).toEqual([]);
  expect(store.get('permission', String(stale.id))).toMatchObject({ status: 'cancelled' });
  await expect(call('permission_grant', { requestId: stale.id })).rejects.toThrow(/expired or resolved/);
  await call('permission_grant', { requestId: request.id });
  expect(attachment(seat)).toMatchObject({ status: 'attached', bridge: 'claude', sessionId: 's1', requestId: request.id, tested: false });
  expect(await call<ToolArgs>('seat_attach', { roomId: room.id }, agent)).toMatchObject({ status: 'attached', sessionId: 's1' });
  const [check] = plan(start);
  expect(check).toMatchObject({ sessionId: 's1', roomId: room.id, seatId: seat.id, kind: 'check', attempt: 1 });
  expect(Object.keys(check!).sort()).toEqual(['attempt', 'kind', 'roomId', 'seatId', 'sessionId', 'wakeId']);
  expect(plan(start + 1000)).toEqual([]);
  await call('room_inbox', { roomId: room.id }, agent);
  expect(attachment(seat)).toMatchObject({ status: 'attached', tested: true });
  expect(attachment(seat)?.wake).toBeUndefined();
  expect(types(room)).toEqual(expect.arrayContaining(['permission.requested', 'permission.granted', 'seat.attached', 'seat.attachment_tested']));
});

it('wakes for owner messages, and for peer requests under the room\'s peer-wake policy, one wake at a time after the cooldown', async () => {
  const { room, seat, agent } = await attached();
  await mention(room, seat);
  expect(plan(start + 10000)).toMatchObject([{ kind: 'room', attempt: 1, seatId: seat.id }]);
  await mention(room, seat);
  expect(plan(start + 11000)).toEqual([]);
  await call('room_inbox', { roomId: room.id }, agent);
  await mention(room, seat);
  expect(plan(start + 12000)).toEqual([]);
  expect(plan(start + 15000)).toMatchObject([{ kind: 'room', attempt: 1 }]);
  await call('room_inbox', { roomId: room.id }, agent);

  const codex = await call<Seat>('seat_add', { roomId: room.id, product: 'codex', mode: 'polling', name: 'Codex' });
  const peer: Actor = { kind: 'agent', principalId: codex.principalId, ownerId: codex.ownerId };
  await call('policy_update', { roomId: room.id, policy: { peerWake: false } });
  await mention(room, seat, peer);
  expect(plan(start + 30000)).toEqual([]);
  await call('policy_update', { roomId: room.id, policy: { peerWake: true } });
  expect(plan(start + 31000)).toMatchObject([{ kind: 'room' }]);
});

it('re-sends an unanswered wake with backoff, falls back to polling with the reason, and resumes on the same session\'s next inbox read', async () => {
  const { room, seat, agent } = await attached();
  await mention(room, seat);
  let t = start + 10000;
  const [first] = plan(t);
  expect(plan(t + WAKE_RESENDS_MS[0]! - 1)).toEqual([]);
  for (const [i, gap] of WAKE_RESENDS_MS.entries()) {
    t += gap;
    expect(plan(t)).toMatchObject([{ attempt: i + 2, wakeId: first!.wakeId }]);
  }
  expect(plan(t + WAKE_GIVE_UP_MS - 1)).toEqual([]);
  expect(plan(t + WAKE_GIVE_UP_MS)).toEqual([]);
  expect(attachment(seat)).toMatchObject({ status: 'suspended', reason: expect.stringMatching(/no inbox read/i) });
  expect(types(room)).toContain('seat.attachment_suspended');

  await mention(room, seat);
  expect(plan(t + WAKE_GIVE_UP_MS + 60000)).toEqual([]);
  await call('room_inbox', { roomId: room.id }, { ...agent, sessionId: 's2' });
  expect(attachment(seat)).toMatchObject({ status: 'suspended' });
  await call('room_inbox', { roomId: room.id }, agent);
  expect(attachment(seat)).toMatchObject({ status: 'attached' });
  expect(types(room)).toContain('seat.attachment_resumed');
});

it('holds wakes while the session is disconnected and ends the attachment once the grace period passes', async () => {
  const { room, seat } = await attached();
  sessions.live.clear();
  sessions.seen.set('s1', start + 10000);
  await mention(room, seat);
  expect(plan(start + 20000)).toEqual([]);
  expect(attachment(seat)?.wake).toBeUndefined();
  sessions.live.add('s1');
  expect(plan(start + 21000)).toMatchObject([{ attempt: 1 }]);
  sessions.live.clear();
  sessions.seen.set('s1', start + 22000);
  expect(plan(start + 22000 + SESSION_GRACE_MS)).toEqual([]);
  expect(attachment(seat)).toBeDefined();
  expect(plan(start + 22001 + SESSION_GRACE_MS)).toEqual([]);
  expect(attachment(seat)).toBeUndefined();
  expect(ended(room)).toEqual([expect.stringMatching(/session ended/i)]);
});

it('ends an attachment when the seat leaves, the room closes, the bridge is turned off, the credential is revoked or either side detaches', async () => {
  const cases: [(f: Attached) => unknown, RegExp][] = [
    [(f) => call('room_leave', { roomId: f.room.id }, f.agent), /seat left/i],
    [(f) => call('room_close', { roomId: f.room.id }), /room closed/i],
    [() => call('push_bridge_disable', { bridge: 'claude' }), /turned off/i],
    [(f) => store.put('revoked', f.seat.principalId, true), /revoked/i],
    [(f) => call('seat_detach', { roomId: f.room.id, seatId: f.seat.id }), /owner detached/i],
    [(f) => call('seat_detach', { roomId: f.room.id }, f.agent), /agent detached/i],
  ];
  for (const [act, reason] of cases) {
    const f = await attached();
    await act(f);
    plan(start + 10000);
    expect(attachment(f.seat)).toBeUndefined();
    expect(ended(f.room)).toEqual([expect.stringMatching(reason)]);
  }
});

it('wakes once for a queued turn and once for a queued directive', async () => {
  const { room, seat, agent } = await attached();
  await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Review the plan' });
  expect(plan(start + 10000)).toMatchObject([{ kind: 'room' }]);
  await call('room_inbox', { roomId: room.id }, agent);
  expect(plan(start + 20000)).toEqual([]);
  await call('room_barge_in', { roomId: room.id, text: 'Prefer the smaller change', seatIds: [seat.id] });
  expect(plan(start + 30000)).toMatchObject([{ kind: 'room' }]);
  expect((await call<ToolArgs>('room_inbox', { roomId: room.id }, agent)).ownerDirectives).toHaveLength(1);
  expect(plan(start + 40000)).toEqual([]);
});

it('wakes for a turn queued in the same millisecond as the last inbox read', async () => {
  const { room, seat, agent } = await attached();
  vi.spyOn(Date, 'now').mockReturnValue(Date.now());
  await call('room_inbox', { roomId: room.id }, agent);
  await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Asked straight after the read' });
  vi.restoreAllMocks();
  expect(plan(start + 10000)).toMatchObject([{ kind: 'room' }]);
});

it('lists the attach and detach tools for agents', () => {
  for (const name of ['seat_attach', 'seat_detach']) expect(TOOL_DEFINITIONS.some((t) => t.name === name)).toBe(true);
  expect(() => validateToolArgs('seat_attach', { roomId: 'room', clientKey: 'attach' })).not.toThrow();
  expect(() => validateToolArgs('seat_detach', { roomId: 'room', seatId: 'seat', clientKey: 'detach' })).not.toThrow();
  expect(() => validateToolArgs('seat_attach', { roomId: 'room', clientKey: 'attach', sessionId: 'forged' })).toThrow();
});
