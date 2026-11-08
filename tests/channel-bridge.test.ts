import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JSONRPCNotification } from '@modelcontextprotocol/sdk/types.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, humanIdentity, issueBridgeCredential, revokeBridgeCredential } from '../apps/daemon/src/server.js';
import type { Attachment } from '../packages/core/src/attachments.js';
import type { Product, ToolArgs } from '../packages/shared/src/contracts.js';

async function until<T>(read: () => T | undefined | Promise<T | undefined>, ms = 10000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error('Timed out waiting');
    await sleep(50);
  }
}

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-channel-')),
    runtime = await createRuntime(dir, { noScheduler: true }),
    server = await createServer(runtime, { port: 0, wakeTickMs: 50 });
  await writeFile(join(dir, 'runtime.json'), JSON.stringify({ url: server.url }));
  await mkdir(join(dir, 'clients'));
  const clients: Client[] = [];
  const connect = async (product: Product, notes: JSONRPCNotification[] = []) => {
    const credential = issueBridgeCredential(runtime, product);
    await writeFile(join(dir, 'clients', product + '.json'), JSON.stringify(credential));
    const c = new Client({ name: 'fixture-' + product, version: '1.0' }, { capabilities: {} });
    c.fallbackNotificationHandler = async (n) => { notes.push(n as JSONRPCNotification); };
    await c.connect(new StdioClientTransport({ command: process.execPath,
      args: [join(process.cwd(), 'dist', 'cli.js'), 'mcp', '--client', product, '--data-dir', dir], stderr: 'pipe' }));
    clients.push(c);
    return { c, credential };
  };
  const close = async () => {
    for (const c of clients) await c.close();
    await server.close();
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  };
  return { runtime, server, connect, close };
}
const call = async (c: Client, name: string, args: ToolArgs) => {
  const r = await c.callTool({ name, arguments: args });
  return { ok: r.isError !== true, value: JSON.parse((r.content as { text: string }[])[0]!.text) as ToolArgs };
};

it('wakes an attached Claude Code session through its channel and ends the attachment when the credential is revoked', async () => {
  const { runtime, connect, close } = await fixture();
  try {
    const notes: JSONRPCNotification[] = [];
    const { c: claude, credential } = await connect('claude', notes);
    const { c: codex } = await connect('codex');
    expect(claude.getServerCapabilities()?.experimental).toEqual({ 'claude/channel': {} });
    expect(claude.getInstructions()).toContain('room_inbox');
    expect(codex.getServerCapabilities()?.experimental).toBeUndefined();

    const room = (await call(claude, 'room_create', { title: 'Channel room', objective: 'Wake the host', product: 'claude', clientKey: 'create' }))
      .value.result as ToolArgs;
    const human = humanIdentity(runtime), seatId = String(room.hostSeatId);
    await runtime.core.dispatch(human, 'push_bridge_enable', { bridge: 'claude' });
    const request = await until(async () => {
      const r = await call(claude, 'seat_attach', { roomId: room.id, clientKey: 'attach' });
      return r.ok ? r.value.result as ToolArgs : undefined;
    });
    expect(notes).toEqual([]);
    await runtime.core.dispatch(human, 'permission_grant', { requestId: request.id });
    const wake = await until(() => notes.find((n) => n.method === 'notifications/claude/channel'));
    expect(wake.params).toEqual({ content: expect.stringContaining(String(room.id)), meta: { room_id: room.id, seat_id: seatId, wake_id: expect.any(String), kind: 'check' } });
    expect(String(wake.params?.content)).not.toContain('Channel room');
    await call(claude, 'room_inbox', { roomId: room.id });
    expect(runtime.core.store.get<Attachment>('attachment', seatId)).toMatchObject({ status: 'attached', tested: true });

    revokeBridgeCredential(runtime.core.store, credential.principalId);
    await until(() => !runtime.core.store.get('attachment', seatId));
    expect(runtime.core.store.events(String(room.id)).find((e) => e.type === 'seat.attachment_ended')?.data.reason).toMatch(/revoked/i);
  } finally {
    await close();
  }
}, 60000);

it('opens a wake stream only for an unscoped agent credential with a session ID, and only for its first principal', async () => {
  const { runtime, server, close } = await fixture();
  try {
    const session = randomUUID(), first = issueBridgeCredential(runtime, 'claude'), second = issueBridgeCredential(runtime, 'claude');
    const open = async (token: string, id?: string) => {
      const controller = new AbortController();
      const r = await fetch(server.url + '/agent/wakes', { signal: controller.signal,
        headers: { Authorization: 'Bearer ' + token, ...(id ? { 'X-Converoom-Session': id } : {}) } });
      return { status: r.status, stop: () => controller.abort() };
    };
    expect((await open('not-a-token', session)).status).toBe(401);
    expect((await open(first.token)).status).toBe(400);
    expect((await open(first.token, 'not a uuid')).status).toBe(400);
    const stream = await open(first.token, session);
    expect(stream.status).toBe(200);
    expect((await open(second.token, session)).status).toBe(409);
    stream.stop();
  } finally {
    await close();
  }
}, 30000);
