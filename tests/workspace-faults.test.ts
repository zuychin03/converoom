import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import { mountWorkspace } from '../packages/workspace/src/index.js';
import { run } from '../packages/adapters/src/process.js';
import type { Actor, Core, ToolArgs } from '../packages/shared/src/contracts.js';
const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let root: string,
  core: Core,
  room: ToolArgs,
  repo: ToolArgs,
  profile: ToolArgs,
  seat: ToolArgs,
  workspace: ReturnType<typeof mountWorkspace>;
const call = (n: string, x: ToolArgs = {}) =>
  core.dispatch(owner, n, { ...x, clientKey: crypto.randomUUID() }) as Promise<ToolArgs>;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'converoom-fault-'));
  const donor = join(root, 'donor');
  await mkdir(donor);
  await run('git', ['init'], donor);
  await writeFile(join(donor, 'base.txt'), 'foundation');
  await run('git', ['add', '.'], donor);
  await run(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      'commit',
      '-m',
      'Fixture',
    ],
    donor,
  );
  core = createCore(createStore(':memory:'));
  workspace = mountWorkspace(core, join(root, 'data'));
  room = await call('room_create', {
    title: 'Fault checks',
    objective: 'Exact work',
    workflow: 'coding',
  });
  seat = await call('seat_add', {
    roomId: room.id,
    product: 'codex',
    mode: 'managed',
    name: 'Worker',
  });
  repo = await call('repo_register', { path: donor });
  profile = await call('profile_register', {
    name: 'Fixture',
    commands: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
    scopePaths: ['base.txt', 'a.txt', 'b.txt', 'c.txt', 'd.txt'],
    generatedPaths: [],
  });
});
afterEach(async () => {
  await workspace.close();
  core.store.close();
  await rm(root, { recursive: true, force: true });
});
async function plan(items: { id: string; dependsOn: string[] }[]) {
  await call('task_plan', {
    roomId: room.id,
    repoId: repo.id,
    tasks: items.map((t) => ({
      ...t,
      title: t.id,
      acceptance: 'Exact fixture',
      profileId: profile.id,
      scopePaths: [t.id + '.txt'],
    })),
  });
}
async function submit(id: string, accept = true) {
  const at = await call('task_claim', { roomId: room.id, taskId: id, seatId: seat.id });
  await writeFile(join(String(at.path), id + '.txt'), id);
  const m = await call('task_submit', { roomId: room.id, attemptId: at.id });
  if (accept) {
    await call('verification_request', { roomId: room.id, manifestId: m.id });
    await call('review_submit', {
      roomId: room.id,
      manifestId: m.id,
      verdict: 'accept',
      reason: 'Fixture reviewed',
    });
  }
  return { at, m };
}
it('rejects altered source bytes even when stored digest fields are unchanged', async () => {
  await plan([{ id: 'a', dependsOn: [] }]);
  const { m } = await submit('a', false);
  const data = JSON.parse(await readFile(String(m.dataPath), 'utf8'));
  data.snapshot.files[0].bytes = Buffer.from('tampered').toString('base64');
  await writeFile(String(m.dataPath), JSON.stringify(data));
  await expect(call('artefact_get', { roomId: room.id, manifestId: m.id })).rejects.toThrow(
    /digest|submission/i,
  );
});
it('retains a submitted clone that was edited after export', async () => {
  await plan([{ id: 'a', dependsOn: [] }]);
  const { at } = await submit('a', false);
  core.store.put('exported', String(room.id), { at: Date.now() });
  await writeFile(join(String(at.path), 'a.txt'), 'unexported edit');
  await expect(call('workspace_cleanup', { attemptId: at.id, confirm: true })).rejects.toThrow(
    /dirty|changed|retained/i,
  );
  expect(await readFile(join(String(at.path), 'a.txt'), 'utf8')).toBe('unexported edit');
});
it('prevents observer seats from reviewing work or executing native checks', async () => {
  await plan([{ id: 'a', dependsOn: [] }]);
  const { m } = await submit('a');
  const observer = await call('seat_add', {
      roomId: room.id,
      name: 'Observer',
      role: 'observer',
      mode: 'polling',
      product: 'codex',
    }),
    actor: Actor = { kind: 'agent', principalId: String(observer.principalId), ownerId: 'owner' };
  await expect(
    core.dispatch(actor, 'verification_request', {
      roomId: room.id,
      manifestId: m.id,
      clientKey: 'observer-check',
    }),
  ).rejects.toThrow(/observer/i);
  await expect(
    core.dispatch(actor, 'review_submit', {
      roomId: room.id,
      manifestId: m.id,
      verdict: 'reject',
      reason: 'Observer edit',
      clientKey: 'observer-review',
    }),
  ).rejects.toThrow(/observer/i);
});
it('preserves existing generated output when applying a verified candidate', async () => {
  profile = await call('profile_register', {
    name: 'Generated paths',
    commands: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
    scopePaths: ['a.txt'],
    generatedPaths: ['node_modules'],
  });
  await plan([{ id: 'a', dependsOn: [] }]);
  const { m } = await submit('a');
  const candidate = await call('integration_prepare', {
    roomId: room.id,
    repoId: repo.id,
    manifestIds: [m.id],
    profileId: profile.id,
  });
  await call('candidate_review', {
    roomId: room.id,
    candidateId: candidate.id,
    reason: 'Fixture inspected',
  });
  await mkdir(join(String(repo.path), 'node_modules'));
  await writeFile(join(String(repo.path), 'node_modules', 'keep'), 'owner cache');
  await call('candidate_apply', { roomId: room.id, candidateId: candidate.id });
  expect(await readFile(join(String(repo.path), 'node_modules', 'keep'), 'utf8')).toBe(
    'owner cache',
  );
});
it('composes a diamond once and rejects reused evidence after prerequisite replacement', async () => {
  await plan([
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
    { id: 'd', dependsOn: ['b', 'c'] },
  ]);
  const a = await submit('a');
  const b = await submit('b');
  const c = await submit('c');
  const d = await call('task_claim', { roomId: room.id, taskId: 'd', seatId: seat.id });
  expect(d.dependencies).toEqual([a.m.id, b.m.id, c.m.id]);
  expect(await readFile(join(String(d.path), 'a.txt'), 'utf8')).toBe('a');
  await call('review_submit', {
    roomId: room.id,
    manifestId: a.m.id,
    verdict: 'reject',
    reason: 'Prerequisite must change',
  });
  await expect(
    call('verification_request', { roomId: room.id, manifestId: b.m.id }),
  ).rejects.toThrow(/dependency|prerequisite/i);
  await expect(
    call('review_submit', {
      roomId: room.id,
      manifestId: c.m.id,
      verdict: 'accept',
      reason: 'Old evidence',
    }),
  ).rejects.toThrow(/dependency|prerequisite/i);
  await expect(call('task_submit', { roomId: room.id, attemptId: d.id })).rejects.toThrow(
    /dependency|prerequisite/i,
  );
}, 30000);
