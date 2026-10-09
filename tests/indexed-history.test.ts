import { it, expect } from 'vitest';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import type { Actor, Event, ToolArgs } from '../packages/shared/src/contracts.js';
const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
it('keeps bounded global event pages in commit order and resumes an old retained cursor', async () => {
  const store = createStore(':memory:'), core = createCore(store);
  try {
    const room = await core.dispatch(owner, 'room_create', { title: 'Indexed', objective: 'Retained cursor' }) as ToolArgs;
    const first = store.events(String(room.id))[0];
    for (let i = 0; i < 1100; i++) store.append(String(room.id), 'fixture', 'owner', { i });
    const recent = store.recentEvents(3);
    expect(recent.map((e: Event) => e.data.i)).toEqual([1097, 1098, 1099]);
    const page = store.eventsAfter(first.id, 2);
    expect(page.map((e: Event) => e.data.i)).toEqual([0, 1]);
    expect(store.eventsAfter(page[1].id, 2).map((e: Event) => e.data.i)).toEqual([2, 3]);
    expect(store.eventsAfter(recent[2].id)).toEqual([]);
    expect(() => store.eventsAfter('unknown')).toThrow(/cursor/i);
    expect(store.eventCount(String(room.id), 'fixture')).toBe(1100);
    expect(store.eventCount(String(room.id), 'message')).toBe(0);
  } finally { store.close(); }
});
it('counts and filters room, seat, request and active status records without changing ordering', () => {
  const store = createStore(':memory:');
  try {
    store.put('turn', 'old', { id: 'old', roomId: 'a', seatId: 'first', status: 'completed' });
    store.put('turn', 'live', { id: 'live', roomId: 'a', seatId: 'second', status: 'running' });
    store.put('turn', 'other', { id: 'other', roomId: 'b', seatId: 'second', status: 'queued' });
    store.put('grant', 'g', { id: 'g', requestId: 'request' });
    expect(store.list<ToolArgs>('turn', { roomId: 'a' }).map((r) => r.id)).toEqual(['old', 'live']);
    expect(store.list<ToolArgs>('turn', { roomId: 'a', seatId: 'second', status: ['running', 'queued'] }).map((r) => r.id)).toEqual(['live']);
    expect(store.count('turn', { status: ['running', 'queued'] })).toBe(2);
    expect(store.count('turn', { roomId: 'a', status: ['queued'] })).toBe(0);
    expect(store.list<ToolArgs>('grant', { requestId: 'request' }).map((r) => r.id)).toEqual(['g']);
    store.put('turn', 'live', { id: 'live', roomId: 'a', seatId: 'second', status: 'completed' });
    expect(store.count('turn', { status: ['running'] })).toBe(0);
    expect(store.list('turn', { status: [] })).toEqual([]);
  } finally { store.close(); }
});
