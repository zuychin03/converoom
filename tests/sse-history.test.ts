import { it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { get, type IncomingMessage } from 'node:http';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, humanIdentity } from '../apps/daemon/src/server.js';
import type { ToolArgs } from '../packages/shared/src/contracts.js';
it('opens an idle SSE connection promptly and streams every retained event after an old cursor', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-sse-'));
  const runtime = await createRuntime(dir, { noScheduler: true });
  const server = await createServer(runtime, { port: 0, pairingCode: 'sse-fixture' });
  const abort = new AbortController();
  try {
    const owner = humanIdentity(runtime);
    const room = await runtime.core.dispatch(owner, 'room_create', { title: 'SSE history', objective: 'No dropped updates' }) as ToolArgs;
    const first = runtime.core.store.recentEvents(1)[0];
    const pair = await fetch(server.url + '/api/pair', { method: 'POST', headers: {
      'content-type': 'application/json', origin: server.url,
    }, body: JSON.stringify({ code: 'sse-fixture' }) });
    const cookie = pair.headers.get('set-cookie')!.split(';')[0];
    const idle = await fetch(server.url + '/api/events', { headers: { cookie, 'last-event-id': first.id }, signal: AbortSignal.timeout(1200) });
    expect(idle.status).toBe(200);
    await idle.body!.cancel();
    runtime.core.store.transaction(() => {
      for (let i = 0; i < 1100; i++) runtime.core.store.append(String(room.id), 'fixture', 'owner', { i });
    });
    const events = await fetch(server.url + '/api/events', { headers: { cookie, 'last-event-id': first.id }, signal: abort.signal });
    const reader = events.body!.getReader(), decoder = new TextDecoder();
    let buffer = '';
    const ids: string[] = [];
    const deadline = setTimeout(() => abort.abort(), 5000);
    try {
      while (ids.length < 1100) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const id = /^id: (.+)$/m.exec(frame)?.[1];
          if (id) ids.push(id);
        }
      }
      expect(ids).toEqual(runtime.core.store.events(String(room.id), first.seq, 1000).map((e) => e.id)
        .concat(runtime.core.store.events(String(room.id), first.seq + 1000, 1000).map((e) => e.id)));
      expect(new Set(ids).size).toBe(1100);
    } finally { clearTimeout(deadline); await reader.cancel(); }
  } finally { abort.abort(); await server.close(); await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
});
async function paired() {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-sse-'));
  const runtime = await createRuntime(dir, { noScheduler: true });
  const server = await createServer(runtime, { port: 0, pairingCode: 'sse-fixture' });
  const pair = await fetch(server.url + '/api/pair', { method: 'POST', headers: { 'content-type': 'application/json', origin: server.url },
    body: JSON.stringify({ code: 'sse-fixture' }) });
  const close = async () => { await server.close(); await runtime.stop(); await rm(dir, { recursive: true, force: true }); };
  return { runtime, server, cookie: pair.headers.get('set-cookie')!.split(';')[0], close };
}
const open = (url: string, cookie: string, cursor: string) => new Promise<IncomingMessage>((resolve, reject) =>
  get(url + '/api/events', { headers: { cookie, 'last-event-id': cursor } }, resolve).on('error', reject));
function ids(response: IncomingMessage, count: number) {
  return new Promise<string[]>((resolve, reject) => {
    const seen: string[] = [];
    let buffer = '';
    const timer = setTimeout(() => { response.destroy(); reject(new Error('Received ' + seen.length + ' of ' + count)); }, 15000);
    response.setEncoding('utf8');
    response.on('data', (chunk: string) => {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const id = /^id: (.+)$/m.exec(buffer.slice(0, end))?.[1];
        buffer = buffer.slice(end + 2);
        if (id) seen.push(id);
      }
      if (seen.length >= count) { clearTimeout(timer); response.destroy(); resolve(seen); }
    });
    response.resume();
  });
}
it('resumes across rooms in commit order when events share a timestamp and their IDs sort differently', async () => {
  const { runtime, server, cookie, close } = await paired();
  try {
    const owner = humanIdentity(runtime);
    const rooms = [
      await runtime.core.dispatch(owner, 'room_create', { title: 'First room', objective: 'Interleave' }) as ToolArgs,
      await runtime.core.dispatch(owner, 'room_create', { title: 'Second room', objective: 'Interleave' }) as ToolArgs,
    ];
    const start = runtime.core.store.recentEvents(1)[0], written: string[] = [];
    vi.spyOn(Date, 'now').mockReturnValue(1_800_000_000_000);
    runtime.core.store.transaction(() => {
      for (let i = 0; i < 200; i++) written.push(runtime.core.store.append(String(rooms[i % 2].id), 'fixture', 'owner', { i }).id);
    });
    vi.restoreAllMocks();
    expect([...written].sort()).not.toEqual(written);
    expect(await ids(await open(server.url, cookie, start.id), 200)).toEqual(written);
  } finally { vi.restoreAllMocks(); await close(); }
}, 30000);
it('delivers every event once and in order to a consumer that stops reading for a while', async () => {
  const { runtime, server, cookie, close } = await paired();
  try {
    const room = await runtime.core.dispatch(humanIdentity(runtime), 'room_create', { title: 'Slow reader', objective: 'Backpressure' }) as ToolArgs;
    const start = runtime.core.store.recentEvents(1)[0], written: string[] = [];
    const response = await open(server.url, cookie, start.id);
    response.pause();
    runtime.core.store.transaction(() => {
      for (let i = 0; i < 400; i++) written.push(runtime.core.store.append(String(room.id), 'fixture', 'owner', { i, text: 'x'.repeat(8000) }).id);
    });
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(await ids(response, 400)).toEqual(written);
  } finally { await close(); }
}, 30000);
it('tells a client holding a cursor from another store to resync instead of refusing the stream', async () => {
  const { server, cookie, close } = await paired();
  try {
    const response = await fetch(server.url + '/api/events', { headers: { cookie, 'last-event-id': 'not-in-this-store' }, signal: AbortSignal.timeout(5000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('event: resync');
  } finally { await close(); }
});
