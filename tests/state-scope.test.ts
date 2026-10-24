import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, humanIdentity } from '../apps/daemon/src/server.js';
import type { Actor, Room, Seat, ToolArgs, Turn } from '../packages/shared/src/contracts.js';

async function paired() {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-scope-'));
  const runtime = await createRuntime(dir, { noScheduler: true });
  const server = await createServer(runtime, { port: 0, pairingCode: 'scope-fixture' });
  const pair = await fetch(server.url + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ code: 'scope-fixture' }) });
  const close = async () => { await server.close(); await runtime.stop(); await rm(dir, { recursive: true, force: true }); };
  return { runtime, server, cookie: pair.headers.get('set-cookie')!.split(';')[0], close };
}
const ids = (list: Array<{ id: unknown }>) => list.map((item) => String(item.id)).sort();

it('serves the selected room\'s whole history and records however busy other rooms are, and from elsewhere only approvals and running turns', async () => {
  const { runtime, server, cookie, close } = await paired();
  try {
    const owner = humanIdentity(runtime), store = runtime.core.store;
    const call = <T = ToolArgs>(name: string, args: ToolArgs, actor: Actor = owner) => runtime.core.dispatch(actor, name, args) as Promise<T>;
    const earlier = await call<Room>('room_create', { title: 'Earlier', objective: 'Keep its history' });
    const add = (args: ToolArgs) => call<Seat>('seat_add', { roomId: earlier.id, ...args });
    const reviewer = await add({ product: 'claude', name: 'Reviewer' }), tester = await add({ product: 'opencode', name: 'Tester' });
    const lead = await add({ product: 'codex', mode: 'managed', name: 'Lead' });
    for (const seat of [reviewer, tester, lead]) await call('seat_consent', { roomId: earlier.id, seatId: seat.id, consent: true });
    const agent = (seat: Seat): Actor => ({ kind: 'agent', principalId: seat.principalId, ownerId: owner.ownerId });
    await call('room_post', { roomId: earlier.id, text: 'Opening position', mentions: [{ seatId: reviewer.id, intent: 'question' }] });
    const done = await call<Turn>('turn_request', { roomId: earlier.id, seatId: reviewer.id, prompt: 'Review it' });
    await call('turn_claim', { roomId: earlier.id, turnId: done.id }, agent(reviewer));
    await call('turn_complete', { roomId: earlier.id, turnId: done.id, text: 'Reviewed' }, agent(reviewer));
    const running = await call<Turn>('turn_request', { roomId: earlier.id, seatId: tester.id, prompt: 'Test it' });
    await call('turn_claim', { roomId: earlier.id, turnId: running.id }, agent(tester));
    const waiting = await call<Turn>('turn_request', { roomId: earlier.id, seatId: lead.id, prompt: 'Build it' });
    const busy = await call<Room>('room_create', { title: 'Busy', objective: 'Fill any window of recent events' });
    store.transaction(() => { for (let i = 0; i < 1100; i++) store.append(busy.id, 'fixture', 'owner', { i }); });
    const state = async (room?: string) =>
      (await fetch(server.url + '/api/state' + (room ? '?room=' + encodeURIComponent(room) : ''), { headers: { cookie } })).json();

    const selected = await state(earlier.id);
    expect(selected.events.map((e: { id: string }) => e.id)).toEqual(store.events(earlier.id, 0, 1000).map((e) => e.id));
    expect(selected.rooms.find((r: Room) => r.id === earlier.id)).toMatchObject({ messageCount: 2 });
    expect(ids(selected.turns)).toEqual(ids(store.list<Turn>('turn', { roomId: earlier.id })));
    expect(ids(selected.interactions)).toEqual(ids(store.list<{ id: string }>('interaction', { roomId: earlier.id })));
    expect(ids(selected.seats)).toEqual(ids([reviewer, tester, lead]));
    expect(ids(selected.permissions)).toEqual([String(waiting.permissionRequestId)]);

    const elsewhere = await state(busy.id);
    const last = store.get<Room>('room', busy.id)!.seq;
    expect(elsewhere.events.map((e: { seq: number }) => e.seq)).toEqual(Array.from({ length: 1000 }, (_, i) => last - 999 + i));
    expect(elsewhere.events.every((e: { roomId: string }) => e.roomId === busy.id)).toBe(true);
    expect(ids(elsewhere.turns)).toEqual([running.id]);
    expect(ids(elsewhere.permissions)).toEqual([String(waiting.permissionRequestId)]);
    expect(elsewhere.interactions).toEqual([]);
    expect(elsewhere.seats).toEqual([]);
    const latest = store.events(earlier.id, store.get<Room>('room', earlier.id)!.seq - 1, 1)[0]!;
    expect(elsewhere.rooms.find((r: Room) => r.id === earlier.id)).toMatchObject({ lastEventAt: latest.at });

    const none = await state();
    expect(none.events).toEqual([]);
    expect(ids(none.turns)).toEqual([running.id]);
    expect(ids(none.rooms)).toEqual(ids([earlier, busy]));
    const unknown = await state('missing-room');
    expect(unknown.events).toEqual([]);
    expect(ids(unknown.rooms)).toEqual(ids([earlier, busy]));
  } finally { await close(); }
}, 30000);

it('pages a room\'s earlier history before an event number for the paired browser only', async () => {
  const { runtime, server, cookie, close } = await paired();
  try {
    const store = runtime.core.store;
    const room = await runtime.core.dispatch(humanIdentity(runtime), 'room_create', { title: 'Long', objective: 'More than one page' }) as Room;
    store.transaction(() => { for (let i = 0; i < 1100; i++) store.append(room.id, 'fixture', 'owner', { i }); });
    const page = (before: string, headers: Record<string, string> = { cookie }) =>
      fetch(server.url + '/api/rooms/' + encodeURIComponent(room.id) + '/events?before=' + before, { headers });
    const seqs = async (before: string) => ((await (await page(before)).json()).events as Array<{ seq: number }>).map((e) => e.seq);
    const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
    expect(await seqs('102')).toEqual(range(1, 101));
    expect(await seqs('1102')).toEqual(range(102, 1101));
    expect(await seqs('5000')).toEqual(range(102, 1101));
    expect(await seqs('1')).toEqual([]);
    expect((await page('102', {})).status).toBe(401);
    expect((await page('0')).status).toBe(400);
    expect((await page('next')).status).toBe(400);
    expect((await fetch(server.url + '/api/rooms/missing/events?before=5', { headers: { cookie } })).status).toBe(404);
  } finally { await close(); }
}, 30000);
