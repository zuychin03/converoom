import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, scopeDigest } from '../packages/store/src/index.js';
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
  it('fences a finished journaled command for a week, then runs its key again, while an interrupted one stays fenced', async () => {
    const root = await mkdtemp(join(tmpdir(), 'converoom-journal-'));
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const store = createStore(':memory:'),
      core = createCore(store);
    const register = (clientKey: string) => core.dispatch(human, 'repo_register', { path: root, clientKey });
    try {
      mountWorkspace(core, join(root, 'data'));
      await expect(register('failed-key')).rejects.toThrow(/repository root/i);
      await expect(register('failed-key')).rejects.toThrow(/inspect before retry/i);
      store.put('command', human.principalId + ':repo_register:interrupted-key',
        { hash: scopeDigest({ path: root, clientKey: 'interrupted-key' }), status: 'working' });
      now += 7 * 86400000;
      mountWorkspace(core, join(root, 'data'));
      await expect(register('failed-key')).rejects.toThrow(/repository root/i);
      await expect(register('interrupted-key')).rejects.toThrow(/inspect before retry/i);
    } finally {
      clock.mockRestore();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('lists interrupted journal entries to the owner and clears one so its key runs again, never a running one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'converoom-interrupted-'));
    const store = createStore(':memory:'),
      core = createCore(store);
    const agent: Actor = { kind: 'agent', principalId: 'agent', ownerId: human.ownerId };
    const call = (name: string, args: ToolArgs = {}, actor = human) => core.dispatch(actor, name, args);
    const register = (clientKey: string) => call('repo_register', { path: root, clientKey });
    const runningId = human.principalId + ':repo_register:running-key',
      interruptedId = human.principalId + ':repo_register:interrupted-key';
    try {
      mountWorkspace(core, join(root, 'data'));
      const running = expect(register('running-key')).rejects.toThrow(/repository root/i);
      expect(store.get('command', runningId)).toMatchObject({ status: 'working', startedAt: expect.any(Number), args: { path: root } });
      store.put('command', interruptedId, { hash: scopeDigest({ path: root, clientKey: 'interrupted-key' }), status: 'working',
        startedAt: 1, args: { path: root } });
      expect(await call('interrupted_command_list')).toEqual([{ id: interruptedId, command: 'repo_register',
        principalId: human.principalId, clientKey: 'interrupted-key', startedAt: 1, args: { path: root } }]);
      await expect(call('interrupted_command_clear', { entryId: runningId })).rejects.toThrow(/still running/i);
      await expect(call('interrupted_command_list', {}, agent)).rejects.toThrow(/human/i);
      await expect(call('interrupted_command_clear', { entryId: interruptedId }, agent)).rejects.toThrow(/human/i);
      await expect(register('interrupted-key')).rejects.toThrow(/inspect before retry/i);
      expect(await call('interrupted_command_clear', { entryId: interruptedId })).toMatchObject({ cleared: interruptedId, command: 'repo_register' });
      await expect(register('interrupted-key')).rejects.toThrow(/repository root/i);
      await expect(call('interrupted_command_clear', { entryId: interruptedId })).rejects.toThrow(/not found/i);
      await running;
      expect(await call('interrupted_command_list')).toEqual([]);
      const room = (await call('room_create', { title: 'Journal room', objective: 'Record clearing', workflow: 'coding' })) as ToolArgs;
      const roomEntryId = human.principalId + ':attempt_release:room-key';
      store.put('command', roomEntryId, { hash: 'h', status: 'working', startedAt: 2, args: { roomId: room.id, attemptId: 'attempt-1' } });
      expect(await call('interrupted_command_clear', { entryId: roomEntryId, clientKey: 'clear-key' })).toMatchObject({ cleared: roomEntryId });
      expect(store.events(String(room.id)).at(-1)).toMatchObject({ type: 'command.cleared', data: { command: 'attempt_release', clientKey: 'room-key' } });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
