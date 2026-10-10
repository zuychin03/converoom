import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { scopeDigest, createStore } from '../packages/store/src/index.js';
import type { Actor, ToolArgs, Event } from '../packages/shared/src/contracts.js';
const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
it('exports every ordered event and binds event provenance to the export digest', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-export-')),
    runtime = await createRuntime(dir, { noScheduler: true });
  try {
    const room = (await runtime.core.dispatch(owner, 'room_create', {
      title: 'Export',
      objective: 'History',
    })) as ToolArgs;
    runtime.core.store.transaction(() => {
      for (let i = 0; i < 1100; i++) runtime.core.store.append(String(room.id), 'fixture', 'owner', { i });
    });
    const e = (await runtime.core.dispatch(owner, 'room_export', { roomId: room.id })) as {
      schemaVersion: number;
      digest: string;
      records: ToolArgs[];
      events: Event[];
    };
    expect(e.schemaVersion).toBe(2);
    expect(e.events).toHaveLength(1101);
    expect(e.events.at(-1)?.data.i).toBe(1099);
    expect(e.digest).toBe(scopeDigest({ records: e.records, events: e.events }));
    e.events[0].data.title = 'altered';
    expect(e.digest).not.toBe(scopeDigest({ records: e.records, events: e.events }));
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
it('backs up a consistent database and immutable content files together', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-backup-')),
    runtime = await createRuntime(dir, { noScheduler: true });
  try {
    const room = (await runtime.core.dispatch(owner, 'room_create', {
      title: 'Backup',
      objective: 'Work survives',
    })) as ToolArgs;
    await mkdir(join(dir, 'artefacts'));
    await writeFile(join(dir, 'artefacts', 'fixture.json'), 'immutable fixture');
    const path = join(dir, 'saved');
    await runtime.core.dispatch(owner, 'backup_request', { path });
    const restored = createStore(join(path, 'converoom.sqlite'));
    expect(restored.get('room', String(room.id))).toMatchObject({ title: 'Backup' });
    restored.close();
    expect(await readFile(join(path, 'artefacts', 'fixture.json'), 'utf8')).toBe(
      'immutable fixture',
    );
    await expect(runtime.core.dispatch(owner, 'backup_request', { path })).rejects.toThrow();
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
it('enforces message budgets after more than one event page', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-budget-')),
    runtime = await createRuntime(dir, { noScheduler: true });
  try {
    const room = (await runtime.core.dispatch(owner, 'room_create', {
      title: 'Budget',
      objective: 'Paged history',
    })) as ToolArgs;
    runtime.core.store.transaction(() => {
      for (let i = 0; i < 1001; i++) runtime.core.store.append(String(room.id), 'permission.fixture', 'owner', { i });
    });
    for (let i = 0; i < 60; i++)
      await runtime.core.dispatch(owner, 'room_post', { roomId: room.id, text: 'Message ' + i });
    await expect(
      runtime.core.dispatch(owner, 'room_post', { roomId: room.id, text: 'Excess' }),
    ).rejects.toThrow(/budget/i);
    expect(await runtime.core.dispatch(owner, 'room_usage', { roomId: room.id })).toMatchObject({
      messages: 60,
    });
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
