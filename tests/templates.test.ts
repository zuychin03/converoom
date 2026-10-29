import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import { BUILT_IN_TEMPLATES } from '../packages/core/src/templates.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, issueBridgeCredential } from '../apps/daemon/src/server.js';
import { validateToolArgs } from '../packages/mcp/src/tools.js';
import type { Actor, Core, Room, RoomTemplate, Seat, Store, ToolArgs } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
const stranger: Actor = { kind: 'human', principalId: 'stranger', ownerId: 'stranger' };
let store: Store, core: Core;
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
const agentOf = (s: Seat): Actor => ({ kind: 'agent', principalId: s.principalId, ownerId: s.ownerId });
const events = (roomId: string, type: string) => store.events(roomId, 0, 1000).filter((e) => e.type === type);
beforeEach(() => { store = createStore(':memory:'); core = createCore(store); });
afterEach(() => store.close());

async function savedTemplate() {
  const r = await call<Room>('room_create', { title: 'Source', objective: 'Review the storage plan', workflow: 'coding' });
  await call('seat_add', { roomId: r.id, name: 'Builder', product: 'codex', mode: 'managed', profile: { model: 'gpt-fixture', effort: 'high' } });
  await call('seat_add', { roomId: r.id, name: 'Lead', product: 'claude', mode: 'polling', role: 'host' });
  await call('seat_add', { roomId: r.id, name: 'Watcher', product: 'cursor', mode: 'polling', role: 'observer' });
  await call('room_set_agenda', { roomId: r.id, agenda: '1. Agree checks\n2. Build\n3. Review' });
  await call('policy_update', { roomId: r.id, policy: { peerWake: false, maxMessages: 40 } });
  return call<RoomTemplate>('template_save', { roomId: r.id, name: 'Storage review', description: 'Build and review a storage change' });
}

it('lists the built-in templates and the owner\'s saved ones to the owner and their agents only', async () => {
  expect(BUILT_IN_TEMPLATES.length).toBeGreaterThanOrEqual(3);
  for (const t of BUILT_IN_TEMPLATES) {
    expect(t).toMatchObject({ builtIn: true, id: expect.stringMatching(/^builtin:/) });
    expect(t.slots.every((s) => s.profile === undefined && s.product === undefined)).toBe(true);
  }
  const saved = await savedTemplate();
  const listed = await call<RoomTemplate[]>('template_list', {});
  expect(listed.map((t) => t.id)).toEqual([...BUILT_IN_TEMPLATES.map((t) => t.id), saved.id]);
  const r = await call<Room>('room_create', { title: 'Agents', objective: 'Read templates' });
  const agent = await call<Seat>('seat_add', { roomId: r.id, name: 'Reader', product: 'claude', mode: 'polling' });
  expect((await call<RoomTemplate[]>('template_list', {}, agentOf(agent))).map((t) => t.id)).toContain(saved.id);
  expect((await call<RoomTemplate[]>('template_list', {}, stranger)).map((t) => t.id)).not.toContain(saved.id);
});

it('saves a room\'s roster as role slots with its products and profiles, its agenda and its lowered budgets', async () => {
  const saved = await savedTemplate();
  expect(saved).toMatchObject({
    name: 'Storage review', description: 'Build and review a storage change', ownerId: 'owner', workflow: 'coding',
    agenda: '1. Agree checks\n2. Build\n3. Review',
    policy: { peerWake: false, maxMessages: 40 },
    slots: [
      { name: 'Builder', role: 'member', mode: 'managed', product: 'codex', profile: { model: 'gpt-fixture', effort: 'high' } },
      { name: 'Lead', role: 'host', mode: 'polling', product: 'claude' },
      { name: 'Watcher', role: 'observer', mode: 'polling', product: 'cursor' },
    ],
  });
  expect(saved.builtIn).toBeUndefined();
  expect(Object.keys(saved.policy).sort()).toEqual(['maxMessages', 'peerWake']);
});

it('creates a room from a template with its agenda, turn policy, budgets and the owner\'s roster', async () => {
  const saved = await savedTemplate();
  const r = await call<Room>('room_create', { title: 'From template', objective: 'Ship the change', templateId: saved.id,
    seats: [{ product: 'codex', mode: 'managed', name: 'Builder', profile: { effort: 'max' } }, { product: 'claude', mode: 'polling', name: 'Lead', role: 'host' }] });
  expect(r).toMatchObject({ workflow: 'coding', template: { id: saved.id, name: 'Storage review' }, policy: { peerWake: false, maxMessages: 40, maxRounds: 6 } });
  const seats = store.list<Seat>('seat', { roomId: r.id });
  expect(seats.map((s) => [s.name, s.role, s.mode, s.profile])).toEqual([['Builder', 'member', 'managed', { effort: 'max' }], ['Lead', 'host', 'polling', undefined]]);
  expect(store.get<Room>('room', r.id)?.hostSeatId).toBe(seats[1]!.id);
  expect(events(r.id, 'agenda').map((e) => e.data)).toEqual([expect.objectContaining({ agenda: '1. Agree checks\n2. Build\n3. Review', templateId: saved.id })]);
  expect(store.get<Room>('room', r.id)?.rounds).toBeUndefined();
  expect(events(r.id, 'room.created')[0]?.data).toMatchObject({ template: { id: saved.id, name: 'Storage review' } });
  const builtIn = BUILT_IN_TEMPLATES[0]!;
  const plain = await call<Room>('room_create', { title: 'Built in', objective: 'Ask twice', templateId: builtIn.id });
  expect(plain).toMatchObject({ workflow: builtIn.workflow, template: { id: builtIn.id, name: builtIn.name }, policy: { peerWake: builtIn.policy.peerWake } });
});

it('gives an agent\'s room the template agenda and policy but leaves seating to the owner', async () => {
  const saved = await savedTemplate();
  const r = await call<Room>('room_create', { title: 'Lobby', objective: 'Seat an agent' });
  const agent = await call<Seat>('seat_add', { roomId: r.id, name: 'Planner', product: 'codex', mode: 'polling' });
  const created = await call<Room>('room_create', { title: 'Agent room', objective: 'Plan it', templateId: saved.id }, agentOf(agent));
  expect(created).toMatchObject({ template: { id: saved.id }, policy: { peerWake: false, maxMessages: 40 } });
  expect(store.list<Seat>('seat', { roomId: created.id }).map((s) => s.name)).toEqual(['Host']);
  expect(events(created.id, 'agenda')).toHaveLength(1);
  await expect(call('room_create', { title: 'Seated', objective: 'No', templateId: saved.id, seats: [{ product: 'codex', mode: 'managed' }] }, agentOf(agent)))
    .rejects.toMatchObject({ code: 'human_required' });
  await expect(call('room_create', { title: 'Missing', objective: 'No', templateId: 'builtin:none' })).rejects.toMatchObject({ code: 'template_not_found' });
  await expect(call('room_create', { title: 'Theirs', objective: 'No', templateId: saved.id }, stranger)).rejects.toMatchObject({ code: 'template_not_found' });
});

it('lets only the owner save and delete templates, and never a built-in one', async () => {
  const saved = await savedTemplate();
  const r = await call<Room>('room_create', { title: 'Agents', objective: 'Try to save' });
  const agent = await call<Seat>('seat_add', { roomId: r.id, name: 'Reader', product: 'claude', mode: 'polling' });
  await expect(call('template_save', { roomId: r.id, name: 'Mine' }, agentOf(agent))).rejects.toMatchObject({ code: 'human_required' });
  await expect(call('template_save', { roomId: r.id, name: 'Mine' }, stranger)).rejects.toMatchObject({ code: expect.stringMatching(/membership|owner/) });
  await expect(call('template_save', { roomId: r.id, name: '' })).rejects.toMatchObject({ code: 'invalid_argument' });
  await expect(call('template_delete', { templateId: saved.id }, agentOf(agent))).rejects.toMatchObject({ code: 'human_required' });
  await expect(call('template_delete', { templateId: saved.id }, stranger)).rejects.toMatchObject({ code: 'template_not_found' });
  await expect(call('template_delete', { templateId: BUILT_IN_TEMPLATES[0]!.id })).rejects.toMatchObject({ code: 'template_built_in' });
  expect(await call('template_delete', { templateId: saved.id })).toMatchObject({ id: saved.id });
  expect((await call<RoomTemplate[]>('template_list', {})).map((t) => t.id)).not.toContain(saved.id);
});

it('accepts the owner\'s seat names, roles and profiles only on the browser route', () => {
  const seats = [{ product: 'codex', mode: 'managed', name: 'Builder', role: 'host', profile: { model: 'gpt-fixture', effort: 'max' } }];
  expect(() => validateToolArgs('room_create', { title: 'T', objective: 'O', clientKey: 'k', templateId: 'builtin:second-opinion', seats }, true)).not.toThrow();
  expect(() => validateToolArgs('room_create', { title: 'T', objective: 'O', clientKey: 'k', seats }, false)).toThrow(/Unexpected seats/);
  expect(() => validateToolArgs('room_create', { title: 'T', objective: 'O', clientKey: 'k', templateId: 'builtin:second-opinion' }, false)).not.toThrow();
  expect(() => validateToolArgs('room_create', { title: 'T', objective: 'O', clientKey: 'k', seats: [{ ...seats[0], profile: { effort: 'huge' } }] }, true)).toThrow(/Invalid/);
  expect(() => validateToolArgs('template_list', {}, false)).not.toThrow();
});

it('routes profiles and template saving through the paired browser only, and returns templates with the state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-templates-http-'));
  const runtime = await createRuntime(join(dir, 'data'), { noScheduler: true });
  const server = await createServer(runtime, { port: 0, pairingCode: 'local-pair-code', controlToken: 'installation-fixture-token' });
  try {
    const headers = { host: new URL(server.url).host, origin: server.url };
    const pair = await server.app.inject({ method: 'POST', url: '/api/pair', headers, payload: { code: 'local-pair-code' } });
    const cookie = String(pair.headers['set-cookie']).split(';')[0];
    const session = await server.app.inject({ method: 'GET', url: '/api/session', headers: { ...headers, cookie } });
    const human = async (name: string, args: Record<string, unknown>) => (await server.app.inject({ method: 'POST', url: '/api/commands',
      headers: { ...headers, cookie, 'x-csrf-token': session.json().csrf }, payload: { name, args: { ...args, clientKey: name + Math.random() } } })).json();
    const room = (await human('room_create', { title: 'Browser', objective: 'Profiles over HTTP', templateId: 'builtin:second-opinion',
      seats: [{ product: 'codex', mode: 'managed', name: 'First opinion', profile: { effort: 'high' } }] })).result;
    expect(room.roster).toEqual([expect.objectContaining({ name: 'First opinion', profile: { effort: 'high' } })]);
    const seat = room.roster[0];
    expect((await human('seat_profile_set', { roomId: room.id, seatId: seat.id, profile: { model: 'gpt-fixture', effort: 'max' } })).result)
      .toMatchObject({ profile: { model: 'gpt-fixture', effort: 'max' } });
    const saved = (await human('template_save', { roomId: room.id, name: 'Twice' })).result;
    expect(saved.slots).toEqual([expect.objectContaining({ name: 'First opinion', product: 'codex', profile: { model: 'gpt-fixture', effort: 'max' } })]);
    const state = (await server.app.inject({ method: 'GET', url: '/api/state?room=' + room.id, headers: { ...headers, cookie } })).json();
    expect(state.templates.map((t: { id: string }) => t.id)).toEqual([...BUILT_IN_TEMPLATES.map((t) => t.id), saved.id]);
    expect(state.seats[0].profile).toEqual({ model: 'gpt-fixture', effort: 'max' });
    expect((await human('template_delete', { templateId: saved.id })).result).toMatchObject({ id: saved.id });
    const credential = issueBridgeCredential(runtime, 'codex');
    for (const [name, args] of [['seat_profile_set', { roomId: room.id, seatId: seat.id, profile: {} }], ['template_save', { roomId: room.id, name: 'X' }],
      ['template_delete', { templateId: 'x' }]] as const)
      expect((await server.app.inject({ method: 'POST', url: '/agent/commands', headers: { host: headers.host, authorization: 'Bearer ' + credential.token },
        payload: { name, args } })).statusCode).toBe(400);
    expect((await server.app.inject({ method: 'POST', url: '/agent/commands', headers: { host: headers.host, authorization: 'Bearer ' + credential.token },
      payload: { name: 'template_list', args: {} } })).json().result.map((t: { id: string }) => t.id)).toContain('builtin:second-opinion');
  } finally { await server.close(); await runtime.stop(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
});
