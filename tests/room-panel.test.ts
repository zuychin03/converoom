import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createStore } from '../packages/store/src/index.js';
import { createCore, READ_COMMANDS } from '../packages/core/src/index.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, issueBridgeCredential } from '../apps/daemon/src/server.js';
import type { Actor, Core, Room, Seat, Store, ToolArgs, Turn } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
const PANEL = 'ui://converoom/room-panel.html', MIME = 'text/html;profile=mcp-app';
let store: Store, core: Core;
const call = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => core.dispatch(actor, name, args) as Promise<T>;
beforeEach(() => { store = createStore(':memory:'); core = createCore(store); });
afterEach(() => store.close());

it('shows a seat its room, roster, waiting work, open requests and its owner\'s pending approvals without reading anything for it', async () => {
  const room = await call<Room>('room_create', { title: 'Panel room', objective: 'Pick a storage option' });
  const host = await call<Seat>('seat_add', { roomId: room.id, product: 'claude', mode: 'polling', name: 'Claude' });
  const other = await call<Seat>('seat_add', { roomId: room.id, product: 'codex', mode: 'polling', name: 'Codex' });
  const claude: Actor = { kind: 'agent', principalId: host.principalId, ownerId: 'owner' };
  await call('room_post', { roomId: room.id, text: 'Which storage option?', mentions: [{ seatId: host.id, intent: 'question' }] });
  await call('room_post', { roomId: room.id, text: 'Can you check B?', mentions: [{ seatId: other.id, intent: 'review' }], clientKey: 'ask' }, claude);
  const turn = await call<Turn>('turn_request', { roomId: room.id, seatId: host.id, prompt: 'Summarise the options' });
  const now = Date.now(), permission = (id: string, ownerId: string, status: string, expiresAt = now + 3600000) => store.put('permission', id,
    { id, roomId: room.id, ownerId, action: 'context_pin', scope: {}, scopeDigest: id, summary: 'Pin ' + id, status, expiresAt });
  permission('mine', 'owner', 'pending');
  permission('theirs', 'someone-else', 'pending');
  permission('granted', 'owner', 'granted');
  permission('expired', 'owner', 'pending', now - 1000);
  store.put('attachment', host.id, { id: host.id, roomId: room.id, seatId: host.id, principalId: host.principalId, ownerId: 'owner', bridge: 'claude',
    sessionId: 'session', requestId: 'request', status: 'suspended', since: now, tested: true, reason: 'No inbox read after 4 wake notices',
    wake: { id: 'wake', kind: 'room', attempts: 4, firstAt: now, lastAt: now } });
  const state = () => JSON.stringify([store.list('interaction'), store.list('turn'), store.list('attachment'), store.list('directive'), store.events(room.id)]);
  const before = state();

  const panel = await call<ToolArgs>('room_panel', { roomId: room.id }, claude);

  expect(state()).toBe(before);
  expect(READ_COMMANDS.has('room_panel')).toBe(true);
  expect(panel.room).toMatchObject({ id: room.id, title: 'Panel room', lifecycle: room.lifecycle, phase: room.phase });
  expect(panel.seat).toMatchObject({ id: host.id, name: 'Claude', mode: 'polling' });
  const roster = panel.roster as ToolArgs[];
  expect(roster.find((s) => s.id === host.id)).toMatchObject({ name: 'Claude', product: 'claude', you: true,
    push: { status: 'suspended', tested: true, attempts: 4, reason: 'No inbox read after 4 wake notices' } });
  expect(roster.find((s) => s.id === other.id)).toMatchObject({ name: 'Codex', you: false });
  expect(roster.find((s) => s.id === other.id)).not.toHaveProperty('push');
  const waiting = panel.waiting as { requests: ToolArgs[]; turns: ToolArgs[]; directives: number };
  expect(waiting.requests).toEqual([expect.objectContaining({ from: 'Owner', intent: 'question', status: 'stored' })]);
  expect(waiting.turns).toEqual([expect.objectContaining({ id: turn.id, status: turn.status })]);
  expect(waiting.directives).toBe(0);
  expect(JSON.stringify(panel)).not.toContain('Which storage option?');
  expect(panel.asked).toEqual([expect.objectContaining({ to: 'Codex', intent: 'review' })]);
  expect((panel.approvals as ToolArgs[]).map((p) => p.id)).toContain('mine');
  expect((panel.approvals as ToolArgs[]).map((p) => p.id)).not.toEqual(expect.arrayContaining(['theirs']));
  expect((panel.approvals as ToolArgs[]).map((p) => p.id)).not.toEqual(expect.arrayContaining(['granted']));
  expect((panel.approvals as ToolArgs[]).map((p) => p.id)).not.toEqual(expect.arrayContaining(['expired']));
  expect((panel.approvals as ToolArgs[]).find((p) => p.id === 'mine')).toEqual({ id: 'mine', action: 'context_pin', summary: 'Pin mine', expiresAt: now + 3600000 });
  expect(panel.budgets).toMatchObject({ messages: { used: 2, limit: 60 } });
  expect(panel.rooms).toEqual([expect.objectContaining({ id: room.id, title: 'Panel room' })]);
});

it('opens the connection\'s newest room when no room is named, and refuses a room the agent has no seat in', async () => {
  const agent: Actor = { kind: 'agent', principalId: 'agent-a', ownerId: 'owner' };
  const first = await call<Room>('room_create', { title: 'First', objective: 'One', clientKey: 'first' }, agent);
  const second = await call<Room>('room_create', { title: 'Second', objective: 'Two', clientKey: 'second' }, agent);
  const panel = await call<ToolArgs>('room_panel', {}, agent);
  expect((panel.room as ToolArgs).id).toBe(second.id);
  expect((panel.rooms as ToolArgs[]).map((r) => r.id)).toEqual([second.id, first.id]);
  await expect(call('room_panel', { roomId: first.id }, { ...agent, principalId: 'agent-b' })).rejects.toThrow();
  expect(await call('room_panel', {}, { ...agent, principalId: 'agent-c' })).toMatchObject({ room: null, rooms: [] });
});

it('offers the room panel only to clients that declare MCP Apps, serves its page, and returns the room and approvals links', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-panel-'));
  const runtime = await createRuntime(dir, { noScheduler: true }), server = await createServer(runtime, { port: 0, wakeTickMs: 0 });
  const clients: Client[] = [];
  try {
    await writeFile(join(dir, 'runtime.json'), JSON.stringify({ url: server.url }));
    await mkdir(join(dir, 'clients'));
    await writeFile(join(dir, 'clients', 'codex.json'), JSON.stringify(issueBridgeCredential(runtime, 'codex')));
    const connect = async (apps: boolean) => {
      const c = new Client({ name: 'fixture', version: '1.0' }, { capabilities: apps ? { extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [MIME] } } } : {} });
      await c.connect(new StdioClientTransport({ command: process.execPath,
        args: [join(process.cwd(), 'dist', 'cli.js'), 'mcp', '--client', 'codex', '--data-dir', dir], stderr: 'pipe' }));
      clients.push(c);
      return c;
    };
    const apps = await connect(true), plain = await connect(false);
    const ui = (tools: { name: string; _meta?: Record<string, unknown> }[]) =>
      tools.filter((t) => (t._meta?.ui as { resourceUri?: string } | undefined)?.resourceUri === PANEL).map((t) => t.name).sort();
    expect(ui((await apps.listTools()).tools)).toEqual(['room_create', 'room_join', 'room_panel']);
    expect(ui((await plain.listTools()).tools)).toEqual([]);
    expect((await plain.listTools()).tools.some((t) => t.name === 'room_panel')).toBe(true);
    expect((await apps.listResources()).resources).toContainEqual(expect.objectContaining({ uri: PANEL, mimeType: MIME }));
    expect((await plain.listResources()).resources.some((r) => r.uri === PANEL)).toBe(false);
    const page = (await apps.readResource({ uri: PANEL })).contents[0] as { mimeType: string; text: string };
    expect(page.mimeType).toBe(MIME);
    expect(page.text).toContain('ui/initialize');

    const result = async (name: string, args: ToolArgs) => {
      const r = await apps.callTool({ name, arguments: args });
      expect(r.isError).not.toBe(true);
      return (JSON.parse((r.content as { text: string }[])[0]!.text) as { result: ToolArgs }).result;
    };
    const room = await result('room_create', { title: 'Panel', objective: 'Show the panel', clientKey: 'create' });
    const appUrl = server.url + '/?room=' + encodeURIComponent(String(room.id));
    expect(room.appUrl).toBe(appUrl);
    expect(await result('room_join', { roomId: room.id, clientKey: 'join' })).toMatchObject({ appUrl });
    expect(await result('room_panel', { roomId: room.id })).toMatchObject({ appUrl, approvalsUrl: appUrl + '&view=approvals' });
  } finally {
    for (const c of clients) await c.close();
    await server.close();
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
