import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
    for (let i = 0; i < 1100; i++) runtime.core.store.append(String(room.id), 'fixture', 'owner', { i });
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
