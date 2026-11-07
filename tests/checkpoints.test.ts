import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { run } from '../packages/adapters/src/process.js';
import { createStore, scopeDigest } from '../packages/store/src/index.js';
import { bytesDigest } from '../packages/shared/src/hash.js';
import { exportTranscript, type RoomExport } from '../packages/core/src/transcript.js';
import { checkpointStore, type Checkpoint } from '../packages/workspace/src/checkpoints.js';
import { lineDiff, splitLines } from '../packages/shared/src/diff.js';
import type { Snapshot } from '../packages/workspace/src/content.js';
import type { Actor, Event, Runtime, ToolArgs, Turn } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let root: string, donor: string, runtime: Runtime, room: ToolArgs, seat: ToolArgs;
let work: (cwd: string) => Promise<void>;
const call = <T = ToolArgs>(name: string, args: ToolArgs = {}, actor = owner) =>
  runtime.core.dispatch(actor, name, { ...args, clientKey: crypto.randomUUID() }) as Promise<T>;
const read = <T = ToolArgs>(name: string, args: ToolArgs, actor = owner) => runtime.core.dispatch(actor, name, args) as Promise<T>;
const store = () => runtime.core.store;
const attemptOf = (id: unknown) => store().get<ToolArgs>('attempt', String(id))!;
const events = (type: string) => store().events(String(room.id), 0, 1000).filter((e: Event) => e.type === type);
type Listing = { checkpoint: number; treeDigest: string; usedBytes: number; checkpoints: Checkpoint[] };
type Diff = { from: { checkpoint: number }; to: { checkpoint: number }; files: ToolArgs[] };

async function start(options: { checkpointBudget?: number } = {}) {
  runtime = await createRuntime(join(root, 'data'), {
    tickMs: 10,
    ...options,
    startSession: async (product, cwd) => ({
      id: 'fixture', product, capabilities: [],
      prompt: async () => { await work(cwd); return 'Done'; },
      cancel: async () => {}, close: async () => true,
    }),
  });
}
beforeEach(async () => {
  work = async () => {};
  root = await mkdtemp(join(tmpdir(), 'converoom-checkpoints-'));
  donor = join(root, 'donor');
  await mkdir(donor);
  await run('git', ['init'], donor);
  await run('git', ['config', 'core.autocrlf', 'false'], donor);
  await writeFile(join(donor, 'README.md'), 'Foundation\n');
  await writeFile(join(donor, '.gitignore'), '*.log\n');
  await run('git', ['add', '.'], donor);
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture'], donor);
});
afterEach(async () => {
  await runtime?.stop();
  await rm(root, { recursive: true, force: true });
});
async function claim() {
  room = await call('room_create', { title: 'Checkpoints', objective: 'Iterate on one attempt', workflow: 'coding' });
  seat = await call('seat_add', { roomId: room.id, name: 'Worker', product: 'codex', mode: 'managed' });
  await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
  await call('policy_update', { roomId: room.id, policy: { cooldownMs: 1 } });
  const repo = await call('repo_register', { path: donor });
  const profile = await call('profile_register', {
    name: 'Fixture checks', commands: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
    scopePaths: ['README.md', 'notes.txt', 'big.txt', 'src'], generatedPaths: ['build'],
  });
  await call('task_plan', { roomId: room.id, repoId: repo.id, tasks: [{ id: 'change', title: 'Change', acceptance: 'Reviewed',
    scopePaths: ['README.md', 'notes.txt', 'big.txt', 'src'], dependsOn: [], profileId: profile.id }] });
  return call('task_claim', { roomId: room.id, taskId: 'change', seatId: seat.id });
}
async function turn(attempt: ToolArgs, step: (cwd: string) => Promise<void> = async () => {}) {
  work = step;
  const t = await call('turn_request', { roomId: room.id, seatId: seat.id, attemptId: attempt.id, prompt: 'Next step' });
  await call('permission_grant', { requestId: t.permissionRequestId });
  await expect.poll(() => store().get<Turn>('turn', String(t.id))?.status).toBe('completed');
  await expect.poll(() => attemptOf(attempt.id).status).toBe('completed');
  return t;
}
const listing = (attempt: ToolArgs) => read<Listing>('checkpoint_list', { roomId: room.id, attemptId: attempt.id });
const diff = (attempt: ToolArgs, checkpoint: number) => read<Diff>('checkpoint_diff', { roomId: room.id, attemptId: attempt.id, checkpoint });

it('records a checkpoint after each completed coding turn and shows what each turn changed', async () => {
  await start();
  const attempt = await claim();
  const first = await turn(attempt, async (cwd) => {
    await writeFile(join(cwd, 'README.md'), 'Turn one\n');
    await writeFile(join(cwd, 'debug.log'), 'ignored\n');
    await mkdir(join(cwd, 'build'));
    await writeFile(join(cwd, 'build', 'out.js'), 'generated\n');
  });
  const second = await turn(attempt, async (cwd) => writeFile(join(cwd, 'notes.txt'), 'Second\n'));
  let list = await listing(attempt);
  expect(list.checkpoints).toMatchObject([
    { seq: 1, parentSeq: 0, status: 'kept', turnIds: [first.id], changed: { added: 0, modified: 1, deleted: 0 }, files: 2 },
    { seq: 2, parentSeq: 1, status: 'kept', turnIds: [second.id], changed: { added: 1, modified: 0, deleted: 0 }, files: 3 },
  ]);
  expect(list).toMatchObject({ checkpoint: 2, treeDigest: list.checkpoints[1].treeDigest });
  expect(attemptOf(attempt.id)).toMatchObject({ treeDigest: list.checkpoints[1].treeDigest, checkpointSeq: 2 });
  expect(await diff(attempt, 2)).toMatchObject({ from: { checkpoint: 1 }, to: { checkpoint: 2 },
    files: [{ path: 'notes.txt', change: 'added', after: 'Second\n', binary: false }] });
  expect(await diff(attempt, 1)).toMatchObject({ from: { checkpoint: 0 },
    files: [{ path: 'README.md', change: 'modified', before: 'Foundation\n', after: 'Turn one\n' }] });
  expect(events('checkpoint.recorded').map((e) => [e.actorId, e.data.checkpoint, e.data.turnId]))
    .toEqual([['runtime', 1, first.id], ['runtime', 2, second.id]]);

  const third = await turn(attempt);
  list = await listing(attempt);
  expect(list.checkpoints).toHaveLength(2);
  expect(list.checkpoints[1].turnIds).toEqual([second.id, third.id]);
  expect(events('checkpoint.unchanged').map((e) => e.data)).toMatchObject([{ turnId: third.id, checkpoint: 2 }]);
  const markdown = exportTranscript(await call<RoomExport>('room_export', { roomId: room.id }));
  expect(markdown).toContain('Checkpoint 2 of attempt');
  expect(markdown).toContain('unchanged; no checkpoint added.');
});

it('rolls an attempt back to a checkpoint, withdraws its queued turns and continues from the restored tree', async () => {
  await start();
  const attempt = await claim();
  await turn(attempt, async (cwd) => writeFile(join(cwd, 'README.md'), 'One\n'));
  await turn(attempt, async (cwd) => {
    await writeFile(join(cwd, 'notes.txt'), 'Two\n');
    await writeFile(join(cwd, 'debug.log'), 'kept across rollback\n');
  });
  const [one, two] = (await listing(attempt)).checkpoints;
  const queued = await call('turn_request', { roomId: room.id, seatId: seat.id, attemptId: attempt.id, prompt: 'Written for checkpoint two' });

  expect(await call('attempt_rollback', { roomId: room.id, attemptId: attempt.id, checkpoint: 1,
    reason: 'Second turn went the wrong way', confirm: true })).toEqual({ attemptId: attempt.id, checkpoint: 1, treeDigest: one.treeDigest });
  const path = String(attempt.path);
  expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('One\n');
  expect(existsSync(join(path, 'notes.txt'))).toBe(false);
  expect(await readFile(join(path, 'debug.log'), 'utf8')).toBe('kept across rollback\n');
  expect(attemptOf(attempt.id)).toMatchObject({ status: 'completed', treeDigest: one.treeDigest, checkpointSeq: 1, rollbackSeq: 1 });
  expect((await listing(attempt)).checkpoints[1]).toMatchObject({ seq: 2, status: 'kept', superseded: true });
  expect(store().get<Turn>('turn', String(queued.id))).toMatchObject({ status: 'cancelled', error: 'Attempt rolled back before the turn started' });
  expect(store().get<ToolArgs>('permission', String(queued.permissionRequestId))?.status).toBe('cancelled');
  expect(events('turn.cancelled').map((e) => e.data)).toMatchObject([{ turnId: queued.id, reason: 'attempt_rolled_back' }]);
  const [rolled] = events('attempt.rolled_back');
  const data = { attemptId: attempt.id, taskId: 'change', generation: 1, checkpoint: 1, treeDigest: one.treeDigest,
    previousTreeDigest: two.treeDigest, reason: 'Second turn went the wrong way' };
  expect(rolled).toMatchObject({ actorId: 'owner',
    data: { ...data, actionDigest: scopeDigest(data), policyVersion: store().get<ToolArgs>('room', String(room.id))?.policyVersion } });

  const next = await turn(attempt, async (cwd) => {
    await mkdir(join(cwd, 'src'));
    await writeFile(join(cwd, 'src', 'x.ts'), 'export {};\n');
  });
  expect((await listing(attempt)).checkpoints[2]).toMatchObject({ seq: 3, parentSeq: 1, turnIds: [next.id] });
  expect((await diff(attempt, 3)).files).toMatchObject([{ path: 'src/x.ts', change: 'added' }]);

  await call('attempt_rollback', { roomId: room.id, attemptId: attempt.id, checkpoint: 0, reason: 'Start over', confirm: true });
  expect(await readFile(join(path, 'README.md'), 'utf8')).toBe('Foundation\n');
  expect(existsSync(join(path, 'src', 'x.ts'))).toBe(false);
  expect(attemptOf(attempt.id)).toMatchObject({ treeDigest: attempt.effectiveBase, checkpointSeq: 0 });
  expect(exportTranscript(await call<RoomExport>('room_export', { roomId: room.id })))
    .toContain('rolled back to its starting point');
});

it('refuses a rollback without confirmation, before any turn, mid-turn, after hand edits or from another seat', async () => {
  await start();
  const attempt = await claim();
  const rollback = (args: ToolArgs = {}, actor = owner) => call('attempt_rollback',
    { roomId: room.id, attemptId: attempt.id, checkpoint: 0, reason: 'Inspected', confirm: true, ...args }, actor);
  await expect(rollback()).rejects.toMatchObject({ code: 'rollback_refused' });
  await turn(attempt, async (cwd) => writeFile(join(cwd, 'README.md'), 'One\n'));
  await expect(rollback({ confirm: false })).rejects.toMatchObject({ code: 'rollback_refused' });
  await expect(rollback({ checkpoint: 9 })).rejects.toMatchObject({ code: 'not_found' });

  const other = await call('seat_add', { roomId: room.id, name: 'Other', product: 'cursor', mode: 'managed' });
  const agent: Actor = { kind: 'agent', principalId: String(other.principalId), ownerId: 'owner' };
  await expect(rollback({}, agent)).rejects.toMatchObject({ code: 'forbidden' });
  await expect(read('checkpoint_list', { roomId: room.id, attemptId: attempt.id }, agent)).rejects.toMatchObject({ code: 'forbidden' });

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  work = async () => gate;
  const live = await call('turn_request', { roomId: room.id, seatId: seat.id, attemptId: attempt.id, prompt: 'Long step' });
  await call('permission_grant', { requestId: live.permissionRequestId });
  await expect.poll(() => attemptOf(attempt.id).status).toBe('running');
  await expect(rollback()).rejects.toMatchObject({ code: 'rollback_refused' });
  release();
  await expect.poll(() => attemptOf(attempt.id).status).toBe('completed');

  await writeFile(join(String(attempt.path), 'README.md'), 'Edited by hand\n');
  await expect(rollback()).rejects.toMatchObject({ code: 'workspace_changed' });
  expect(await readFile(join(String(attempt.path), 'README.md'), 'utf8')).toBe('Edited by hand\n');
  const refused = await call('turn_request', { roomId: room.id, seatId: seat.id, attemptId: attempt.id, prompt: 'Continue' });
  await call('permission_grant', { requestId: refused.permissionRequestId });
  await expect.poll(() => store().get<Turn>('turn', String(refused.id))?.status).toBe('failed');
  expect(store().get<Turn>('turn', String(refused.id))?.error).toMatch(/changed since its last checkpoint/);
});

it('prunes the oldest unprotected checkpoint at the storage budget and records a skip when nothing can go', async () => {
  await start({ checkpointBudget: 100 });
  const attempt = await claim();
  const version = (n: number) => String(n).repeat(29) + '\n';
  for (const n of [1, 2, 3, 4]) await turn(attempt, async (cwd) => writeFile(join(cwd, 'notes.txt'), version(n)));
  let list = await listing(attempt);
  expect(list.checkpoints.map((c) => [c.seq, c.status, c.reason])).toEqual([
    [1, 'kept', undefined], [2, 'pruned', 'limit'], [3, 'kept', undefined], [4, 'kept', undefined]]);
  const blobs = join(root, 'data', 'checkpoints', String(attempt.id), 'blobs');
  expect((await readdir(blobs)).sort()).toEqual([1, 3, 4].map((n) => bytesDigest(version(n))).sort());
  expect(list.usedBytes).toBe(90);
  expect(events('checkpoint.recorded').at(-1)?.data).toMatchObject({ checkpoint: 4, pruned: [2] });

  await turn(attempt, async (cwd) => writeFile(join(cwd, 'big.txt'), 'x'.repeat(200)));
  list = await listing(attempt);
  expect(list.checkpoints[4]).toMatchObject({ seq: 5, status: 'skipped', reason: 'budget', newBytes: 0 });
  expect(events('checkpoint.skipped').map((e) => e.data)).toMatchObject([{ checkpoint: 5, reason: 'budget' }]);
  expect(attemptOf(attempt.id)).toMatchObject({ treeDigest: list.checkpoints[4].treeDigest, checkpointSeq: 5 });

  await turn(attempt, async (cwd) => {
    await rm(join(cwd, 'big.txt'));
    await writeFile(join(cwd, 'notes.txt'), version(5));
  });
  list = await listing(attempt);
  expect(list.checkpoints.map((c) => [c.seq, c.status])).toEqual([[1, 'kept'], [2, 'pruned'], [3, 'pruned'], [4, 'kept'], [5, 'skipped'], [6, 'kept']]);
  expect(list.checkpoints[5]).toMatchObject({ parentSeq: 5, changed: null });
});

it('keeps at most twenty checkpoints, never pruning the first, the latest or the rollback target', async () => {
  const data = join(root, 'unit'), store = createStore(':memory:');
  const tree = (files: Record<string, string>): Snapshot => {
    const list = Object.entries(files).sort().map(([path, text]) =>
      ({ path, mode: 0o100644, digest: bytesDigest(text), bytes: Buffer.from(text).toString('base64') }));
    return { digest: scopeDigest(list.map(({ path, mode, digest }) => ({ path, mode, digest }))), files: list };
  };
  const base = tree({ 'README.md': 'base' }), checkpoints = checkpointStore(store, data);
  let last = 0;
  for (let n = 1; n <= 21; n++) {
    const at = { id: 'a', roomId: 'r', taskId: 't', effectiveBase: base.digest, checkpointSeq: last, rollbackSeq: n > 3 ? 3 : undefined };
    const { record, pruned } = await checkpoints.prepare(at, 'turn-' + n, tree({ 'README.md': 'v' + n }), base);
    store.put('checkpoint', record.id, record);
    for (const c of pruned) store.put('checkpoint', c.id, { ...c, status: 'pruned' });
    await checkpoints.collect(at, base);
    last = record.seq;
  }
  const all = checkpoints.list('r', 'a');
  expect(all.filter((c) => c.status === 'kept')).toHaveLength(20);
  expect(all.filter((c) => c.status === 'pruned').map((c) => c.seq)).toEqual([2]);
  expect(await readdir(join(data, 'checkpoints', 'a', 'blobs'))).not.toContain(bytesDigest('v2'));
  expect(existsSync(join(data, 'checkpoints', 'a', '2.json'))).toBe(false);
  store.close();
});

it('computes minimal line diffs that number both sides', () => {
  const lcs = (a: string[], b: string[]) => {
    const t = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    return t[0][0];
  };
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let n = 0; n < 300; n++) {
    const a = Array.from({ length: Math.floor(random() * 12) }, () => 'abcd'[Math.floor(random() * 4)]);
    const b = Array.from({ length: Math.floor(random() * 12) }, () => 'abcd'[Math.floor(random() * 4)]);
    const lines = lineDiff(a.map((l) => l + '\n').join(''), b.map((l) => l + '\n').join(''));
    expect(lines.filter((l) => l.kind !== 'add').map((l) => [l.text, l.old])).toEqual(a.map((l, i) => [l, i + 1]));
    expect(lines.filter((l) => l.kind !== 'del').map((l) => [l.text, l.new])).toEqual(b.map((l, i) => [l, i + 1]));
    expect(lines.filter((l) => l.kind !== 'same')).toHaveLength(a.length + b.length - 2 * lcs(a, b));
  }
  expect(splitLines('one\ntwo\n')).toEqual(['one', 'two']);
  expect(splitLines('one\ntwo')).toEqual(['one', 'two']);
  expect(splitLines('')).toEqual([]);
});

it('marks an attempt interrupted while saving its checkpoint as uncertain after a restart', async () => {
  await start();
  const attempt = await claim();
  await turn(attempt, async (cwd) => writeFile(join(cwd, 'README.md'), 'One\n'));
  store().put('attempt', String(attempt.id), { ...attemptOf(attempt.id), status: 'checkpointing' });
  await runtime.stop();
  await start();
  expect(attemptOf(attempt.id).status).toBe('uncertain');
});
