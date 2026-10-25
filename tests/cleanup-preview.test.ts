import { it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import { mountWorkspace } from '../packages/workspace/src/index.js';
import { run } from '../packages/adapters/src/process.js';
import { cleanupPreviewLines, cleanupResultLines } from '../apps/cli/src/cleanup.js';
import type { Actor, Core, ToolArgs } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let root: string, data: string, core: Core, room: ToolArgs, repo: ToolArgs, profile: ToolArgs, seat: ToolArgs,
  workspace: ReturnType<typeof mountWorkspace>;
const call = <T = ToolArgs>(n: string, x: ToolArgs = {}) => core.dispatch(owner, n, { ...x, clientKey: crypto.randomUUID() }) as Promise<T>;
type Entry = { name: string; kind: string; id?: string; removable: boolean; reason?: string; detail: string; bytes: number; keepUntil?: number };
type Preview = { digest: string; code: string; entries: Entry[]; removable: { count: number; bytes: number } };
const preview = () => call<Preview>('workspace_cleanup_preview');
const byName = (p: Preview) => new Map(p.entries.map((e) => [e.name, e]));
const exported = () => core.store.put('exported', String(room.id), { at: Date.now() });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'converoom-cleanup-'));
  data = join(root, 'data');
  const donor = join(root, 'donor');
  await mkdir(donor);
  await run('git', ['init'], donor);
  await writeFile(join(donor, 'base.txt'), 'foundation');
  await run('git', ['add', '.'], donor);
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], donor);
  core = createCore(createStore(':memory:'));
  workspace = mountWorkspace(core, data);
  room = await call('room_create', { title: 'Cleanup', objective: 'Exact work', workflow: 'coding' });
  seat = await call('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Worker' });
  repo = await call('repo_register', { path: donor });
  profile = await call('profile_register', {
    name: 'Fixture',
    commands: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
    scopePaths: ['base.txt', 'a.txt', 'b.txt', 'c.txt', 'd.txt', 'e.txt', 'f.txt'],
    generatedPaths: [],
  });
  await call('task_plan', { roomId: room.id, repoId: repo.id, tasks: ['a', 'b', 'c', 'd', 'e', 'f'].map((id) =>
    ({ id, dependsOn: [], title: id, acceptance: 'Exact fixture', profileId: profile.id, scopePaths: [id + '.txt'] })) });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await workspace.close();
  core.store.close();
  await rm(root, { recursive: true, force: true });
});
const claim = (id: string) => call('task_claim', { roomId: room.id, taskId: id, seatId: seat.id });
async function submit(id: string) {
  const at = await claim(id);
  await writeFile(join(String(at.path), id + '.txt'), id);
  return { at, m: await call('task_submit', { roomId: room.id, attemptId: at.id }) };
}
async function release(id: string, change?: string) {
  const at = await claim(id);
  if (change) await writeFile(join(String(at.path), id + '.txt'), change);
  await call('attempt_release', { roomId: room.id, attemptId: at.id, confirm: true, reason: 'Set aside after inspection' });
  return at;
}

it('previews every coding workspace with the reason each one is kept', async () => {
  const submitted = await submit('a');
  const edited = await submit('b');
  const active = await claim('c');
  const dirty = await release('d', 'never submitted');
  const clean = await release('e');
  const verification = await call('verification_request', { roomId: room.id, manifestId: submitted.m.id });
  await mkdir(join(data, 'workspaces', 'stray'));
  expect(byName(await preview()).get(String(submitted.at.id))).toMatchObject({ removable: false, reason: 'unexported' });
  exported();
  await writeFile(join(String(edited.at.path), 'b.txt'), 'edited after submission');
  const result = await preview(), entries = byName(result);
  expect(entries.get(String(submitted.at.id))).toMatchObject({ kind: 'attempt', removable: true, bytes: expect.any(Number) });
  expect(entries.get(String(submitted.at.id))!.bytes).toBeGreaterThan(0);
  expect(entries.get(String(edited.at.id))).toMatchObject({ removable: false, reason: 'changed' });
  expect(entries.get(String(active.id))).toMatchObject({ removable: false, reason: 'active' });
  expect(entries.get(String(dirty.id))).toMatchObject({ removable: false, reason: 'dirty' });
  expect(entries.get(String(clean.id))).toMatchObject({ removable: false, reason: 'retention', keepUntil: expect.any(Number) });
  expect(entries.get('verify-' + String(verification.id))).toMatchObject({ kind: 'verification', removable: true });
  expect(entries.get('stray')).toMatchObject({ kind: 'unknown', removable: false, reason: 'unknown' });
  expect(entries.get('foundation-' + String(repo.id))).toMatchObject({ kind: 'foundation', removable: true });
  expect(result.removable.count).toBe(3);
  expect(result.code).toBe(result.digest.slice(0, 12));
  const later = Date.now() + 7 * 86400000 + 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => later);
  exported();
  expect(byName(await preview()).get(String(clean.id))).toMatchObject({ removable: true });
});

it('removes only what the confirmed preview listed and refuses one that changed', async () => {
  const submitted = await submit('a');
  const dirty = await release('d', 'never submitted');
  exported();
  const first = await preview();
  expect(first.removable.count).toBe(2);
  const late = await submit('b');
  exported();
  await expect(call('workspace_cleanup', { preview: first.code, confirm: true })).rejects.toMatchObject({ code: 'cleanup_changed' });
  expect(existsSync(String(submitted.at.path))).toBe(true);
  const second = await preview();
  await expect(call('workspace_cleanup', { preview: second.code.slice(0, 8), confirm: true })).rejects.toMatchObject({ code: 'cleanup_changed' });
  await expect(call('workspace_cleanup', { preview: second.code })).rejects.toThrow(/confirm/i);
  const removed = await call<{ removed: Entry[]; failed: unknown[]; bytes: number }>('workspace_cleanup', { preview: second.code, confirm: true });
  expect(removed.removed.map((e) => e.name).sort()).toEqual([String(submitted.at.id), String(late.at.id), 'foundation-' + String(repo.id)].sort());
  expect(removed.failed).toEqual([]);
  for (const at of [submitted.at, late.at]) {
    expect(existsSync(String(at.path))).toBe(false);
    expect(existsSync(join(data, 'resources', String(at.id)))).toBe(false);
    expect(core.store.get<ToolArgs>('attempt', String(at.id))).toMatchObject({ status: 'removed' });
    expect(core.store.get<ToolArgs>('resource', String(at.id))).toMatchObject({ status: 'removed' });
  }
  expect(await readFile(join(String(dirty.path), 'd.txt'), 'utf8')).toBe('never submitted');
  const events = core.store.events(String(room.id), 0, 1000).filter((e) => e.type === 'workspaces.removed');
  expect(events).toHaveLength(1);
  expect(events[0].data).toMatchObject({ removed: expect.arrayContaining([expect.objectContaining({ kind: 'attempt', id: submitted.at.id })]) });
  await expect(call('workspace_cleanup', { preview: (await preview()).code, confirm: true })).rejects.toThrow(/nothing/i);
});

it('keeps the checkouts of an unfinished candidate apply and removes those of an applied one', async () => {
  const candidate = (id: string, status: string) => core.store.put('candidate', id, { id, roomId: room.id, status, createdAt: Date.now() - 1000 });
  candidate('applied-one', 'applied');
  candidate('stuck-one', 'uncertain');
  for (const name of ['apply-applied-one', 'apply-foundation-applied-one', 'apply-stuck-one'])
    await mkdir(join(data, 'workspaces', name), { recursive: true });
  exported();
  const entries = byName(await preview());
  for (const name of ['apply-applied-one', 'apply-foundation-applied-one'])
    expect(entries.get(name)).toMatchObject({ kind: 'candidate', id: 'applied-one', removable: true });
  expect(entries.get('apply-stuck-one')).toMatchObject({ kind: 'candidate', removable: false, reason: 'uncertain' });
});

it('counts an export only when it was taken after the work', async () => {
  exported();
  const submitted = await submit('a');
  expect(byName(await preview()).get(String(submitted.at.id))).toMatchObject({ removable: false, reason: 'unexported' });
});

it('finishes a removal that stopped partway', async () => {
  const submitted = await submit('a');
  exported();
  core.store.put('cleanup', String(submitted.at.id), { name: submitted.at.id, startedAt: Date.now() });
  await rm(join(String(submitted.at.path), 'a.txt'));
  expect(byName(await preview()).get(String(submitted.at.id))).toMatchObject({ removable: true, detail: expect.stringMatching(/did not finish/i) });
  await call('workspace_cleanup', { preview: (await preview()).code, confirm: true });
  expect(existsSync(String(submitted.at.path))).toBe(false);
  expect(core.store.get('cleanup', String(submitted.at.id))).toBeUndefined();
});

it('keeps the single-attempt cleanup under the same rules', async () => {
  const submitted = await submit('a');
  const clean = await release('e');
  exported();
  await expect(call('workspace_cleanup', { attemptId: clean.id, confirm: true })).rejects.toThrow(/retained.*7 days/i);
  expect(await call('workspace_cleanup', { attemptId: submitted.at.id, confirm: true })).toMatchObject({ removed: submitted.at.id });
  await expect(stat(String(submitted.at.path))).rejects.toThrow();
});

it('prints the preview and the removal for the CLI', () => {
  const entries = [
    { name: 'a1', path: 'C:/data/workspaces/a1', kind: 'attempt', removable: true, detail: 'Submitted and exported', bytes: 2048 },
    { name: 'b2', path: 'C:/data/workspaces/b2', kind: 'attempt', removable: false, reason: 'dirty', detail: 'Holds changes that were never submitted', bytes: 1572864 },
  ];
  const lines = cleanupPreviewLines({ digest: 'f'.repeat(64), code: 'ffffffffffff', entries, removable: { count: 1, bytes: 2048 } });
  expect(lines[0]).toBe('Cleanup preview. Nothing was removed.');
  expect(lines).toContain('Can be removed (1, 2.0 KiB):');
  expect(lines).toContain('- C:/data/workspaces/a1 · attempt · 2.0 KiB · Submitted and exported');
  expect(lines).toContain('Kept (1):');
  expect(lines).toContain('- C:/data/workspaces/b2 · attempt · 1.5 MiB · Holds changes that were never submitted');
  expect(lines.at(-1)).toBe('To remove the 1 workspace listed above, run: converoom cleanup --confirm ffffffffffff');
  expect(cleanupPreviewLines({ digest: 'e', code: 'e', entries: [entries[1]!], removable: { count: 0, bytes: 0 } }).at(-1))
    .toBe('Nothing can be removed now.');
  expect(cleanupResultLines({ removed: [entries[0]!], failed: [{ name: 'c3', path: 'C:/data/workspaces/c3', message: 'EBUSY' }], bytes: 2048 })).toEqual([
    'Removed 1 workspace (2.0 KiB):', '- C:/data/workspaces/a1', 'Could not remove 1 workspace; preview again to retry:', '- C:/data/workspaces/c3: EBUSY',
  ]);
});
