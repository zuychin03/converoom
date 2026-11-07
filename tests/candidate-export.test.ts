import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, scopeDigest } from '../packages/store/src/index.js';
import { createCore } from '../packages/core/src/index.js';
import { mountWorkspace } from '../packages/workspace/src/index.js';
import { run } from '../packages/adapters/src/process.js';
import { bytesDigest } from '../packages/shared/src/hash.js';
import { exportTranscript, type RoomExport } from '../packages/core/src/transcript.js';
import type { Actor, Core, Event, ToolArgs } from '../packages/shared/src/contracts.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
let root: string, donor: string, core: Core, workspace: ReturnType<typeof mountWorkspace>, room: ToolArgs, seat: ToolArgs;
const call = <T = ToolArgs>(name: string, args: ToolArgs = {}, actor = owner) =>
  core.dispatch(actor, name, { ...args, clientKey: crypto.randomUUID() }) as Promise<T>;
const git = async (...args: string[]) => (await run('git', args, donor)).output.trim();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'converoom-export-'));
  donor = join(root, 'donor');
  await mkdir(donor);
  await git('init');
  await git('config', 'core.autocrlf', 'false');
  await writeFile(join(donor, 'README.md'), 'Foundation\n');
  await writeFile(join(donor, 'package.json'), '{}\n');
  await git('add', '.');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture');
  core = createCore(createStore(':memory:'));
  workspace = mountWorkspace(core, join(root, 'data'));
  room = await call('room_create', { title: 'Export', objective: 'Hand the reviewed change over', workflow: 'coding' });
  seat = await call('seat_add', { roomId: room.id, name: 'Worker', product: 'codex', mode: 'managed' });
});
afterEach(async () => {
  await workspace.close();
  core.store.close();
  await rm(root, { recursive: true, force: true });
});
async function candidate(review = true) {
  const repo = await call('repo_register', { path: donor });
  const profile = await call('profile_register', { name: 'Fixture checks', scopePaths: ['README.md'], generatedPaths: [],
    commands: [{ executable: process.execPath, args: ['-e', 'process.exit(0)'], timeoutMs: 5000 }] });
  await call('task_plan', { roomId: room.id, repoId: repo.id, tasks: [{ id: 'readme', title: 'Change the readme', acceptance: 'Reviewed',
    scopePaths: ['README.md'], dependsOn: [], profileId: profile.id }] });
  const attempt = await call('task_claim', { roomId: room.id, taskId: 'readme', seatId: seat.id });
  await writeFile(join(String(attempt.path), 'README.md'), 'Changed\n');
  const manifest = await call('task_submit', { roomId: room.id, attemptId: attempt.id });
  await call('verification_request', { roomId: room.id, manifestId: manifest.id });
  await call('review_submit', { roomId: room.id, manifestId: manifest.id, verdict: 'accept', reason: 'Checked with api_key=supersecret123' });
  const c = await call('integration_prepare', { roomId: room.id, repoId: repo.id, manifestIds: [manifest.id], profileId: profile.id });
  if (review) await call('candidate_review', { roomId: room.id, candidateId: c.id, reason: 'Reviewed combined checks' });
  return { repo, manifest, candidate: c };
}
const exportBranch = (c: ToolArgs, branch: string, extra: ToolArgs = {}, actor = owner) =>
  call('candidate_export_branch', { roomId: room.id, candidateId: c.id, branch, ...extra }, actor);

it('exports a reviewed candidate to a new local branch without touching the checkout and writes a redacted PR brief', async () => {
  const { repo, manifest, candidate: c } = await candidate();
  await call('room_propose_decision', { roomId: room.id, decision: 'Ship the readme change', dissent: ['Keep the old wording'] });
  const head = await git('rev-parse', 'HEAD'), current = await git('symbolic-ref', 'HEAD');
  const result = await exportBranch(c, 'converoom/readme', { message: 'Change the readme' });
  expect(result).toMatchObject({ branch: 'converoom/readme', base: repo.head, candidateId: c.id,
    author: { name: 'Converoom', email: 'converoom@localhost' } });
  const commit = String(result.commit);
  expect(commit).toMatch(/^[0-9a-f]{40}$/);
  expect(await git('rev-parse', 'refs/heads/converoom/readme')).toBe(commit);
  expect(await git('log', '-1', '--format=%an <%ae>|%cn <%ce>|%s|%P', commit))
    .toBe(`Converoom <converoom@localhost>|Converoom <converoom@localhost>|Change the readme|${repo.head}`);
  expect(await git('show', commit + ':README.md')).toBe('Changed');
  expect(await git('status', '--porcelain')).toBe('');
  expect([await git('rev-parse', 'HEAD'), await git('symbolic-ref', 'HEAD')]).toEqual([head, current]);
  expect(await readFile(join(donor, 'README.md'), 'utf8')).toBe('Foundation\n');

  const brief = String(result.brief);
  expect(brief).toContain(`Branch \`converoom/readme\` at commit \`${commit}\`, based on \`${repo.head}\`.`);
  expect(brief).toContain('> Ship the readme change');
  expect(brief).toContain('- Keep the old wording');
  expect(brief).toContain(`| \`readme\` | Change the readme | \`${manifest.id}\` |`);
  expect(brief).toContain('Combined checks passing on content `' + c.resultDigest + '`');
  expect(brief).toContain('api_key=[REDACTED]');
  expect(brief).not.toContain('supersecret123');
  expect(await readFile(String(result.briefPath), 'utf8')).toBe(brief);
  expect(result.briefDigest).toBe(bytesDigest(brief));
  expect(core.store.get<ToolArgs>('candidate', String(c.id))?.exports).toMatchObject([{ branch: 'converoom/readme', commit }]);
  const [event] = core.store.events(String(room.id), 0, 1000).filter((e: Event) => e.type === 'candidate.exported');
  const data = { candidateId: c.id, resultDigest: c.resultDigest, branch: 'converoom/readme', commit, base: repo.head,
    author: { name: 'Converoom', email: 'converoom@localhost' }, briefDigest: result.briefDigest };
  expect(event).toMatchObject({ actorId: 'owner', data: { ...data, actionDigest: scopeDigest(data) } });
  const exported: RoomExport = { schemaVersion: 2, digest: '', events: core.store.events(String(room.id), 0, 1000) as unknown as ToolArgs[],
    records: [{ kind: 'room', id: String(room.id), value: core.store.get<ToolArgs>('room', String(room.id))! }] };
  expect(exportTranscript(exported)).toContain('Candidate exported to the new local branch `converoom/readme` at commit `' + commit + '`, authored as Converoom; nothing was pushed.');
});

it('authors exports as the owner sets and refuses protected, existing, clashing and invalid branch names', async () => {
  const { candidate: c } = await candidate();
  const agent: Actor = { kind: 'agent', principalId: String(seat.principalId), ownerId: 'owner' };
  await expect(call('export_author_update', { name: 'Agent', email: 'agent@example.com' }, agent)).rejects.toMatchObject({ code: 'human_required' });
  await expect(call('export_author_update', { name: 'Duy', email: 'not an email' })).rejects.toMatchObject({ code: 'invalid_argument' });
  expect(await call('export_author_update', { name: 'Duy Nguyen', email: 'duy@example.com' }))
    .toEqual({ exportAuthor: { name: 'Duy Nguyen', email: 'duy@example.com' }, default: false });
  expect(core.store.list<ToolArgs>('authority_audit').map((r) => [r.type, (r.data as ToolArgs).email]))
    .toContainEqual(['export_author.updated', 'duy@example.com']);

  await git('branch', 'feature');
  const current = (await git('symbolic-ref', '--short', 'HEAD'));
  for (const [branch, code] of [['main', 'protected_ref'], ['release/1.0', 'protected_ref'], ['feature', 'ref_exists'], ['Feature', 'ref_exists'],
    ['feature/x', 'ref_exists'], [current + '-new/..', 'invalid_ref'], ['bad..name', 'invalid_ref'], ['@{-1}', 'invalid_ref']])
    await expect(exportBranch(c, branch)).rejects.toMatchObject({ code });
  await expect(exportBranch(c, current)).rejects.toMatchObject({ code: current === 'master' ? 'protected_ref' : 'ref_exists' });
  await expect(exportBranch(c, 'converoom/agent', {}, agent)).rejects.toMatchObject({ code: 'human_required' });
  expect(core.store.events(String(room.id), 0, 1000).some((e: Event) => e.type === 'candidate.exported')).toBe(false);

  const message = 'Change the "readme" & notes\n\nKeeps C:\\path\\ and a trailing quote"';
  const authored = await exportBranch(c, 'converoom/author', { message });
  expect(await git('log', '-1', '--format=%an <%ae>|%cn <%ce>', String(authored.commit)))
    .toBe('Duy Nguyen <duy@example.com>|Duy Nguyen <duy@example.com>');
  expect(await git('log', '-1', '--format=%B', String(authored.commit))).toBe(message);
  expect(await call('export_author_update', {})).toEqual({ exportAuthor: { name: 'Converoom', email: 'converoom@localhost' }, default: true });
  const reset = await exportBranch(c, 'converoom/reset');
  expect(await git('log', '-1', '--format=%an <%ae>', String(reset.commit))).toBe('Converoom <converoom@localhost>');
  await expect(exportBranch(c, 'converoom/reset')).rejects.toMatchObject({ code: 'ref_exists' });
});

it('refuses a candidate that is not reviewed or whose checks no longer match it', async () => {
  const { candidate: c } = await candidate(false);
  await expect(exportBranch(c, 'converoom/unreviewed')).rejects.toMatchObject({ code: 'candidate' });
  await call('candidate_review', { roomId: room.id, candidateId: c.id, reason: 'Reviewed combined checks' });
  const v = core.store.get<ToolArgs>('verification', String(c.verificationId))!;
  core.store.put('verification', String(v.id), { ...v, status: 'failed' });
  await expect(exportBranch(c, 'converoom/changed')).rejects.toMatchObject({ code: 'evidence' });
  expect(await git('for-each-ref', '--format=%(refname)', 'refs/heads/converoom')).toBe('');
});
