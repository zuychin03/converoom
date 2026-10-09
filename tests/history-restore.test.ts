import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, humanIdentity } from '../apps/daemon/src/server.js';
import { humanCommand } from '../apps/cli/src/human.js';
import { createStore, scopeDigest } from '../packages/store/src/index.js';
import type { Event, ToolArgs } from '../packages/shared/src/contracts.js';
type History = { schemaVersion: number; digest: string; records: { kind: string; id: string; value: ToolArgs }[]; events: Event[] };
const run = promisify(execFile);
const restore = (input: string, target: string) => run(process.execPath,
  [join(process.cwd(), 'dist/cli.js'), 'restore', '--input', input, '--data-dir', target], { windowsHide: true, timeout: 15000 });
async function history(dir: string) {
  const runtime = await createRuntime(join(dir, 'source'), { noScheduler: true });
  const owner = humanIdentity(runtime);
  const room = await runtime.core.dispatch(owner, 'room_create', { title: 'Restored history', objective: 'Inspect without execution' }) as ToolArgs;
  const exported = await runtime.core.dispatch(owner, 'room_export', { roomId: room.id }) as History;
  await runtime.stop();
  return exported;
}
it.each(['event gap', 'missing room', 'duplicate record', 'multiple owners'])(
  'leaves no partial database or staging directory after invalid restore: %s', async (fault) => {
    const dir = await mkdtemp(join(tmpdir(), 'converoom-restore-failure-'));
    try {
      const e = await history(dir);
      if (fault === 'event gap') e.events[0].seq = 2;
      if (fault === 'missing room') e.events[0].roomId = 'unknown';
      if (fault === 'duplicate record') e.records.push(e.records[0]);
      if (fault === 'multiple owners') e.records.push({ kind: 'room', id: 'other', value: {
        ...e.records[0].value, id: 'other', ownerId: 'other-owner', seq: 0,
      } });
      e.digest = scopeDigest({ records: e.records, events: e.events });
      const input = join(dir, 'input.json'), target = join(dir, 'target');
      await writeFile(input, JSON.stringify(e));
      await expect(restore(input, target)).rejects.toThrow();
      expect(await readdir(target)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 30000,
);
it('restores a valid redacted HTTP export as read-only history and refuses to replace existing data', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-restore-roundtrip-'));
  const runtime = await createRuntime(join(dir, 'source'), { noScheduler: true });
  const server = await createServer(runtime, { port: 0, pairingCode: 'history-fixture' });
  try {
    const owner = humanIdentity(runtime);
    const room = await runtime.core.dispatch(owner, 'room_create', { title: 'Redacted roundtrip', objective: 'Retain safe history' }) as ToolArgs;
    const seat = await runtime.core.dispatch(owner, 'seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Historical worker' }) as ToolArgs;
    runtime.core.store.put('seat', String(seat.id), { ...seat, apiKey: 'fixture-only' });
    runtime.core.store.append(String(room.id), 'fixture', 'owner', { apiKey: 'fixture-only', nested: { credential: 'fixture-only' }, visible: 'Keep this' });
    const e = await humanCommand(server.url, 'history-fixture', 'room_export', { roomId: room.id }) as History;
    expect(e.digest).toBe(scopeDigest({ records: e.records, events: e.events }));
    expect(JSON.stringify(e)).not.toContain('fixture-only');
    const input = join(dir, 'input.json'), target = join(dir, 'target');
    await writeFile(input, JSON.stringify(e));
    await restore(input, target);
    let restored = createStore(join(target, 'converoom.sqlite'));
    expect(restored.get('room', String(room.id))).toMatchObject({ status: 'closed' });
    expect(restored.get('seat', String(seat.id))).toMatchObject({ status: 'left', consent: false });
    expect(restored.get('identity', 'human')).toMatchObject(owner);
    expect(restored.events(String(room.id))).toHaveLength(e.events.length);
    expect(restored.list('bridge')).toHaveLength(0);
    restored.close();
    await expect(restore(input, target)).rejects.toThrow();
    restored = createStore(join(target, 'converoom.sqlite'));
    expect(restored.get('room', String(room.id))).toMatchObject({ title: 'Redacted roundtrip' });
    restored.close();
  } finally { await server.close(); await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
}, 30000);
