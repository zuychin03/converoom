import { beforeEach, afterEach, it, expect } from 'vitest';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import type { Actor, Core, Room, Seat, Store, ToolArgs } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let store: Store, core: Core;
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
const connection = (principalId: string, product: string): Actor => {
  store.put('bridge', 'hash-' + principalId, { kind: 'agent', principalId, ownerId: 'owner', product, createdAt: Date.now() });
  return { kind: 'agent', principalId, ownerId: 'owner' };
};
beforeEach(() => { store = createStore(':memory:'); core = createCore(store); });
afterEach(() => store.close());

it('gives an agent that names no product a seat for the product its connection was registered as', async () => {
  const opencode = connection('p-opencode', 'opencode'), claude = connection('p-claude', 'claude');
  const room = await call<Room>('room_create', { title: 'Products', objective: 'Seat the right product' }, opencode);
  expect(store.get<Seat>('seat', String(room.hostSeatId))).toMatchObject({ product: 'opencode', name: 'Host' });
  expect(await call<Seat>('room_join', { roomId: room.id, name: 'Claude' }, claude)).toMatchObject({ product: 'claude' });
});

it('keeps a product the agent names, and codex for an agent with no registered connection', async () => {
  const opencode = connection('p-opencode', 'opencode');
  const room = await call<Room>('room_create', { title: 'Named', objective: 'Keep the named product', product: 'cursor' }, opencode);
  expect(store.get<Seat>('seat', String(room.hostSeatId))).toMatchObject({ product: 'cursor' });
  const loose: Actor = { kind: 'agent', principalId: 'p-loose', ownerId: 'owner' };
  const other = await call<Room>('room_create', { title: 'Loose', objective: 'Fall back to codex' }, loose);
  expect(store.get<Seat>('seat', String(other.hostSeatId))).toMatchObject({ product: 'codex' });
});
