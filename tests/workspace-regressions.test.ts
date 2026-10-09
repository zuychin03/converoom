import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { run } from '../packages/adapters/src/process.js';
import type { Actor, Runtime, ToolArgs, Turn } from '../packages/shared/src/contracts.js';
import * as content from '../packages/workspace/src/content.js';
import { attemptEnvironment } from '../packages/workspace/src/index.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let root: string, donor: string, runtime: Runtime, room: ToolArgs, seat: ToolArgs;
let promptSession: () => Promise<string>, closeSession: () => Promise<boolean>;
let startupFailure: Error | undefined;
let startupWait: Promise<void> | undefined;
const call = (name: string, args: ToolArgs = {}) =>
  runtime.core.dispatch(owner, name, { ...args, clientKey: crypto.randomUUID() }) as Promise<ToolArgs>;

beforeEach(async () => {
  promptSession = async () => 'Public fixture answer';
  closeSession = async () => true;
  startupFailure = undefined;
  startupWait = undefined;
  root = await mkdtemp(join(tmpdir(), 'converoom-regression-'));
  donor = join(root, 'donor');
  await mkdir(donor);
  await run('git', ['init'], donor);
  await run('git', ['config', 'core.autocrlf', 'false'], donor);
  await writeFile(join(donor, 'README.md'), 'Foundation\n');
  await writeFile(join(donor, 'package.json'), '{}\n');
  await run('git', ['add', '.'], donor);
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Fixture'], donor);
  runtime = await createRuntime(join(root, 'data'), {
    tickMs: 10,
    startSession: async (product) => {
      if (startupFailure) throw startupFailure;
      await startupWait;
      return {
      id: 'fixture', product, capabilities: [],
      prompt: () => promptSession(),
      cancel: async () => {}, close: () => closeSession(),
      };
    },
  });
  room = await call('room_create', { title: 'Regression', objective: 'Verify coding', workflow: 'coding' });
  seat = await call('seat_add', { roomId: room.id, name: 'Worker', product: 'codex', mode: 'managed' });
  await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await runtime?.stop();
  await rm(root, { recursive: true, force: true });
});

async function claim(claimActor = owner, scopePaths = ['README.md'], fixture?: ToolArgs) {
  const repo = await call('repo_register', { path: donor });
  const profile = await call('profile_register', {
    name: 'Fixture checks',
    commands: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }],
    scopePaths, generatedPaths: [],
    ...(fixture ? { fixture } : {}),
  });
  await call('task_plan', { roomId: room.id, repoId: repo.id, tasks: [{
    id: 'change', title: 'Change', acceptance: 'Reviewed exact content',
    scopePaths, dependsOn: [], profileId: profile.id,
  }] });
  const attempt = await runtime.core.dispatch(claimActor, 'task_claim', {
    roomId: room.id, taskId: 'change', seatId: seat.id, clientKey: crypto.randomUUID(),
  }) as ToolArgs;
  return { repo, profile, attempt };
}
it('revokes a quarantined fixture endpoint through the indexed scheduler lookup', async () => {
  const { attempt } = await claim(owner, ['README.md'], { provider: 'local-kv', seed: { value: 'fixture' } });
  const url = attemptEnvironment(String(attempt.id)).CONVEROOM_FIXTURE_URL;
  expect(url).toBeDefined();
  expect((await fetch(url!)).status).toBe(401);
  runtime.core.store.put('attempt', String(attempt.id), { ...attempt, status: 'quarantined' });
  await expect.poll(() => fetch(url!).then(() => true, () => false), { timeout: 2000 }).toBe(false);
});

it('admits managed coding on a repository with mixed-case filenames', async () => {
  const { attempt } = await claim();
  const turn = await call('turn_request', {
    roomId: room.id, seatId: seat.id, attemptId: attempt.id, prompt: 'Inspect the assigned task',
  });
  await call('permission_grant', { requestId: turn.permissionRequestId });
  await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status)
    .toBe('completed');
  await expect.poll(() => runtime.core.store.get<ToolArgs>('attempt', String(attempt.id))?.status).toBe('completed');
});

async function prepare(extraPath?: string) {
  const setup = await claim(owner, extraPath ? ['README.md', extraPath] : ['README.md']);
  await writeFile(join(String(setup.attempt.path), 'README.md'), 'Changed\n');
  if (extraPath) await writeFile(join(String(setup.attempt.path), extraPath), 'Approved ignored addition\n');
  const manifest = await call('task_submit', { roomId: room.id, attemptId: setup.attempt.id });
  await call('verification_request', { roomId: room.id, manifestId: manifest.id });
  await call('review_submit', { roomId: room.id, manifestId: manifest.id,
    verdict: 'accept', reason: 'Reviewed exact change' });
  const candidate = await call('integration_prepare', { roomId: room.id, repoId: setup.repo.id,
    manifestIds: [manifest.id], profileId: setup.profile.id });
  await call('candidate_review', { roomId: room.id, candidateId: candidate.id,
    reason: 'Reviewed combined checks' });
  return candidate;
}

async function crlfCheckout() {
  await run('git', ['config', 'core.autocrlf', 'true'], donor);
  await rm(join(donor, 'README.md'));
  await rm(join(donor, 'package.json'));
  await run('git', ['checkout', '--', 'README.md', 'package.json'], donor);
  expect(await readFile(join(donor, 'README.md'), 'utf8')).toBe('Foundation\r\n');
}

it('applies a verified candidate to a clean CRLF checkout using its Git line-ending policy', async () => {
  await crlfCheckout();
  const candidate = await prepare();
  await call('candidate_apply', { roomId: room.id, candidateId: candidate.id });
  expect(await readFile(join(donor, 'README.md'), 'utf8')).toBe('Changed\r\n');
  expect(await readFile(join(donor, 'package.json'), 'utf8')).toBe('{}\r\n');
  expect(runtime.core.store.get<ToolArgs>('candidate', String(candidate.id))?.status).toBe('applied');
});

it('preserves dirty CRLF source instead of applying a candidate', async () => {
  await crlfCheckout();
  await writeFile(join(donor, 'README.md'), 'Owner edit\r\n');
  const candidate = await prepare();
  await expect(call('candidate_apply', { roomId: room.id, candidateId: candidate.id }))
    .rejects.toThrow(/dirty|changed/i);
  expect(await readFile(join(donor, 'README.md'), 'utf8')).toBe('Owner edit\r\n');
});

it.each(['--assume-unchanged', '--skip-worktree'])('preserves owner edits hidden by Git %s', async (flag) => {
  await crlfCheckout();
  await run('git', ['update-index', flag, '--', 'README.md'], donor);
  await writeFile(join(donor, 'README.md'), 'Hidden owner edit\r\n');
  const index = await readFile(join(donor, '.git', 'index'));
  const candidate = await prepare();
  await expect(call('candidate_apply', { roomId: room.id, candidateId: candidate.id }))
    .rejects.toThrow(/dirty|changed/i);
  expect(await readFile(join(donor, 'README.md'), 'utf8')).toBe('Hidden owner edit\r\n');
  expect(await readFile(join(donor, '.git', 'index'))).toEqual(index);
});

it('honours committed text attributes and preserves binary bytes', async () => {
  const binary = Buffer.from([0, 10, 13, 10, 255]);
  await writeFile(join(donor, '.gitattributes'), '*.md text eol=lf\npackage.json text eol=crlf\nbinary.bin -text\n');
  await writeFile(join(donor, 'binary.bin'), binary);
  await run('git', ['add', '--', '.gitattributes', 'binary.bin'], donor);
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Attributes fixture'], donor);
  await run('git', ['config', 'core.autocrlf', 'true'], donor);
  await rm(join(donor, 'package.json'));
  await run('git', ['checkout', '--', 'package.json'], donor);
  const candidate = await prepare();
  const index = await readFile(join(donor, '.git', 'index'));
  await call('candidate_apply', { roomId: room.id, candidateId: candidate.id });
  expect(await readFile(join(donor, 'README.md'), 'utf8')).toBe('Changed\n');
  expect(await readFile(join(donor, 'package.json'), 'utf8')).toBe('{}\r\n');
  expect(await readFile(join(donor, 'binary.bin'))).toEqual(binary);
  expect(await readFile(join(donor, '.git', 'index'))).toEqual(index);
});

it('includes approved source additions even when Git ignores their filename', async () => {
  await writeFile(join(donor, '.gitignore'), 'README-extra.md\n');
  await run('git', ['add', '--', '.gitignore'], donor);
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Ignore fixture'], donor);
  const candidate = await prepare('README-extra.md');
  await call('candidate_apply', { roomId: room.id, candidateId: candidate.id });
  expect(await readFile(join(donor, 'README-extra.md'), 'utf8')).toBe('Approved ignored addition\n');
});

it('refuses unsupported attributes from a linked donor without touching owner files', async () => {
  const linked = join(root, 'linked');
  await run('git', ['worktree', 'add', '--detach', linked, 'HEAD'], donor);
  await writeFile(join(donor, '.git', 'info', 'attributes'), 'README.md text eol=lf\n');
  donor = linked;
  await expect(prepare()).rejects.toThrow(/Local Git attributes.*unsupported/);
  expect(await readFile(join(donor, 'README.md'), 'utf8')).toBe('Foundation\n');
});

it('refuses unsupported donor-local filters', async () => {
  await run('git', ['config', 'filter.fixture.clean', 'cat'], donor);
  await expect(prepare()).rejects.toThrow(/Custom Git filters/);
  expect(await readFile(join(donor, 'README.md'), 'utf8')).toBe('Foundation\n');
});

it('lets a polling host orchestrate a managed worker while preserving human execution approval', async () => {
  const host: Actor = { kind: 'agent', principalId: 'polling-host', ownerId: owner.ownerId };
  room = await runtime.core.dispatch(host, 'room_create', { title: 'Host coding', objective: 'Assign work', workflow: 'coding' }) as ToolArgs;
  seat = await call('seat_add', { roomId: room.id, name: 'Managed', product: 'codex', mode: 'managed' });
  await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
  const { attempt } = await claim(host);
  const member = await call('seat_add', { roomId: room.id, name: 'Member', product: 'claude', mode: 'polling' });
  const memberActor: Actor = { kind: 'agent', principalId: String(member.principalId), ownerId: owner.ownerId };
  await expect(runtime.core.dispatch(memberActor, 'task_claim', { roomId: room.id, taskId: 'change', seatId: seat.id }))
    .rejects.toThrow(/host/i);
  const turn = await runtime.core.dispatch(host, 'turn_request', { roomId: room.id, seatId: seat.id,
    attemptId: attempt.id, prompt: 'Inspect the host-assigned task' }) as ToolArgs;
  await expect(runtime.core.dispatch(host, 'permission_grant', { requestId: turn.permissionRequestId })).rejects.toThrow(/Human/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(runtime.core.store.get<Turn>('turn', String(turn.id))?.status).toBe('queued');
  await runtime.core.dispatch(host, 'task_heartbeat', { roomId: room.id, attemptId: attempt.id });
  await call('permission_grant', { requestId: turn.permissionRequestId });
  await expect.poll(() => runtime.core.store.get<ToolArgs>('attempt', String(attempt.id))?.status).toBe('completed');
  await expect(runtime.core.dispatch(memberActor, 'task_submit', { roomId: room.id, attemptId: attempt.id })).rejects.toThrow(/fenced|lease/i);
  const submitted = await runtime.core.dispatch(host, 'task_submit', { roomId: room.id, attemptId: attempt.id }) as ToolArgs;
  expect(submitted.implementerSeatId).toBe(seat.id);
});

it('registers committed public environment examples', async () => {
  await mkdir(join(donor, 'config'));
  await writeFile(join(donor, '.env.example'), 'PUBLIC_URL=http://localhost\n');
  await writeFile(join(donor, 'config', '.env.example'), 'FEATURE_ENABLED=false\n');
  await run('git', ['add', '--', '.env.example', 'config/.env.example'], donor);
  await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Public examples'], donor);
  expect(await call('repo_register', { path: donor })).toMatchObject({ path: await realpath(donor) });
});

it.each(['.env', '.env.production', 'config/.env', 'credentials.json', 'id_rsa'])(
  'rejects committed private configuration %s', async (path) => {
    await mkdir(dirname(join(donor, path)), { recursive: true });
    await writeFile(join(donor, path), 'Private fixture, no real credential\n');
    await run('git', ['add', '--', path], donor);
    await run('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '-m', 'Sensitive filename fixture'], donor);
    await expect(call('repo_register', { path: donor })).rejects.toThrow(/sensitive/i);
  });

it('retains a ready attempt while the human takes more than a minute to approve', async () => {
  const { attempt } = await claim();
  const turn = await call('turn_request', { roomId: room.id, seatId: seat.id,
    attemptId: attempt.id, prompt: 'Inspect the assigned task' });
  const now = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 120000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await call('permission_grant', { requestId: turn.permissionRequestId });
  await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status)
    .toBe('completed');
});

it('allows exact submission more than a minute after confirmed worker completion', async () => {
  const { attempt } = await claim();
  const turn = await call('turn_request', { roomId: room.id, seatId: seat.id,
    attemptId: attempt.id, prompt: 'Inspect the assigned task' });
  await call('permission_grant', { requestId: turn.permissionRequestId });
  await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status)
    .toBe('completed');
  await expect.poll(() => runtime.core.store.get<ToolArgs>('attempt', String(attempt.id))?.status).toBe('completed');
  const now = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 120000);
  expect(await call('task_submit', { roomId: room.id, attemptId: attempt.id }))
    .toMatchObject({ attemptId: attempt.id });
});

it('starts the approval lifetime after slow provisioning finishes', async () => {
  const now = Date.now.bind(Date);
  let elapsed = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => now() + elapsed);
  const put = runtime.core.store.put.bind(runtime.core.store);
  vi.spyOn(runtime.core.store, 'put').mockImplementation((kind, id, value) => {
    put(kind, id, value);
    if (kind === 'attempt' && (value as ToolArgs).status === 'provisioning') elapsed = 120000;
  });
  const { attempt } = await claim();
  expect(Number(attempt.leaseExpiresAt)).toBeGreaterThan(Date.now());
});

it('releases a known-unsent expired reservation without deleting its work', async () => {
  const { attempt } = await claim();
  await writeFile(join(String(attempt.path), 'README.md'), 'Retain this unsubmitted work\n');
  const now = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => now() + 3600001);
  await expect.poll(() => runtime.core.store.get<ToolArgs>('attempt', String(attempt.id))?.status)
    .toBe('quarantined');
  await call('attempt_release', { roomId: room.id, attemptId: attempt.id,
    confirm: true, reason: 'Inspected preserved work and no worker was dispatched' });
  expect(await readFile(join(String(attempt.path), 'README.md'), 'utf8'))
    .toBe('Retain this unsubmitted work\n');
  expect(runtime.core.store.get<ToolArgs>('resource', String(attempt.id))?.status).toBe('released');
  await expect(call('task_submit', { roomId: room.id, attemptId: attempt.id }))
    .rejects.toThrow(/fenced|lease/i);
  const replacement = await call('task_claim', { roomId: room.id, taskId: 'change', seatId: seat.id });
  expect(replacement.id).not.toBe(attempt.id);
});

it('fences a submission already reading files when its reservation is released', async () => {
  const { attempt } = await claim();
  await writeFile(join(String(attempt.path), 'README.md'), 'Pending submission\n');
  const submitting = call('task_submit', { roomId: room.id, attemptId: attempt.id })
    .then(() => ({ committed: true, error: '' }), (e: Error) => ({ committed: false, error: e.message }));
  await call('attempt_release', { roomId: room.id, attemptId: attempt.id,
    confirm: true, reason: 'Preserve and reassign the work' });
  const generation = runtime.core.store.get<ToolArgs>('task', room.id + ':change')?.generation;
  expect(await submitting).toMatchObject({ committed: false, error: expect.stringMatching(/fenced|lease/i) });
  expect(runtime.core.store.get<ToolArgs>('task', room.id + ':change')?.generation).toBe(generation);
  expect(runtime.core.store.list('manifest')).toEqual([]);
});

it('refuses submission if a worker starts dispatching while source files are being read', async () => {
  const { attempt } = await claim();
  const submitting = call('task_submit', { roomId: room.id, attemptId: attempt.id })
    .then(() => ({ committed: true, error: '' }), (e: Error) => ({ committed: false, error: e.message }));
  runtime.core.store.put('turn', 'starting-worker', { id: 'starting-worker', roomId: room.id,
    attemptId: attempt.id, seatId: seat.id, status: 'dispatching', dispatchBoundaryAt: Date.now() });
  expect(await submitting).toMatchObject({ committed: false, error: expect.stringMatching(/stop|worker/i) });
  expect(runtime.core.store.list('manifest')).toEqual([]);
});

it('refuses to release an uncertain dispatched worker without confirmed process stop', async () => {
  const { attempt } = await claim();
  runtime.core.store.put('attempt', String(attempt.id), { ...attempt, status: 'quarantined' });
  runtime.core.store.put('turn', 'uncertain', { id: 'uncertain', roomId: room.id,
    attemptId: attempt.id, seatId: seat.id, status: 'uncertain' });
  await expect(call('attempt_release', { roomId: room.id, attemptId: attempt.id,
    confirm: true, reason: 'Unknown process ownership' })).rejects.toThrow(/stop|uncertain/i);
  expect(runtime.core.store.get<ToolArgs>('attempt', String(attempt.id))?.status).toBe('quarantined');
});

it('retains a failed worker reservation until its asynchronous close confirms stop', async () => {
  const { attempt } = await claim();
  promptSession = async () => { throw new Error('Fixture prompt failed'); };
  let finishClose!: (confirmed: boolean) => void;
  const closing = new Promise<boolean>((resolve) => { finishClose = resolve; });
  closeSession = () => closing;
  try {
    const turn = await call('turn_request', { roomId: room.id, seatId: seat.id,
      attemptId: attempt.id, prompt: 'Fail during execution' });
    await call('permission_grant', { requestId: turn.permissionRequestId });
    await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status).toBe('failed');
    await expect(call('attempt_release', { roomId: room.id, attemptId: attempt.id,
      confirm: true, reason: 'Close has not confirmed stop' })).rejects.toThrow(/stop|uncertain/i);
    finishClose(true);
    await expect.poll(() => runtime.core.store.get<ToolArgs>('attempt', String(attempt.id))?.processStoppedAt)
      .toEqual(expect.any(Number));
    expect(await call('attempt_release', { roomId: room.id, attemptId: attempt.id,
      confirm: true, reason: 'Owned worker stopped' })).toMatchObject({ released: attempt.id });
  } finally {
    finishClose(true);
  }
});

it('retains an uncertain native startup without inventing process-stop evidence', async () => {
  const { attempt } = await claim();
  startupFailure = new Error('Native initialisation failed after launch');
  const turn = await call('turn_request', { roomId: room.id, seatId: seat.id,
    attemptId: attempt.id, prompt: 'Initialise the worker' });
  await call('permission_grant', { requestId: turn.permissionRequestId });
  await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status).toBe('uncertain');
  expect(runtime.core.store.get<ToolArgs>('attempt', String(attempt.id))?.processStoppedAt).toBeUndefined();
  await expect(call('attempt_release', { roomId: room.id, attemptId: attempt.id,
    confirm: true, reason: 'Startup stop is unknown' })).rejects.toThrow(/stop|uncertain/i);
});

it('does not resurrect an attempt fenced while native startup is pending', async () => {
  const { attempt } = await claim();
  let finishStartup!: () => void;
  startupWait = new Promise<void>((resolve) => { finishStartup = resolve; });
  let prompted = false;
  promptSession = async () => { prompted = true; return 'Must not run'; };
  try {
    const turn = await call('turn_request', { roomId: room.id, seatId: seat.id,
      attemptId: attempt.id, prompt: 'Pending startup' });
    await call('permission_grant', { requestId: turn.permissionRequestId });
    await expect.poll(() => runtime.core.store.list('bridge').length).toBe(1);
    runtime.core.store.put('attempt', String(attempt.id), { ...attempt, status: 'quarantined', leaseExpiresAt: 0 });
    finishStartup();
    await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status).toBe('cancelled');
    expect(prompted).toBe(false);
    expect(runtime.core.store.get<ToolArgs>('attempt', String(attempt.id))?.status).toBe('quarantined');
  } finally { finishStartup(); }
});

it('preserves quarantine applied while managed admission reads the source snapshot', async () => {
  const { attempt } = await claim();
  let finishRead!: () => void, reading = false, prompted = false;
  const pending = new Promise<void>((resolve) => { finishRead = resolve; });
  const snapshot = content.snapshot;
  vi.spyOn(content, 'snapshot').mockImplementation(async (path, generated) => {
    if (path === attempt.path) { reading = true; await pending; }
    return snapshot(path, generated);
  });
  promptSession = async () => { prompted = true; return 'Must not execute'; };
  try {
    const turn = await call('turn_request', { roomId: room.id, seatId: seat.id,
      attemptId: attempt.id, prompt: 'Read the source' });
    await call('permission_grant', { requestId: turn.permissionRequestId });
    await expect.poll(() => reading).toBe(true);
    runtime.core.store.put('attempt', String(attempt.id), { ...attempt, status: 'quarantined' });
    finishRead();
    await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status).toBe('failed');
    expect(prompted).toBe(false);
    expect(runtime.core.store.get<ToolArgs>('attempt', String(attempt.id))?.status).toBe('quarantined');
  } finally { finishRead(); }
});
