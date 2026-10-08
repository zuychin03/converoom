import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import { mountWorkspace } from '../packages/workspace/src/index.js';
import { run } from '../packages/adapters/src/process.js';
import type { Actor, ToolArgs } from '../packages/shared/src/contracts.js';
const human: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
describe('isolated coding and exact verification', () => {
  it('preserves dirty donor, verifies uncommitted content independently and prepares combined candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'converoom-work-'));
    const repo = join(root, 'repo');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(repo);
    const store = createStore(':memory:'),
      core = createCore(store);
    mountWorkspace(core, join(root, 'data'));
    const call = (name: string, args: ToolArgs = {}) =>
      core.dispatch(human, name, { ...args, clientKey: crypto.randomUUID() }) as Promise<ToolArgs>;
    try {
      await run('git', ['init'], repo);
      await writeFile(join(repo, 'code.txt'), 'foundation');
      await run('git', ['add', '.'], repo);
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
        repo,
      );
      await writeFile(join(repo, 'code.txt'), 'dirty owner');
      const r = await call('room_create', {
        title: 'Coding',
        objective: 'Verify isolated work',
        workflow: 'coding',
      });
      const s = await call('seat_add', {
        roomId: r.id,
        name: 'Worker',
        product: 'codex',
        mode: 'managed',
      });
      const registered = await call('repo_register', { path: repo, name: 'Fixture' });
      const p = await call('profile_register', {
        name: 'safe checks',
        commands: [
          {
            executable: process.execPath,
            args: [
              '-e',
              "const fs=require('fs');if(fs.readFileSync('code.txt','utf8')!=='changed')process.exit(1)",
            ],
            timeoutMs: 5000,
          },
        ],
        scopePaths: ['code.txt'],
        generatedPaths: [],
      });
      await call('task_plan', {
        roomId: r.id,
        repoId: registered.id,
        tasks: [
          {
            id: 'change',
            title: 'Change',
            acceptance: 'check passes',
            scopePaths: ['code.txt'],
            dependsOn: [],
            profileId: p.id,
          },
        ],
      });
      const attempt = await call('task_claim', { roomId: r.id, taskId: 'change', seatId: s.id });
      expect(await readFile(join(String(attempt.path), 'code.txt'), 'utf8')).toBe('foundation');
      expect(await run('git', ['remote'], String(attempt.path))).toMatchObject({ output: '' });
      await writeFile(join(String(attempt.path), 'code.txt'), 'changed');
      const m = await call('task_submit', { roomId: r.id, attemptId: attempt.id });
      const v = await call('verification_request', { roomId: r.id, manifestId: m.id });
      expect(v.status).toBe('passing');
      expect(v.workspace).not.toBe(attempt.path);
      await call('review_submit', {
        roomId: r.id,
        manifestId: m.id,
        verdict: 'accept',
        reason: 'Reviewed exact patch',
      });
      const candidate = await call('integration_prepare', {
        roomId: r.id,
        repoId: registered.id,
        manifestIds: [m.id],
        profileId: p.id,
      });
      expect(candidate.status).toBe('verified');
      expect(await readFile(join(repo, 'code.txt'), 'utf8')).toBe('dirty owner');
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
