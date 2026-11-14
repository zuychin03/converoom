import { it, expect, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { CallToolResultSchema } from '@modelcontextprotocol/sdk/types.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, humanIdentity, issueBridgeCredential, VERSION } from '../apps/daemon/src/server.js';
import type { Attachment } from '../packages/core/src/attachments.js';
import type { Seat, ToolArgs } from '../packages/shared/src/contracts.js';

const FAKE = join(process.cwd(), 'tests', 'fixtures', 'opencode-serve.mjs');
vi.mock('../packages/adapters/src/process.js', async (original) => {
  const actual = await original<typeof import('../packages/adapters/src/process.js')>();
  return { ...actual, executable: async (name: string) => name === 'opencode' ? { command: process.execPath, args: [FAKE] } : actual.executable(name) };
});
const SESSION = 'ses_fakeSessionAAAA1111';

async function until<T>(read: () => T | undefined | false | Promise<T | undefined | false>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting');
    await sleep(50);
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-opencode-')), logFile = join(dir, 'fake.log');
  process.env.FAKE_OPENCODE_LOG = logFile;
  const runtime = await createRuntime(dir, { noScheduler: true });
  const server = await createServer(runtime, { port: 0, wakeTickMs: 50, controlToken: 'control', opencodeReadyMs: 15000 });
  await writeFile(join(dir, 'runtime.json'), JSON.stringify({ url: server.url, pid: process.pid, controlToken: 'control', version: VERSION, startedAt: Date.now() }));
  await mkdir(join(dir, 'clients'));
  const human = humanIdentity(runtime), clients: Client[] = [];
  const local = async (path: string, token = 'control') => {
    const r = await fetch(server.url + path, { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' });
    return { status: r.status, body: await r.json() as ToolArgs };
  };
  const fakeLog = async () => (await readFile(logFile, 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as ToolArgs);
  const mcp = async (nonce?: string) => {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined));
    const c = new Client({ name: 'opencode', version: '2.1.4' }, { capabilities: {} });
    await c.connect(new StdioClientTransport({ command: process.execPath, stderr: 'pipe',
      args: [join(process.cwd(), 'dist', 'cli.js'), 'mcp', '--client', 'opencode', '--data-dir', dir],
      env: { ...env, CONVEROOM_OPENCODE_SERVER: nonce ?? '' } }));
    clients.push(c);
    const call = async (name: string, args: ToolArgs) => {
      const r = await c.request({ method: 'tools/call', params: { name, arguments: args, _meta: { 'ai.opencode/sessionID': SESSION } } }, CallToolResultSchema);
      return { ok: r.isError !== true, value: JSON.parse((r.content as { text: string }[])[0]!.text) as ToolArgs };
    };
    return { c, call };
  };
  const close = async () => {
    for (const c of clients) await c.close();
    await server.close();
    await runtime.stop();
    delete process.env.FAKE_OPENCODE_LOG;
    // The fake server's working folder is the data folder, and Windows locks it until that process has exited.
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  };
  return { dir, runtime, server, human, local, fakeLog, mcp, close };
}

it('runs Converoom\'s own OpenCode server only while the bridge is on, behind a password of its own', async () => {
  const f = await fixture();
  try {
    expect((await f.local('/local/opencode', 'wrong')).status).toBe(401);
    expect(await f.local('/local/opencode')).toMatchObject({ status: 409, body: { error: { code: 'push_disabled' } } });
    await f.runtime.core.dispatch(f.human, 'push_bridge_enable', { bridge: 'opencode' });
    const { status, body: access } = await f.local('/local/opencode');
    expect(status).toBe(200);
    expect(access).toMatchObject({ url: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/), key: expect.any(String), version: '2.1.4' });
    expect((await f.local('/local/opencode')).body.url).toBe(access.url);
    expect((await f.fakeLog()).filter((e) => e.event === 'started')).toEqual([{ event: 'started', nonce: expect.any(String), password: true, autoupdate: 'off' }]);
    await until(async () => (await f.fakeLog()).some((e) => e.event === 'stdin_ended'), 5000);
    const basic = 'Basic ' + Buffer.from('opencode:' + String(access.key)).toString('base64');
    expect((await fetch(access.url + '/api/session')).status).toBe(401);
    expect((await fetch(access.url + '/api/session', { headers: { authorization: basic } })).status).toBe(200);
    expect((await f.local('/local/opencode/status')).body).toMatchObject({ enabled: true, running: true, version: '2.1.4', tested: '2.1.4' });

    await f.runtime.core.dispatch(f.human, 'push_bridge_disable', { bridge: 'opencode' });
    await until(async () => (await f.local('/local/opencode/status')).body.running === false);
    await until(() => fetch(String(access.url) + '/api/session').then(() => false, () => true));
  } finally {
    await f.close();
  }
}, 60000);

it('wakes an attached OpenCode session through that server, binding only sessions whose MCP process the server started', async () => {
  const f = await fixture();
  try {
    await f.runtime.core.dispatch(f.human, 'push_bridge_enable', { bridge: 'opencode' });
    await writeFile(join(f.dir, 'clients', 'opencode.json'), JSON.stringify(issueBridgeCredential(f.runtime, 'opencode')));
    await f.local('/local/opencode');
    const nonce = String((await f.fakeLog()).find((e) => e.event === 'started')?.nonce);
    const outside = await f.mcp();
    const inside = await f.mcp(nonce);
    expect(inside.c.getInstructions()).toContain('Converoom wake');
    expect(outside.c.getInstructions() ?? '').not.toContain('Converoom wake');

    const room = (await inside.call('room_create', { title: 'OpenCode room', objective: 'Wake the host', clientKey: 'create' })).value.result as ToolArgs;
    const seatId = String(room.hostSeatId);
    expect(f.runtime.core.store.get<Seat>('seat', seatId)).toMatchObject({ product: 'opencode', mode: 'polling' });
    const refused = await outside.call('seat_attach', { roomId: room.id, clientKey: 'attach-outside' });
    expect(refused).toMatchObject({ ok: false, value: { error: { code: 'session_required', message: expect.stringContaining('converoom opencode') } } });
    const request = (await inside.call('seat_attach', { roomId: room.id, clientKey: 'attach' })).value.result as ToolArgs;
    expect(request).toMatchObject({ status: 'pending', scope: { seatId, bridge: 'opencode', sessionId: SESSION } });
    await f.runtime.core.dispatch(f.human, 'permission_grant', { requestId: request.id });

    const post = await until(async () => (await f.fakeLog()).find((e) => e.path === `/api/session/${SESSION}/synthetic`));
    expect(post.body).toEqual({ text: expect.stringContaining(String(room.id)), description: 'Converoom wake',
      metadata: { converoomWake: expect.any(String) }, delivery: 'queue' });
    expect(JSON.stringify(post.body)).not.toContain('OpenCode room');
    const attachment = () => f.runtime.core.store.get<Attachment>('attachment', seatId);
    await until(() => attachment()?.wake?.inboxId);
    const access = (await f.local('/local/opencode')).body;
    await fetch(access.url + '/fake/deliver', { method: 'POST', body: JSON.stringify({ sessionID: SESSION }),
      headers: { authorization: 'Basic ' + Buffer.from('opencode:' + String(access.key)).toString('base64') } });
    await until(() => attachment()?.wake?.deliveredAt);
    await inside.call('room_inbox', { roomId: room.id });
    expect(attachment()).toMatchObject({ status: 'attached', tested: true });
    expect(attachment()?.wake).toBeUndefined();

    await f.runtime.core.dispatch(f.human, 'room_post', { roomId: room.id, text: 'Still there?', mentions: [{ seatId, intent: 'question' }] });
    const queued = await until(() => attachment()?.wake?.inboxId);
    await f.runtime.core.dispatch(f.human, 'push_bridge_disable', { bridge: 'opencode' });
    await until(async () => (await f.fakeLog()).some((e) => e.method === 'DELETE' && e.path === `/api/session/${SESSION}/inbox/${queued}`));
    await until(async () => (await f.local('/local/opencode/status')).body.running === false);

    await f.runtime.core.dispatch(f.human, 'push_bridge_enable', { bridge: 'opencode' });
    await f.local('/local/opencode');
    const restarted = String((await f.fakeLog()).filter((e) => e.event === 'started').at(-1)?.nonce);
    expect(restarted).not.toBe(nonce);
    expect(await inside.call('seat_attach', { roomId: room.id, clientKey: 'attach-stale' })).toMatchObject({ ok: false, value: { error: { code: 'session_required' } } });
    const reborn = await f.mcp(restarted);
    const again = (await reborn.call('seat_attach', { roomId: room.id, clientKey: 'attach-again' })).value.result as ToolArgs;
    expect(again).toMatchObject({ status: 'pending', scope: { sessionId: SESSION } });
    await f.runtime.core.dispatch(f.human, 'permission_grant', { requestId: again.id });
    await until(() => attachment()?.wake?.inboxId);
    const next = (await f.local('/local/opencode')).body;
    await fetch(next.url + '/fake/delete', { method: 'POST', body: JSON.stringify({ sessionID: SESSION }),
      headers: { authorization: 'Basic ' + Buffer.from('opencode:' + String(next.key)).toString('base64') } });
    await f.runtime.core.dispatch(f.human, 'room_post', { roomId: room.id, text: 'Over to you', mentions: [{ seatId, intent: 'question' }] });
    await until(() => !attachment(), 20000);
    expect(f.runtime.core.store.events(String(room.id)).filter((e) => e.type === 'seat.attachment_ended').map((e) => e.data.reason)).toEqual([expect.stringMatching(/bridge/i), expect.stringMatching(/session was deleted/)]);
  } finally {
    await f.close();
  }
}, 90000);

it('opens the OpenCode TUI on Converoom\'s server with that server\'s password in its environment', async () => {
  const f = await fixture();
  const { main } = await import('../apps/cli/src/index.js');
  try {
    await f.runtime.core.dispatch(f.human, 'push_bridge_enable', { bridge: 'opencode' });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined), error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await main(['opencode', 'project', '-s', SESSION, '--data-dir', f.dir]);
    expect(process.exitCode ?? 0).toBe(0);
    expect(error.mock.calls.flat().join(' ')).toMatch(/converoom connect opencode/);
    expect(log.mock.calls.flat().join(' ')).toMatch(/Opening OpenCode 2\.1\.4 on Converoom's OpenCode server\./);
    log.mockRestore();
    error.mockRestore();
    const access = (await f.local('/local/opencode')).body;
    expect((await f.fakeLog()).find((e) => e.event === 'client')).toEqual({ event: 'client', status: 200,
      args: ['--server', access.url, '-s', SESSION, resolve('project')] });
  } finally {
    process.exitCode = undefined;
    await f.close();
  }
}, 60000);
