import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile, readdir, realpath, rm, lstat, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ConveroomError as E,
  requiredString as str,
  type Core,
  type Actor,
  type ToolArgs,
  type Review,
  type ReviewAnnotation,
  type Seat,
  type Turn,
} from '../../shared/src/contracts.js';
import { splitLines } from '../../shared/src/diff.js';
import { scopeDigest, redactPublic } from '../../store/src/index.js';
import { cancelTurn, RESULT_EXPIRY_BATCH, RESULT_RETENTION_MS } from '../../core/src/index.js';
import { authority, installationAuthority } from '../../core/src/audit.js';
import { bytesDigest } from '../../shared/src/hash.js';
import { run, canonicalRoot } from '../../adapters/src/process.js';
import {
  snapshot,
  writeSnapshot,
  validateSnapshot,
  delta,
  compose,
  safeRelative,
  type Snapshot,
  type DeltaFile,
} from './content.js';
import { provisionFixture, type FixtureBroker, type FixtureProfile } from './broker.js';
import { attemptTree, checkpointStore, ignoredPaths, CHECKPOINT_LIMIT, type Checkpoint } from './checkpoints.js';
import { treeDiff } from './diff.js';
import { prBrief } from './brief.js';
const executionEnvironments = new Map<string, NodeJS.ProcessEnv>();
export const attemptEnvironment = (id: string) => executionEnvironments.get(id) ?? {};
interface Repo {
  id: string;
  name: string;
  path: string;
  ownerId: string;
  head: string;
  foundation: string;
  foundationPath: string;
  originalDigest: string;
}
interface Profile {
  id: string;
  name: string;
  ownerId: string;
  commands: { executable: string; args: string[]; timeoutMs: number }[];
  scopePaths: string[];
  generatedPaths: string[];
  digest: string;
  expiresAt: number;
  containment: string;
  fixture?: FixtureProfile;
}
interface Task {
  id: string;
  roomId: string;
  repoId: string;
  title: string;
  acceptance: string;
  scopePaths: string[];
  dependsOn: string[];
  profileId: string;
  status: string;
  generation: number;
  manifestId?: string;
}
export interface Attempt {
  id: string;
  roomId: string;
  taskId: string;
  repoId: string;
  seatId: string;
  path: string;
  status: string;
  generation: number;
  effectiveBase: string;
  basePath: string;
  dependencies: string[];
  profileId: string;
  leaseExpiresAt: number;
  wallDeadline: number;
  approvalDeadline?: number;
  submissionDeadline?: number;
  processStoppedAt?: number;
  resourceId: string;
  sessionId?: string;
  reworkReviewId?: string;
  treeDigest?: string;
  checkpointSeq?: number;
  rollbackSeq?: number;
}
interface Manifest {
  id: string;
  roomId: string;
  taskId: string;
  attemptId: string;
  repoId: string;
  implementerSeatId: string;
  foundation: string;
  dependencies: string[];
  effectiveBase: string;
  deltaDigest: string;
  resultDigest: string;
  profileId: string;
  dataPath: string;
  createdAt: number;
  files: Omit<DeltaFile, 'bytes'>[];
  diff: string;
}
interface Candidate {
  id: string;
  roomId: string;
  repoId: string;
  manifestIds: string[];
  profileId: string;
  resultDigest: string;
  path: string;
  status: string;
  verificationId?: string;
  createdAt: number;
  targetDigest: string;
  checkoutSettings: Record<string, string>;
}
interface Verification {
  id: string;
  roomId: string;
  manifestId?: string;
  candidateId?: string;
  contentDigest: string;
  profileId: string;
  profileDigest: string;
  environmentDigest: string;
  environment: ToolArgs;
  sourceBefore: string;
  sourceAfter: string;
  status: string;
  workspace: string;
  checks: ToolArgs[];
}
export interface CleanupEntry {
  name: string;
  path: string;
  kind: 'attempt' | 'candidate' | 'verification' | 'foundation' | 'unknown';
  id?: string;
  roomId?: string;
  roomTitle?: string;
  repoName?: string;
  taskId?: string;
  status?: string;
  resourceId?: string;
  bytes: number;
  createdAt?: number;
  removable: boolean;
  reason?: string;
  detail: string;
  keepUntil?: number;
  contentDigest?: string;
}
// SPEC retention proposal: temporary cancelled workspaces stay for 7 days.
const RELEASE_RETENTION_MS = 7 * 86400000;
const ACTIVE_ATTEMPT = ['provisioning', 'ready', 'running', 'checkpointing', 'rolling_back', 'submitting', 'completed', 'draining'];
const ACTIVE_CANDIDATE = ['prepared', 'verified', 'accepted', 'applying'];
const RESUMED = 'An earlier removal did not finish';
const DEFAULT_EXPORT_AUTHOR = { name: 'Converoom', email: 'converoom@localhost' };
// Names teams commonly protect are refused even before they exist; existing branches are refused separately.
const PROTECTED_BRANCH = /^(main|master|develop|development|trunk|production|prod|stable|staging|release|HEAD)$|^(release|hotfix)\//i;
export function mountWorkspace(
  core: Core,
  dataDir: string,
  options: { checkpointBudget?: number } = {},
): {
  close(): Promise<void>;
  revoke(id: string): Promise<void>;
  expireJournal(before: number, limit: number): number;
  checkpoint(attemptId: string, turnId: string): Promise<void>;
} {
  const s = core.store;
  const checkpoints = checkpointStore(s, dataDir, options.checkpointBudget);
  const workspaceAccess = (a: Actor, id: string) => {
    const room = core.requireRoom(a, id);
    if (a.kind === 'agent' && core.requireSeat(a, id).role === 'observer')
      throw new E('observer', 'Observer cannot mutate or execute workspace operations', 403);
    if (room.lifecycle !== 'active')
      throw new E('inactive', 'Room must be active for workspace operations', 409);
    return room;
  };
  const brokers = new Map<string, FixtureBroker>();
  const provision = async (id: string, p: Profile) => {
    const paths = {
      TEMP: join(dataDir, 'resources', id, 'tmp'),
      TMP: join(dataDir, 'resources', id, 'tmp'),
      TMPDIR: join(dataDir, 'resources', id, 'tmp'),
      CONVEROOM_BUILD_DIR: join(dataDir, 'resources', id, 'build'),
      CONVEROOM_TEST_DATA: join(dataDir, 'resources', id, 'test-data'),
      CONVEROOM_ATTEMPT_ID: id,
    };
    let broker: FixtureBroker | undefined;
    if (p.fixture) {
      broker = await provisionFixture(id, p.fixture);
      brokers.set(id, broker);
    }
    const env = {
      ...paths,
      ...(broker
        ? {
            CONVEROOM_FIXTURE_URL: broker.url,
            CONVEROOM_FIXTURE_TOKEN: broker.token,
            CONVEROOM_FIXTURE_NAMESPACE: id,
          }
        : {}),
    };
    executionEnvironments.set(id, env);
    return broker;
  };
  const get = <T>(kind: string, id: string): T => {
    const r = s.get<T>(kind, id);
    if (!r) throw new E('not_found', kind + ' not found', 404);
    return r;
  };
  const task = (roomId: string, id: string) => get<Task>('task', roomId + ':' + id);
  const attemptAccess = (a: Actor, roomId: string, at: Attempt) => {
    if (a.kind === 'human') return true;
    const seat = core.requireSeat(a, roomId);
    return at.seatId === seat.id || core.requireRoom(a, roomId).hostSeatId === seat.id;
  };
  // An uncertain outcome stops blocking release once a process stop after that turn's dispatch is confirmed.
  const workerStopped = (at: Attempt) => !s.list<Turn & { dispatchBoundaryAt?: number; sessionId?: string }>('turn')
    .some((turn) => turn.attemptId === at.id && (
      ['running', 'dispatching', 'cancelling'].includes(turn.status) || (turn.status === 'uncertain' && !turn.dispatchBoundaryAt) ||
      (turn.dispatchBoundaryAt && (!at.processStoppedAt || at.processStoppedAt < turn.dispatchBoundaryAt)) ||
      (turn.sessionId && !at.processStoppedAt)
    ));
  const putTask = (t: Task) => s.put('task', t.roomId + ':' + t.id, t);
  const ev = (a: Actor, r: string, n: string, x: ToolArgs) => s.append(r, n, a.principalId, x);
  const load = async (path: string): Promise<Snapshot> => {
    const x = JSON.parse(await readFile(path, 'utf8')) as Snapshot;
    validateSnapshot(x);
    return x;
  };
  const save = async (id: string, content: unknown) => {
    const path = join(dataDir, 'artefacts', id + '.json');
    await mkdir(join(dataDir, 'artefacts'), { recursive: true });
    await writeFile(path, JSON.stringify(content), { mode: 0o600 });
    return path;
  };
  // Entries this daemon is still running; any other working entry was interrupted.
  const running = new Set<string>();
  // Bounded identifiers from the request, enough to inspect an interrupted entry.
  const requestSummary = (x: ToolArgs) => Object.fromEntries(Object.entries(redactPublic(x)).filter(([key, value]) => key !== 'clientKey' &&
    (typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && value.length <= 1024) ||
      (Array.isArray(value) && value.length <= 100 && value.every((item) => typeof item === 'string' && item.length <= 256)))));
  const journal = async (a: Actor, n: string, x: ToolArgs, fn: () => Promise<unknown>) => {
    const key = a.principalId + ':' + n + ':' + String(x.clientKey ?? randomUUID()),
      hash = scopeDigest(x),
      prior = s.get<{ hash: string; status: string; result?: unknown }>('command', key);
    if (prior) {
      if (prior.hash !== hash)
        throw new E('idempotency_conflict', 'Client key reused with a different payload', 409);
      if (prior.status === 'done') return prior.result;
      throw new E(
        'uncertain_command',
        'Operation is active or uncertain; inspect before retry',
        409,
      );
    }
    s.put('command', key, { hash, status: 'working', startedAt: Date.now(), args: requestSummary(x) });
    running.add(key);
    try {
      const result = await fn();
      s.put('command', key, { hash, status: 'done', result, at: Date.now() });
      return result;
    } catch (e) {
      s.put('command', key, {
        hash,
        status: 'failed',
        error: e instanceof E ? e.code : 'execution_failure',
        at: Date.now(),
      });
      throw e;
    } finally {
      running.delete(key);
    }
  };
  // A working entry's outcome is unknown, so its key stays fenced until inspected rather than expiring.
  const expireJournal = (before: number, limit: number) => s.expireRecords('command', ['done', 'failed'], before, limit);
  const interruptedEntry = (id: string, entry: { startedAt?: number; args?: ToolArgs }, seats: Seat[]) => {
    const [principalId, command] = id.split(':', 2), seat = seats.find((x) => x.principalId === principalId);
    return { id, command, principalId, clientKey: id.slice(principalId.length + command.length + 2),
      ...(entry.startedAt === undefined ? {} : { startedAt: entry.startedAt }), ...(entry.args ? { args: entry.args } : {}),
      ...(seat ? { seat: { id: seat.id, roomId: seat.roomId, name: seat.name, product: seat.product } } : {}) };
  };
  core.register('interrupted_command_list', (a) => {
    core.requireOwner(a);
    const seats = s.list<Seat>('seat');
    return s.entries<{ startedAt?: number; args?: ToolArgs }>('command', { status: ['working'] })
      .filter((e) => !running.has(e.id)).map((e) => interruptedEntry(e.id, e.value, seats));
  });
  core.register('interrupted_command_clear', (a, x) => {
    core.requireOwner(a);
    const id = str(x, 'entryId', 1024), entry = s.get<{ status: string; startedAt?: number; args?: ToolArgs }>('command', id);
    if (entry?.status !== 'working') throw new E('not_found', 'Interrupted command not found', 404);
    if (running.has(id)) throw new E('active_command', 'Command is still running; wait for it to finish', 409);
    const cleared = interruptedEntry(id, entry, s.list<Seat>('seat')), roomId = entry.args?.roomId;
    s.transaction(() => {
      s.remove('command', id);
      if (typeof roomId === 'string' && s.get('room', roomId))
        ev(a, roomId, 'command.cleared', { command: cleared.command, clientKey: cleared.clientKey });
    });
    return { cleared: id, command: cleared.command, principalId: cleared.principalId, clientKey: cleared.clientKey };
  });
  const repoAccess = (a: Actor, id: string) => {
    const r = get<Repo>('repo', id);
    if (r.ownerId !== a.ownerId) throw new E('forbidden', 'Repository owner mismatch', 403);
    return r;
  };
  const profile = (a: Actor, id: string) => {
    const p = get<Profile>('profile', id);
    if (
      p.ownerId !== a.ownerId ||
      p.expiresAt < Date.now() ||
      scopeDigest({ ...p, digest: undefined }) !== p.digest
    )
      throw new E('profile', 'Approved check profile missing/expired', 403);
    return p;
  };
  const clone = async (repo: Repo, id: string): Promise<string> => {
    const path = join(dataDir, 'workspaces', id);
    await mkdir(join(dataDir, 'workspaces'), { recursive: true });
    const result = await run(
      'git',
      [
        '-c',
        'core.hooksPath=' + join(dataDir, 'empty-hooks'),
        'clone',
        '--no-local',
        '--no-hardlinks',
        '--no-checkout',
        repo.path,
        path,
      ],
      dataDir,
      120000,
    );
    if (result.exitCode) throw new E('clone_failed', 'Independent clone failed');
    for (const args of [
      ['remote', 'remove', 'origin'],
      [
        '-c',
        'core.autocrlf=false',
        '-c',
        'core.hooksPath=' + join(dataDir, 'empty-hooks'),
        'checkout',
        '--detach',
        repo.head,
      ],
      ['config', 'core.hooksPath', join(dataDir, 'empty-hooks')],
      ['config', 'core.autocrlf', 'false'],
    ]) {
      const r = await run('git', args, path);
      if (r.exitCode) throw new E('clone_failed', 'Independent checkout failed');
    }
    if ((await run('git', ['remote'], path)).output.trim())
      throw new E('clone_remote', 'Clone retains a donor remote');
    return path;
  };
  const checkoutSettings = async (path: string) => {
    const attributes = await run('git', ['rev-parse', '--git-path', 'info/attributes'], path);
    if (attributes.exitCode) throw new E('checkout_policy', 'Cannot inspect the Git attributes path');
    if ((await readFile(resolve(path, attributes.output.trim()), 'utf8').catch((e: NodeJS.ErrnoException) => {
      if (e.code === 'ENOENT') return '';
      throw e;
    })).trim()) throw new E('checkout_policy', 'Local Git attributes are unsupported; use tracked .gitattributes');
    const filters = await run('git', ['config', '--local', '--get-regexp', '^filter\\.'], path);
    if (filters.exitCode === 0)
      throw new E('checkout_policy', 'Custom Git filters or external attributes require explicit support');
    if (filters.exitCode !== 1) throw new E('checkout_policy', 'Cannot inspect Git conversion settings');
    const externalAttributes = await run('git', ['config', '--get', 'core.attributesFile'], path);
    if (externalAttributes.exitCode === 0)
      throw new E('checkout_policy', 'External Git attributes require explicit support');
    if (externalAttributes.exitCode !== 1) throw new E('checkout_policy', 'Cannot inspect external attributes');
    const settings: Record<string, string> = {};
    for (const [key, fallback] of [['core.autocrlf', 'false'], ['core.eol', 'native']]) {
      const result = await run('git', ['config', '--get', key], path);
      if (![0, 1].includes(result.exitCode)) throw new E('repository', 'Cannot read checkout policy');
      settings[key] = result.exitCode === 1 ? fallback : result.output.trim();
    }
    return settings;
  };
  const materializeCheckout = async (repo: Repo, id: string, content: Snapshot,
    settings: Record<string, string>) => {
    const path = await clone(repo, 'apply-' + id);
    await writeSnapshot(path, content);
    const git = async (args: string[]) => {
      const result = await run('git', args, path);
      if (result.exitCode) throw new E('checkout_conversion', 'Git checkout conversion failed');
    };
    await git(['add', '--all', '--force', '--', '.']);
    const empty: Snapshot = { files: [], digest: scopeDigest([]) };
    await writeSnapshot(path, empty);
    await git(['checkout-index', '--all', '--force']);
    if ((await snapshot(path)).digest !== content.digest)
      throw new E('checkout_conversion', 'Git filters changed the verified content');
    for (const [key, value] of Object.entries(settings)) await git(['config', key, value]);
    await writeSnapshot(path, empty);
    await git(['checkout-index', '--all', '--force']);
    return snapshot(path);
  };
  const dependencies = (t: Task): Manifest[] => {
    const visited = new Set<string>(),
      out: Manifest[] = [];
    const visit = (id: string) => {
      if (visited.has(id)) return;
      visited.add(id);
      const dep = task(t.roomId, id);
      if (dep.status !== 'accepted' || !dep.manifestId)
        throw new E('dependency', 'Prerequisites must be accepted', 409);
      for (const d of dep.dependsOn) visit(d);
      out.push(get<Manifest>('manifest', dep.manifestId));
    };
    t.dependsOn.forEach(visit);
    return out;
  };
  const manifestData = async (m: Manifest) => {
    const value = JSON.parse(await readFile(m.dataPath, 'utf8')) as {
      snapshot: Snapshot;
      delta: DeltaFile[];
    };
    validateSnapshot(value.snapshot);
    if (value.snapshot.digest !== m.resultDigest || scopeDigest(value.delta) !== m.deltaDigest)
      throw new E('digest_mismatch', 'Immutable submission changed');
    return value;
  };
  const assertCurrent = (m: Manifest) => {
    const t = task(m.roomId, m.taskId);
    if (
      t.manifestId !== m.id ||
      scopeDigest(dependencies(t).map((d) => d.id)) !== scopeDigest(m.dependencies)
    )
      throw new E('dependency_changed', 'Current submission/prerequisite evidence required', 409);
  };
  const freshChecks = async (
    a: Actor,
    roomId: string,
    repo: Repo,
    content: Snapshot,
    p: Profile,
    target: { manifestId?: string; candidateId?: string },
  ): Promise<Verification> => {
    const id = randomUUID(),
      path = await clone(repo, 'verify-' + id);
    await writeSnapshot(path, content);
    const root = join(dataDir, 'resources', id);
    for (const d of ['tmp', 'build', 'logs', 'test-data'])
      await mkdir(join(root, d), { recursive: true });
    const fixture = await provision(id, p);
    const environment = {
      id,
      workspace: path,
      temp: join(root, 'tmp'),
      build: join(root, 'build'),
      logs: join(root, 'logs'),
      testData: join(root, 'test-data'),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      profileDigest: p.digest,
      containment: 'trusted-local advisory',
      fresh: true,
      services: fixture
        ? [
            {
              provider: 'local-kv',
              url: fixture.url,
              namespace: id,
              ownerPid: process.pid,
              ownership: 'bound by this runtime',
              credential: '[redacted]',
            },
          ]
        : [],
    };
    s.put('resource', id, { ...environment, roomId, status: 'active', createdAt: Date.now() });
    const before = await snapshot(path, p.generatedPaths),
      checks: ToolArgs[] = [];
    try {
      for (const command of p.commands) {
        const result = await run(command.executable, command.args, path, command.timeoutMs, {
          ...attemptEnvironment(id),
          NODE_ENV: 'test',
        });
        checks.push({ ...command, ...result });
        if (result.exitCode !== 0 || result.timedOut) break;
      }
    } catch (e) {
      checks.push({
        exitCode: -1,
        output: redactPublic(e instanceof Error ? e.message : 'Execution error'),
      });
    }
    const after = await snapshot(path, p.generatedPaths),
      conforming = !fixture || fixture.requests > 0,
      passing =
        conforming &&
        before.digest === content.digest &&
        after.digest === content.digest &&
        checks.length === p.commands.length &&
        checks.every((c) => c.exitCode === 0 && !c.timedOut);
    await fixture?.close();
    brokers.delete(id);
    executionEnvironments.delete(id);
    const v: Verification = {
      id,
      roomId,
      ...target,
      contentDigest: content.digest,
      profileId: p.id,
      profileDigest: p.digest,
      environmentDigest: scopeDigest(environment),
      environment,
      sourceBefore: before.digest,
      sourceAfter: after.digest,
      status: passing ? 'passing' : conforming ? 'failed' : 'blocked',
      workspace: path,
      checks,
    };
    s.put('verification', id, v);
    // Native checks can spawn descendants. Keep resources quarantined until ownership is inspected.
    s.put('resource', id, {
      ...environment,
      roomId,
      status: 'quarantined',
      reason: 'Native process descendants require supervision acceptance before reuse',
    });
    ev(a, roomId, 'verification.completed', {
      id,
      status: v.status,
      contentDigest: content.digest,
    });
    return v;
  };
  core.register('repo_register', (a, x) =>
    journal(a, 'repo_register', x, async () => {
      core.requireOwner(a);
      const path = await realpath(str(x, 'path'));
      const headResult = await run('git', ['rev-parse', 'HEAD'], path);
      const rootResult = await run('git', ['rev-parse', '--show-toplevel'], path);
      if (
        headResult.exitCode ||
        rootResult.exitCode ||
        (await canonicalRoot(path)) !== (await canonicalRoot(rootResult.output.trim()))
      )
        throw new E('repository', 'Select the Git repository root with a committed foundation');
      const tracked = await run('git', ['ls-files', '-z'], path);
      if (
        tracked.output
          .split('\0')
          .some((p) => /(^|\/)(\.env(?:\..*)?|id_rsa|credentials(?:\.json)?)$/i.test(p) &&
            !/(^|\/)\.env\.example$/i.test(p))
      )
        throw new E(
          'sensitive_source',
          'Tracked sensitive configuration requires a sanitised foundation',
        );
      const r: Repo = {
        id: randomUUID(),
        path,
        name: String(x.name ?? path.split(/[\\/]/).at(-1)),
        ownerId: a.ownerId,
        head: headResult.output.trim(),
        foundation: '',
        foundationPath: '',
        originalDigest: (await snapshot(path, ['node_modules', 'dist', '.next', 'build'])).digest,
      };
      const foundationRoot = await clone(r, 'foundation-' + r.id),
        content = await snapshot(foundationRoot);
      r.foundation = content.digest;
      r.foundationPath = await save('foundation-' + r.id, content);
      s.put('repo', r.id, r);
      return r;
    }),
  );
  core.register('repo_list', (a) => s.list<Repo>('repo').filter((r) => r.ownerId === a.ownerId));
  const registerProfile = (a: Actor, x: ToolArgs) => {
    core.requireOwner(a);
    const commands = x.commands as Profile['commands'];
    if (!Array.isArray(commands) || !commands.length || commands.length > 20)
      throw new E('profile', 'Explicit commands required');
    for (const command of commands) {
      if (
        typeof command.executable !== 'string' ||
        !command.executable ||
        !Array.isArray(command.args) ||
        command.args.some((v) => typeof v !== 'string') ||
        command.args.length > 100
      )
        throw new E('profile', 'Invalid argv command');
      command.timeoutMs = Math.max(100, Math.min(1800000, Number(command.timeoutMs ?? 120000)));
    }
    const scopePaths = (x.scopePaths ?? []) as string[],
      generatedPaths = (x.generatedPaths ?? ['node_modules', 'dist', '.next', 'build']) as string[];
    if (!Array.isArray(scopePaths) || !scopePaths.length || !Array.isArray(generatedPaths))
      throw new E('profile', 'Explicit source scopes required');
    [...scopePaths, ...generatedPaths].forEach(safeRelative);
    if (x.services || x.credentials || x.env)
      throw new E(
        'profile_unsupported',
        'Arbitrary services/hosted credentials are disabled. Use the scoped local-kv fixture broker',
      );
    const fixture = x.fixture as FixtureProfile | undefined;
    if (
      fixture &&
      (fixture.provider !== 'local-kv' ||
        !fixture.seed ||
        Object.values(fixture.seed).some((v) => typeof v !== 'string' || v.length > 4096))
    )
      throw new E('fixture', 'Only bounded local-kv public fixture data is supported');
    const p: Profile = {
      id: randomUUID(),
      name: str(x, 'name', 128),
      ownerId: a.ownerId,
      commands,
      scopePaths,
      generatedPaths,
      digest: '',
      expiresAt: Date.now() + 86400000,
      containment: 'trusted-local advisory',
      ...(fixture ? { fixture } : {}),
    };
    p.digest = scopeDigest({ ...p, digest: undefined });
    s.put('profile', p.id, p);
    return p;
  };
  core.register('profile_register', registerProfile);
  core.register('resource_profile_register', registerProfile);
  core.register('resource_profile_list', (a) =>
    s.list<Profile>('profile').filter((p) => p.ownerId === a.ownerId),
  );
  core.register('task_plan', (a, x) => {
    const roomId = str(x, 'roomId');
    const r = workspaceAccess(a, roomId);
    if (a.kind === 'agent' && r.hostSeatId !== core.requireSeat(a, roomId).id)
      throw new E('host', 'Host authority required', 403);
    const repo = repoAccess(a, str(x, 'repoId')),
      items = x.tasks as Task[];
    if (!Array.isArray(items) || !items.length || items.length > 100)
      throw new E('tasks', 'Bounded task list required');
    const ids = new Set(items.map((t) => t.id));
    if (ids.size !== items.length) throw new E('tasks', 'Duplicate task ID');
    const all = new Map(
      s
        .list<Task>('task')
        .filter((t) => t.roomId === roomId)
        .map((t) => [t.id, t]),
    );
    for (const t of items) {
      if (all.has(t.id)) throw new E('task_exists', 'Task already exists', 409);
      if (
        typeof t.id !== 'string' ||
        !t.id ||
        !t.title ||
        !t.acceptance ||
        !Array.isArray(t.scopePaths) ||
        !t.scopePaths.length ||
        !Array.isArray(t.dependsOn)
      )
        throw new E('tasks', 'Missing task scope/criteria/prerequisites');
      t.scopePaths.forEach(safeRelative);
      const approved = profile(a, t.profileId);
      if (
        t.scopePaths.some(
          (path) =>
            !approved.scopePaths.some((scope) => path === scope || path.startsWith(scope + '/')),
        )
      )
        throw new E('scope', 'Task exceeds the human-approved profile scope', 403);
      all.set(t.id, t);
    }
    const visiting = new Set(),
      visited = new Set();
    const visit = (id: string) => {
      if (visiting.has(id)) throw new E('cycle', 'Cyclic task dependencies');
      if (visited.has(id)) return;
      const t = all.get(id);
      if (!t) throw new E('dependency', 'Unknown prerequisite');
      visiting.add(id);
      t.dependsOn.forEach(visit);
      visiting.delete(id);
      visited.add(id);
    };
    items.forEach((t) => visit(t.id));
    for (const t of items)
      putTask({ ...t, roomId, repoId: repo.id, status: 'ready', generation: 0 });
    ev(a, roomId, 'tasks.planned', { taskIds: items.map((t) => t.id) });
    return items.map((t) => task(roomId, t.id));
  });
  core.register('task_get', (a, x) => {
    const id = str(x, 'roomId');
    core.requireRoom(a, id);
    return task(id, str(x, 'taskId'));
  });
  core.register('task_claim', (a, x) =>
    journal(a, 'task_claim', x, async () => {
      const roomId = str(x, 'roomId');
      workspaceAccess(a, roomId);
      const t = task(roomId, str(x, 'taskId')),
        repo = repoAccess(a, t.repoId),
        p = profile(a, t.profileId),
        seatId = x.seatId ? str(x, 'seatId') : core.requireSeat(a, roomId).id,
        seat = get<Seat>('seat', seatId);
      // FR-57: a rework attempt carries the review that asked for it, whose notes go into its first turn.
      const rework = t.status === 'rework' && t.manifestId ? s.list<Review>('review', { roomId })
        .filter((v) => v.manifestId === t.manifestId).sort((u, v) => v.createdAt - u.createdAt)[0] : undefined;
      if (a.kind === 'agent') {
        const caller = core.requireSeat(a, roomId);
        if (seatId !== caller.id && core.requireRoom(a, roomId).hostSeatId !== caller.id)
          throw new E('host', 'Only the room host can claim work for another managed seat', 403);
      }
      if (
        seat.roomId !== roomId ||
        seat.mode !== 'managed' ||
        seat.status === 'left' ||
        seat.role === 'observer'
      )
        throw new E('admission', 'Coding requires a runtime-managed seat', 403);
      const deps = dependencies(t),
        base = compose(
          await load(repo.foundationPath),
          await Promise.all(deps.map(async (m) => (await manifestData(m)).delta)),
        ),
        id = randomUUID();
      const attempt: Attempt = {
        id,
        roomId,
        taskId: t.id,
        repoId: t.repoId,
        seatId,
        path: join(dataDir, 'workspaces', id),
        status: 'provisioning',
        generation: t.generation + 1,
        effectiveBase: base.digest,
        basePath: '',
        dependencies: deps.map((m) => m.id),
        profileId: p.id,
        leaseExpiresAt: 0,
        wallDeadline: 0,
        resourceId: id,
        ...(rework?.verdict === 'reject' ? { reworkReviewId: rework.id } : {}),
      };
      s.transaction(() => {
        if (
          ['claimed', 'provisioning', 'submitted', 'accepted'].includes(task(roomId, t.id).status)
        )
          throw new E('claimed', 'Task already claimed', 409);
        for (const active of s.list<Attempt>('attempt'))
          if (
            ['provisioning', 'ready', 'running', 'submitting', 'uncertain', 'quarantined', 'draining'].includes(
              active.status,
            ) &&
            get<Repo>('repo', active.repoId).path.toLowerCase() === repo.path.toLowerCase()
          ) {
            const scopes = task(active.roomId, active.taskId).scopePaths;
            const norm = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
            if (
              t.scopePaths.some((p) =>
                scopes.some(
                  (q) =>
                    norm(p) === norm(q) ||
                    norm(p).startsWith(norm(q) + '/') ||
                    norm(q).startsWith(norm(p) + '/'),
                ),
              )
            )
              throw new E('resource_conflict', 'Source scopes reserved by another attempt', 409);
          }
        putTask({ ...t, status: 'provisioning', generation: attempt.generation });
        s.put('attempt', id, attempt);
        s.put('resource', id, {
          id,
          roomId,
          status: 'provisioning',
          scopePaths: t.scopePaths,
          repoId: repo.id,
          containment: 'trusted-local advisory',
        });
      });
      try {
        attempt.path = await clone(repo, id);
        await writeSnapshot(attempt.path, base);
        attempt.basePath = await save('base-' + id, base);
        for (const d of ['tmp', 'build', 'logs', 'test-data'])
          await mkdir(join(dataDir, 'resources', id, d), { recursive: true });
        const fixture = await provision(id, p);
        attempt.status = 'ready';
        attempt.approvalDeadline = Date.now() + 3600000;
        attempt.leaseExpiresAt = attempt.approvalDeadline;
        s.put('attempt', id, attempt);
        putTask({ ...task(roomId, t.id), status: 'claimed' });
        s.put('resource', id, {
          id,
          roomId,
          status: 'active',
          scopePaths: t.scopePaths,
          repoId: repo.id,
          temp: join(dataDir, 'resources', id, 'tmp'),
          build: join(dataDir, 'resources', id, 'build'),
          logs: join(dataDir, 'resources', id, 'logs'),
          testData: join(dataDir, 'resources', id, 'test-data'),
          services: fixture
            ? [
                {
                  provider: 'local-kv',
                  url: fixture.url,
                  namespace: id,
                  ownerPid: process.pid,
                  credential: '[redacted]',
                },
              ]
            : [],
          containment: 'trusted-local advisory',
        });
        ev(a, roomId, 'task.claimed', {
          attemptId: id,
          taskId: t.id,
          generation: attempt.generation,
        });
        return attempt;
      } catch (e) {
        s.put('attempt', id, { ...attempt, status: 'quarantined' });
        s.put('resource', id, { id, roomId, status: 'quarantined' });
        throw e;
      }
    }),
  );
  core.register('task_heartbeat', (a, x) => {
    const roomId = str(x, 'roomId');
    workspaceAccess(a, roomId);
    const at = get<Attempt>('attempt', str(x, 'attemptId'));
    if (
      at.roomId !== roomId ||
      !attemptAccess(a, roomId, at) ||
      at.generation !== task(roomId, at.taskId).generation ||
      !['ready', 'running'].includes(at.status) ||
      at.leaseExpiresAt < Date.now()
    )
      throw new E('stale_lease', 'Attempt lease no longer current', 409);
    at.leaseExpiresAt = at.status === 'ready'
      ? at.approvalDeadline ?? at.leaseExpiresAt
      : Math.min(Date.now() + 60000, at.wallDeadline);
    s.put('attempt', at.id, at);
    return at;
  });
  core.register('task_submit', (a, x) =>
    journal(a, 'task_submit', x, async () => {
      const roomId = str(x, 'roomId');
      workspaceAccess(a, roomId);
      const at = get<Attempt>('attempt', str(x, 'attemptId')),
        t = task(roomId, at.taskId),
        p = profile(a, at.profileId),
        repo = repoAccess(a, at.repoId);
      if (
        at.roomId !== roomId ||
        !attemptAccess(a, roomId, at) ||
        at.generation !== t.generation ||
        at.leaseExpiresAt < Date.now() ||
        !['ready', 'completed'].includes(at.status)
      )
        throw new E(
          'stale_lease',
          'Attempt is active, expired or fenced by lease/dependency changes',
          409,
        );
      if (!workerStopped(at))
        throw new E('active_worker', 'Worker stop must be confirmed before submission', 409);
      if (scopeDigest(dependencies(t).map((m) => m.id)) !== scopeDigest(at.dependencies))
        throw new E('dependency_changed', 'Prerequisites changed; downstream attempt fenced', 409);
      if (
        (await canonicalRoot(at.path)) !== (await canonicalRoot(join(dataDir, 'workspaces', at.id)))
      )
        throw new E('binding', 'Workspace binding mismatch');
      const before = await load(at.basePath),
        after = await snapshot(at.path, p.generatedPaths),
        changes = delta(before, after);
      if (
        changes.some((d) => !t.scopePaths.some((p) => d.path === p || d.path.startsWith(p + '/')))
      )
        throw new E('scope_violation', 'Changes outside reserved source scopes', 409);
      const id = randomUUID(),
        m: Manifest = {
          id,
          roomId,
          taskId: t.id,
          attemptId: at.id,
          repoId: repo.id,
          implementerSeatId: at.seatId,
          foundation: repo.foundation,
          dependencies: at.dependencies,
          effectiveBase: before.digest,
          deltaDigest: scopeDigest(changes),
          resultDigest: after.digest,
          profileId: p.id,
          dataPath: await save(id, { snapshot: after, delta: changes }),
          createdAt: Date.now(),
          files: changes.map(({ bytes: _bytes, ...f }) => f),
          diff: redactPublic(
            changes
              .map(
                (d) =>
                  '--- ' +
                  d.path +
                  '\n' +
                  (d.deleted ? '[deleted]' : Buffer.from(d.bytes!, 'base64').toString()),
              )
              .join('\n'),
          ),
        };
      const validateSubmission = (status: string[]) => {
        workspaceAccess(a, roomId);
        const current = get<Attempt>('attempt', at.id), latestTask = task(roomId, at.taskId);
        if (current.generation !== at.generation || latestTask.generation !== at.generation ||
          current.leaseExpiresAt < Date.now() || !status.includes(current.status))
          throw new E('stale_lease', 'Submission was fenced while reading preserved work', 409);
        if (scopeDigest(dependencies(latestTask).map((d) => d.id)) !== scopeDigest(at.dependencies))
          throw new E('dependency_changed', 'Prerequisites changed while reading the submission', 409);
        if (!workerStopped(current))
          throw new E('active_worker', 'Worker stop must be confirmed before submission', 409);
        return { current, latestTask };
      };
      s.transaction(() => {
        const { current } = validateSubmission(['ready', 'completed']);
        s.put('attempt', at.id, { ...current, status: 'submitting' });
      });
      try {
        await brokers.get(at.id)?.close();
        brokers.delete(at.id);
        executionEnvironments.delete(at.id);
        s.transaction(() => {
          const { current, latestTask } = validateSubmission(['submitting']);
          s.put('manifest', id, m);
          s.put('attempt', at.id, { ...current, status: 'submitted' });
          s.put('resource', at.resourceId, {
            ...(s.get('resource', at.resourceId) as ToolArgs), status: 'retained',
          });
          putTask({ ...latestTask, status: 'submitted', manifestId: id });
          ev(a, roomId, 'task.submitted', { manifestId: id, resultDigest: m.resultDigest });
        });
      } catch (error) {
        const current = get<Attempt>('attempt', at.id);
        if (current.status === 'submitting') {
          s.put('attempt', at.id, { ...current, status: 'quarantined' });
          s.put('resource', at.resourceId, { ...get<ToolArgs>('resource', at.resourceId), status: 'quarantined' });
        }
        throw error;
      }
      return m;
    }),
  );
  core.register('artefact_get', async (a, x) => {
    core.requireRoom(a, str(x, 'roomId'));
    const m = get<Manifest>('manifest', str(x, 'manifestId'));
    if (m.roomId !== x.roomId) throw new E('forbidden', 'Artefact room mismatch', 403);
    await manifestData(m);
    return m;
  });
  core.register('verification_request', (a, x) =>
    journal(a, 'verification_request', x, async () => {
      const roomId = str(x, 'roomId');
      workspaceAccess(a, roomId);
      const m = get<Manifest>('manifest', str(x, 'manifestId'));
      if (m.roomId !== roomId) throw new E('forbidden', 'Manifest room mismatch');
      assertCurrent(m);
      const p = profile(a, m.profileId);
      return freshChecks(a, roomId, repoAccess(a, m.repoId), (await manifestData(m)).snapshot, p, {
        manifestId: m.id,
      });
    }),
  );
  // NFR-19 caps annotations per review; quotes keep the annotated lines so the rework prompt needs no file reads.
  const ANNOTATIONS = 100, COMMENT_BYTES = 1000, QUOTE_LINES = 20, QUOTE_CHARS = 300;
  const submissionSides = async (m: Manifest) => {
    const result = (await manifestData(m)).snapshot, base = await load(get<Attempt>('attempt', m.attemptId).basePath);
    if (base.digest !== m.effectiveBase) throw new E('digest_mismatch', 'Submission base changed');
    return { base, result };
  };
  const annotate = async (m: Manifest, raw: unknown): Promise<ReviewAnnotation[]> => {
    if (raw === undefined) return [];
    if (!Array.isArray(raw) || raw.length > ANNOTATIONS)
      throw new E('annotation', 'A review takes at most ' + ANNOTATIONS + ' line comments');
    if (!raw.length) return [];
    const sides = await submissionSides(m);
    return raw.map((item: unknown) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new E('annotation', 'Invalid line comment');
      const n = item as ToolArgs, path = str(n, 'path', 1024), comment = str(n, 'comment', COMMENT_BYTES), digest = str(n, 'digest', 128);
      const { side, startLine, endLine } = n;
      if (side !== 'result' && side !== 'base') throw new E('annotation', 'A line comment\'s side is result or base');
      if (typeof startLine !== 'number' || typeof endLine !== 'number' || !Number.isInteger(startLine) ||
        !Number.isInteger(endLine) || startLine < 1 || endLine < startLine)
        throw new E('annotation', 'A line comment needs a start line and an end line at or after it');
      const changed = m.files.find((f) => f.path === path), expected = side === 'result' ? changed?.afterDigest : changed?.beforeDigest;
      if (!expected)
        throw new E('annotation', `${path} has no ${side === 'result' ? 'submitted' : 'previous'} version in this submission's changes`);
      if (digest !== expected) throw new E('annotation_stale', `The comment on ${path} was written against different content`, 409);
      const file = (side === 'result' ? sides.result : sides.base).files.find((f) => f.path === path && f.digest === digest);
      if (!file) throw new E('digest_mismatch', 'Submission content changed');
      const bytes = Buffer.from(file.bytes, 'base64');
      if (bytes.includes(0)) throw new E('annotation', 'Binary files take no line comments');
      const lines = splitLines(bytes.toString('utf8'));
      if (endLine > lines.length) throw new E('annotation', `${path} has ${lines.length} lines in that version`);
      const quote = lines.slice(startLine - 1, Math.min(endLine, startLine - 1 + QUOTE_LINES))
        .map((line) => redactPublic(line).slice(0, QUOTE_CHARS));
      return { path, side, startLine, endLine, comment, digest, quote };
    });
  };
  core.register('artefact_diff', async (a, x) => {
    const roomId = str(x, 'roomId');
    core.requireRoom(a, roomId);
    const m = get<Manifest>('manifest', str(x, 'manifestId'));
    if (m.roomId !== roomId) throw new E('forbidden', 'Artefact room mismatch', 403);
    const { base, result } = await submissionSides(m);
    return { manifestId: m.id, effectiveBase: m.effectiveBase, resultDigest: m.resultDigest, ...treeDiff(base, result) };
  });
  core.register('review_submit', (a, x) => journal(a, 'review_submit', x, async () => {
    const roomId = str(x, 'roomId');
    workspaceAccess(a, roomId);
    const m = get<Manifest>('manifest', str(x, 'manifestId'));
    if (m.roomId !== roomId) throw new E('forbidden', 'Manifest mismatch');
    if (a.kind === 'agent' && core.requireSeat(a, roomId).id === m.implementerSeatId)
      throw new E('self_review', 'Implementer cannot accept own implementation', 403);
    assertCurrent(m);
    if (!['accept', 'reject'].includes(String(x.verdict)))
      throw new E('review', 'Choose accept/reject');
    const reason = str(x, 'reason'), annotations = await annotate(m, x.annotations);
    return s.transaction(() => {
      workspaceAccess(a, roomId);
      assertCurrent(m);
      if (
        x.verdict === 'accept' &&
        !s
          .list<Verification>('verification')
          .some(
            (v) =>
              v.manifestId === m.id &&
              v.contentDigest === m.resultDigest &&
              v.status === 'passing' &&
              v.profileDigest === get<Profile>('profile', m.profileId).digest,
          )
      )
        throw new E('verification', 'Passing exact verification required');
      const review: Review = {
        id: randomUUID(),
        roomId,
        manifestId: m.id,
        contentDigest: m.resultDigest,
        reviewerId: a.principalId,
        verdict: x.verdict as Review['verdict'],
        reason,
        createdAt: Date.now(),
        ...(annotations.length ? { annotations } : {}),
      };
      s.put('review', review.id, review);
      putTask({
        ...task(roomId, m.taskId),
        status: x.verdict === 'accept' ? 'accepted' : 'rework',
        manifestId: m.id,
      });
      if (x.verdict === 'reject') {
        for (const downstream of s
          .list<Task>('task')
          .filter((v) => v.roomId === roomId && v.id !== m.taskId)) {
          const affected =
            downstream.manifestId &&
            get<Manifest>('manifest', downstream.manifestId).dependencies.includes(m.id);
          if (affected) {
            putTask({ ...downstream, status: 'stale' });
            for (const v of s.list<Verification>('verification'))
              if (v.manifestId === downstream.manifestId)
                s.put('verification', v.id, { ...v, status: 'stale' });
          }
        }
        for (const at of s.list<Attempt>('attempt'))
          if (
            at.dependencies.includes(m.id) &&
            ['ready', 'running', 'completed'].includes(at.status)
          ) {
            s.put('attempt', at.id, { ...at, status: 'quarantined' });
            s.put('resource', at.resourceId, {
              ...(s.get('resource', at.resourceId) as ToolArgs),
              status: 'quarantined',
            });
          }
        for (const c of s.list<Candidate>('candidate'))
          if (c.manifestIds.includes(m.id) && c.status !== 'applied')
            s.put('candidate', c.id, { ...c, status: 'stale' });
      }
      // The quoted lines stay in the review record; the event keeps the comments themselves.
      ev(a, roomId, 'review.submitted', { ...review,
        ...(annotations.length ? { annotations: annotations.map(({ quote: _quote, ...n }) => n) } : {}) });
      return review;
    });
  }));
  core.register('integration_prepare', (a, x) =>
    journal(a, 'integration_prepare', x, async () => {
      const roomId = str(x, 'roomId');
      workspaceAccess(a, roomId);
      const repo = repoAccess(a, str(x, 'repoId')),
        p = profile(a, str(x, 'profileId')),
        ids = x.manifestIds as string[];
      if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length)
        throw new E('candidate', 'Ordered unique manifests required');
      const manifests = ids.map((id) => get<Manifest>('manifest', id));
      manifests.forEach(assertCurrent);
      for (const m of manifests)
        if (
          m.repoId !== repo.id ||
          m.roomId !== roomId ||
          task(roomId, m.taskId).manifestId !== m.id ||
          task(roomId, m.taskId).status !== 'accepted' ||
          m.dependencies.some((d) => !ids.includes(d) || ids.indexOf(d) >= ids.indexOf(m.id))
        )
          throw new E('candidate', 'Exact accepted prerequisite order required', 409);
      const content = compose(
          await load(repo.foundationPath),
          await Promise.all(manifests.map(async (m) => (await manifestData(m)).delta)),
        ),
        id = randomUUID(),
        path = await clone(repo, 'candidate-' + id);
      await writeSnapshot(path, content);
      const c: Candidate = {
        id,
        roomId,
        repoId: repo.id,
        manifestIds: ids,
        profileId: p.id,
        resultDigest: content.digest,
        path,
        status: 'prepared',
        createdAt: Date.now(),
        targetDigest: (await snapshot(repo.path, p.generatedPaths)).digest,
        checkoutSettings: await checkoutSettings(repo.path),
      };
      s.put('candidate', id, c);
      const v = await freshChecks(a, roomId, repo, content, p, { candidateId: id });
      c.verificationId = v.id;
      c.status = v.status === 'passing' ? 'verified' : 'failed';
      s.put('candidate', id, c);
      ev(a, roomId, 'candidate.prepared', {
        candidateId: id,
        status: c.status,
        resultDigest: c.resultDigest,
      });
      return c;
    }),
  );
  core.register('candidate_review', (a, x) => {
    const roomId = str(x, 'roomId');
    core.requireOwner(a, roomId);
    const c = get<Candidate>('candidate', str(x, 'candidateId'));
    if (c.roomId !== roomId || c.status !== 'verified')
      throw new E('candidate', 'Verified candidate required');
    s.put('candidate', c.id, { ...c, status: 'accepted' });
    return ev(a, roomId, 'candidate.accepted', {
      candidateId: c.id,
      resultDigest: c.resultDigest,
      reason: str(x, 'reason'),
    });
  });
  core.register('candidate_apply', (a, x) =>
    journal(a, 'candidate_apply', x, async () => {
      const roomId = str(x, 'roomId');
      core.requireOwner(a, roomId);
      const c = get<Candidate>('candidate', str(x, 'candidateId'));
      c.manifestIds.forEach((id) => assertCurrent(get<Manifest>('manifest', id)));
      if (c.roomId !== roomId || c.status !== 'accepted')
        throw new E('candidate', 'Review the verified final candidate before applying', 409);
      const repo = repoAccess(a, c.repoId),
        p = profile(a, c.profileId),
        v = get<Verification>('verification', c.verificationId!);
      const content = await snapshot(c.path, p.generatedPaths);
      if (
        content.digest !== c.resultDigest ||
        v.status !== 'passing' ||
        v.contentDigest !== content.digest
      )
        throw new E('evidence', 'Candidate content/evidence changed');
      const original = await snapshot(repo.path, p.generatedPaths);
      const foundation = await load(repo.foundationPath);
      const generated = (path: string) => p.generatedPaths.some((g) => path === g || path.startsWith(g + '/'));
      const clean = await run('git', ['--no-optional-locks', 'diff', '--quiet', '--no-ext-diff', 'HEAD', '--', '.',
        ...p.generatedPaths.map((g) => ':(exclude,literal)' + g)], repo.path);
      if (
        original.digest !== c.targetDigest ||
        scopeDigest(original.files.map((f) => f.path)) !==
          scopeDigest(foundation.files.filter((f) => !generated(f.path)).map((f) => f.path)) ||
        clean.exitCode !== 0 ||
        scopeDigest(await checkoutSettings(repo.path)) !== scopeDigest(c.checkoutSettings) ||
        (await run('git', ['rev-parse', 'HEAD'], repo.path)).output.trim() !== repo.head
      )
        throw new E(
          'target_changed',
          'Target is dirty or changed; original checkout preserved',
          409,
      );
      const baseContent = { files: foundation.files.filter((f) => !generated(f.path)), digest: '' };
      baseContent.digest = scopeDigest(baseContent.files.map(({ path, mode, digest }) => ({ path, mode, digest })));
      const baseline = await materializeCheckout(repo, 'foundation-' + c.id, baseContent, c.checkoutSettings);
      if (baseline.files.some((file) => {
        const actual = original.files.find((f) => f.path === file.path);
        const canonical = foundation.files.find((f) => f.path === file.path);
        return !actual || actual.mode !== file.mode ||
          (actual.digest !== file.digest && actual.digest !== canonical?.digest);
      }))
        throw new E('target_changed', 'Target is dirty or changed; original checkout preserved', 409);
      const checkout = await materializeCheckout(repo, c.id, content, c.checkoutSettings);
      if ((await snapshot(repo.path, p.generatedPaths)).digest !== original.digest ||
        (await run('git', ['rev-parse', 'HEAD'], repo.path)).output.trim() !== repo.head ||
        scopeDigest(await checkoutSettings(repo.path)) !== scopeDigest(c.checkoutSettings))
        throw new E('target_changed', 'Target changed during checkout preparation', 409);
      s.put('candidate', c.id, {
        ...c,
        status: 'applying',
        rollbackPath: await save('rollback-' + c.id, original),
      });
      try {
        await writeSnapshot(repo.path, checkout, p.generatedPaths);
        if ((await snapshot(repo.path, p.generatedPaths)).digest !== checkout.digest)
          throw new E('apply_mismatch', 'Applied content mismatch');
      } catch (e) {
        try {
          await writeSnapshot(repo.path, original, p.generatedPaths);
          s.put('candidate', c.id, {
            ...c,
            status: 'accepted',
            applyFailure: 'Original source restored',
          });
        } catch {
          s.put('candidate', c.id, {
            ...c,
            status: 'uncertain',
            applyFailure: 'Inspect preserved rollback artefact',
          });
        }
        throw e;
      }
      s.put('candidate', c.id, { ...c, status: 'applied', checkoutDigest: checkout.digest });
      return ev(a, roomId, 'candidate.applied', {
        candidateId: c.id,
        resultDigest: c.resultDigest,
      });
    }),
  );
  // FR-58: the owner chooses who exported commits are authored by; until then they carry a Converoom identity.
  const exportAuthor = () => {
    const set = s.get<{ name: string; email: string }>('setting', 'export_author');
    return set ? { name: set.name, email: set.email } : DEFAULT_EXPORT_AUTHOR;
  };
  core.register('export_author_update', (a, x) => {
    core.requireOwner(a);
    if (x.name === undefined && x.email === undefined) {
      s.remove('setting', 'export_author');
      installationAuthority(s, a, 'export_author.reset', { ...DEFAULT_EXPORT_AUTHOR });
      return { exportAuthor: exportAuthor(), default: true };
    }
    const name = str(x, 'name', 128).trim(), email = str(x, 'email', 254).trim();
    if (/[<>\r\n]/.test(name) || !/^[^\s<>@]+@[^\s<>@]+$/.test(email))
      throw new E('invalid_argument', 'Give a name without angle brackets and an email address like name@example.com');
    s.put('setting', 'export_author', { id: 'export_author', ownerId: a.ownerId, name, email, updatedAt: Date.now() });
    installationAuthority(s, a, 'export_author.updated', { name, email });
    return { exportAuthor: exportAuthor(), default: false };
  });
  core.register('candidate_export_branch', (a, x) =>
    journal(a, 'candidate_export_branch', x, async () => {
      const roomId = str(x, 'roomId');
      core.requireOwner(a, roomId);
      const room = core.requireRoom(a, roomId), c = get<Candidate>('candidate', str(x, 'candidateId'));
      if (c.roomId !== roomId || !['accepted', 'applied'].includes(c.status))
        throw new E('candidate', 'Review the verified final candidate before exporting it', 409);
      const manifests = c.manifestIds.map((id) => get<Manifest>('manifest', id));
      manifests.forEach(assertCurrent);
      const repo = repoAccess(a, c.repoId), v = get<Verification>('verification', c.verificationId!);
      const content = compose(await load(repo.foundationPath), await Promise.all(manifests.map(async (m) => (await manifestData(m)).delta)));
      if (content.digest !== c.resultDigest || v.status !== 'passing' || v.contentDigest !== c.resultDigest)
        throw new E('evidence', 'Candidate content or its passing checks changed');
      const branch = str(x, 'branch', 200), message = x.message === undefined ? '' : str(x, 'message', 4000).trim();
      if (PROTECTED_BRANCH.test(branch)) throw new E('protected_ref', 'Choose a new branch name; ' + branch + ' is protected', 409);
      const git = async (args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) =>
        run('git', ['-c', 'core.hooksPath=' + join(dataDir, 'empty-hooks'), ...args], cwd, 120000, env);
      const format = await git(['check-ref-format', '--branch', branch], repo.path);
      if (format.exitCode || format.output.trim() !== branch) throw new E('invalid_ref', 'That is not a valid Git branch name');
      const refs = (await git(['for-each-ref', '--format=%(refname)', 'refs/heads'], repo.path)).output.split('\n').map((r) => r.trim().toLowerCase());
      const current = (await git(['symbolic-ref', '-q', 'HEAD'], repo.path)).output.trim().toLowerCase();
      const ref = 'refs/heads/' + branch;
      if ([...refs, current].some((r) => r === ref.toLowerCase() || r.startsWith(ref.toLowerCase() + '/') || ref.toLowerCase().startsWith(r + '/')))
        throw new E('ref_exists', 'A branch named ' + branch + ' already exists or clashes with one; choose a new name', 409);
      if ((await git(['cat-file', '-e', repo.head + '^{commit}'], repo.path)).exitCode)
        throw new E('repository', 'The repository no longer has the commit this candidate is based on');
      const author = exportAuthor(), id = randomUUID(), path = await clone(repo, 'export-' + id);
      try {
        const local = async (args: string[], env?: NodeJS.ProcessEnv) => {
          const result = await git(args, path, env);
          if (result.exitCode) throw new E('export_failed', 'Git could not build the export commit');
          return result.output.trim();
        };
        await writeSnapshot(path, content);
        await local(['add', '--all', '--force', '--', '.']);
        const tree = await local(['write-tree']);
        // The commit must reproduce the verified bytes once checked out, so filters that change them refuse the export.
        await writeSnapshot(path, { files: [], digest: scopeDigest([]) });
        await local(['checkout-index', '--all', '--force']);
        if ((await snapshot(path)).digest !== content.digest)
          throw new E('checkout_conversion', 'Git filters change the candidate content; export refused');
        const identity = { GIT_AUTHOR_NAME: author.name, GIT_AUTHOR_EMAIL: author.email, GIT_COMMITTER_NAME: author.name, GIT_COMMITTER_EMAIL: author.email };
        const commit = await local(['commit-tree', tree, '-p', repo.head, '-m',
          message || String(room.title ?? 'Converoom candidate')], identity);
        await local(['update-ref', 'refs/converoom/export', commit]);
        if ((await git(['fetch', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', path, 'refs/converoom/export'], repo.path)).exitCode)
          throw new E('export_failed', 'The export commit could not be copied into the repository');
        // An all-zero old value makes Git refuse to overwrite a branch created meanwhile.
        if ((await git(['update-ref', '-m', 'converoom: export candidate ' + c.id, ref, commit, '0'.repeat(repo.head.length)], repo.path)).exitCode)
          throw new E('ref_exists', 'A branch named ' + branch + ' was created meanwhile; choose a new name', 409);
        const decision = s.lastEvent(roomId, 'decision');
        const brief = prBrief({
          room: room as unknown as ToolArgs, decision, branch, commit, base: repo.head, author,
          interactions: s.list<ToolArgs>('interaction', { roomId }), seats: s.list<ToolArgs>('seat', { roomId }),
          candidate: c as unknown as ToolArgs, verification: v as unknown as ToolArgs,
          manifests: manifests.map((m) => ({
            manifest: m as unknown as ToolArgs, task: task(roomId, m.taskId) as unknown as ToolArgs,
            review: s.list<Review>('review', { roomId }).filter((r) => r.manifestId === m.id).sort((p, q) => q.createdAt - p.createdAt)[0],
            verification: s.list<Verification>('verification').filter((w) => w.manifestId === m.id && w.status === 'passing')
              .at(-1) as unknown as ToolArgs | undefined,
          })),
        });
        const briefDigest = bytesDigest(brief), briefPath = join(dataDir, 'artefacts', 'brief-' + id + '.md');
        await mkdir(join(dataDir, 'artefacts'), { recursive: true });
        await writeFile(briefPath, brief, { mode: 0o600 });
        const exported = { branch, commit, base: repo.head, author, briefPath, briefDigest, at: Date.now() };
        s.transaction(() => {
          const latest = get<Candidate & { exports?: unknown[] }>('candidate', c.id);
          s.put('candidate', c.id, { ...latest, exports: [...(latest.exports ?? []), exported] });
          authority(s, a, room, 'candidate.exported', { candidateId: c.id, resultDigest: c.resultDigest, branch, commit,
            base: repo.head, author, briefDigest });
        });
        return { ...exported, candidateId: c.id, brief };
      } finally {
        await rm(path, { recursive: true, force: true, maxRetries: 3 }).catch(() => undefined);
      }
    }),
  );
  const workspaceRoot = join(dataDir, 'workspaces');
  const sizeOf = async (path: string) => {
    let total = 0;
    for (const entry of await readdir(path, { recursive: true, withFileTypes: true }).catch(() => []))
      if (entry.isFile()) total += (await lstat(join(entry.parentPath, entry.name)).catch(() => ({ size: 0 }))).size;
    return total;
  };
  const exportedAfter = (roomId: string, at: number) => Number(s.get<{ at: number }>('exported', roomId)?.at ?? -1) >= at;
  // F8: nothing is removed without a confirmed preview, and dirty, unexported or uncertain work is always kept.
  const classify = async (name: string): Promise<CleanupEntry> => {
    const path = join(workspaceRoot, name), born = (await stat(path).catch(() => undefined))?.birthtimeMs;
    const base = { name, path, bytes: 0, ...(born ? { createdAt: Math.round(born) } : {}) };
    const keep = (reason: string, detail: string, info: Partial<CleanupEntry> = {}): CleanupEntry =>
      ({ ...base, kind: 'unknown', ...info, removable: false, reason, detail });
    const remove = (detail: string, info: Partial<CleanupEntry>): CleanupEntry => ({ ...base, kind: 'unknown', ...info, removable: true, detail });
    const room = (roomId: string) => ({ roomId, roomTitle: String(s.get<ToolArgs>('room', roomId)?.title ?? '') });
    const resumed = !!s.get('cleanup', name), unexported = 'Not in a room export taken after this work';
    const at = s.get<Attempt>('attempt', name);
    if (at) {
      const info: Partial<CleanupEntry> = { kind: 'attempt', id: at.id, ...room(at.roomId), taskId: at.taskId, status: at.status, resourceId: at.resourceId };
      const p = s.get<Profile>('profile', at.profileId);
      if (resumed || at.status === 'removed') return remove(RESUMED, info);
      if (ACTIVE_ATTEMPT.includes(at.status)) return keep('active', 'Still in use by its task', info);
      if (['quarantined', 'uncertain'].includes(at.status) || !p)
        return keep('uncertain', 'Its worker stop is not confirmed. Inspect and release it first', info);
      if (['submitted', 'retained'].includes(at.status)) {
        const m = s.list<Manifest>('manifest').find((v) => v.attemptId === at.id);
        if (!m || !exportedAfter(at.roomId, m.createdAt)) return keep('unexported', unexported, info);
        const digest = (await snapshot(path, p.generatedPaths)).digest;
        return digest === m.resultDigest ? remove('Submitted and exported; its manifest keeps the submitted content', { ...info, contentDigest: digest })
          : keep('changed', 'Edited after it was submitted', info);
      }
      if (at.status === 'released') {
        const released = Number(s.get<ToolArgs>('resource', at.resourceId)?.releasedAt ?? 0);
        const digest = (await snapshot(path, p.generatedPaths)).digest;
        if (digest !== at.effectiveBase) return keep('dirty', 'Holds changes that were never submitted', info);
        if (Date.now() < released + RELEASE_RETENTION_MS)
          return keep('retention', 'Released less than 7 days ago', { ...info, keepUntil: released + RELEASE_RETENTION_MS });
        if (!exportedAfter(at.roomId, released)) return keep('unexported', unexported, info);
        return remove('Released over 7 days ago with no unsubmitted changes', { ...info, contentDigest: digest });
      }
      return keep('unknown', 'Its state is not one cleanup recognises', info);
    }
    const c = name.startsWith('candidate-') ? s.get<Candidate>('candidate', name.slice(10)) : undefined;
    if (c) {
      const info: Partial<CleanupEntry> = { kind: 'candidate', id: c.id, ...room(c.roomId), status: c.status };
      const p = s.get<Profile>('profile', c.profileId);
      if (resumed) return remove(RESUMED, info);
      if (ACTIVE_CANDIDATE.includes(c.status)) return keep('active', 'Needed until the candidate is applied or set aside', info);
      if (c.status === 'uncertain' || !p) return keep('uncertain', 'Its apply did not finish. Inspect the checkout first', info);
      if (!exportedAfter(c.roomId, c.createdAt)) return keep('unexported', unexported, info);
      const digest = (await snapshot(path, p.generatedPaths)).digest;
      return digest === c.resultDigest ? remove('Candidate ' + c.status + '; its record keeps the result digest', { ...info, contentDigest: digest })
        : keep('changed', 'Edited after it was prepared', info);
    }
    const applied = name.startsWith('apply-') ? s.get<Candidate>('candidate', name.replace(/^apply-(foundation-)?/, '')) : undefined;
    if (applied) {
      const info: Partial<CleanupEntry> = { kind: 'candidate', id: applied.id, ...room(applied.roomId), status: applied.status };
      if (resumed) return remove(RESUMED, info);
      if (['applying', 'uncertain'].includes(applied.status)) return keep('uncertain', 'Its apply did not finish. Inspect the checkout first', info);
      if (!['applied', 'failed', 'stale'].includes(applied.status)) return keep('active', 'Needed until the candidate is applied or set aside', info);
      if (!exportedAfter(applied.roomId, applied.createdAt)) return keep('unexported', unexported, info);
      return remove('Temporary checkout from applying the candidate', info);
    }
    const repo = name.startsWith('foundation-') ? s.get<Repo>('repo', name.slice(11)) : undefined;
    if (repo)
      return existsSync(repo.foundationPath)
        ? remove('Copy made when the repository was registered; its foundation snapshot is stored', { kind: 'foundation', id: repo.id, repoName: repo.name })
        : keep('uncertain', 'Its stored foundation snapshot is missing', { kind: 'foundation', id: repo.id, repoName: repo.name });
    if (name.startsWith('verify-')) {
      const id = name.slice(7), v = s.get<Verification>('verification', id);
      const info: Partial<CleanupEntry> = { kind: 'verification', id, ...(v ? { ...room(v.roomId), status: v.status } : {}), resourceId: id };
      if (resumed) return remove(RESUMED, info);
      if (!v) return keep('uncertain', 'Its checks have no recorded result. Inspect it first', info);
      if (!exportedAfter(v.roomId, Number(s.get<ToolArgs>('resource', id)?.createdAt ?? 0))) return keep('unexported', unexported, info);
      return remove('Its check results are recorded', { ...info, contentDigest: v.contentDigest });
    }
    return keep('unknown', 'Not recorded by Converoom; left untouched');
  };
  const cleanupPreview = async () => {
    const names = (await readdir(workspaceRoot, { withFileTypes: true }).catch(() => []))
      .filter((d) => d.isDirectory()).map((d) => d.name).sort();
    const entries: CleanupEntry[] = [];
    for (const name of names) {
      const e = await classify(name);
      entries.push({ ...e, bytes: (await sizeOf(e.path)) + (e.resourceId ? await sizeOf(join(dataDir, 'resources', e.resourceId)) : 0) +
        (e.kind === 'attempt' && e.id ? await sizeOf(checkpoints.dir(e.id)) : 0) });
    }
    const removable = entries.filter((e) => e.removable);
    const digest = scopeDigest(removable.map((e) => ({ name: e.name, kind: e.kind, id: e.id ?? null, contentDigest: e.contentDigest ?? null })));
    return { digest, code: digest.slice(0, 12), entries, removable: { count: removable.length, bytes: removable.reduce((n, e) => n + e.bytes, 0) } };
  };
  const removeWorkspace = async (e: CleanupEntry) => {
    s.put('cleanup', e.name, { name: e.name, kind: e.kind, id: e.id ?? null, startedAt: Date.now() });
    await rm(e.path, { recursive: true, force: true, maxRetries: 3 });
    if (e.resourceId) await rm(join(dataDir, 'resources', e.resourceId), { recursive: true, force: true, maxRetries: 3 });
    if (e.kind === 'attempt' && e.id) await rm(checkpoints.dir(e.id), { recursive: true, force: true, maxRetries: 3 });
    s.transaction(() => {
      if (e.kind === 'attempt' && e.id && e.roomId)
        for (const c of checkpoints.list(e.roomId, e.id).filter((v) => v.status === 'kept'))
          s.put('checkpoint', c.id, { ...c, status: 'pruned', prunedAt: Date.now(), reason: 'workspace_removed' });
      const kind = ['attempt', 'candidate', 'verification'].includes(e.kind) ? e.kind : undefined;
      const record = kind && e.id ? s.get<ToolArgs>(kind, e.id) : undefined;
      if (kind && record) s.put(kind, e.id!, kind === 'attempt' ? { ...record, status: 'removed' } : { ...record, workspaceRemovedAt: Date.now() });
      const resource = e.resourceId ? s.get<ToolArgs>('resource', e.resourceId) : undefined;
      if (resource) s.put('resource', e.resourceId!, { ...resource, status: 'removed', removedAt: Date.now() });
      s.remove('cleanup', e.name);
    });
  };
  const announce = (a: Actor, removed: CleanupEntry[]) => {
    for (const roomId of new Set(removed.map((e) => e.roomId)))
      if (roomId && s.get('room', roomId)) {
        const own = removed.filter((e) => e.roomId === roomId);
        ev(a, roomId, 'workspaces.removed', { removed: own.map((e) => ({ kind: e.kind, id: e.id ?? null, name: e.name })),
          bytes: own.reduce((n, e) => n + e.bytes, 0) });
      }
  };
  core.register('workspace_cleanup_preview', async (a) => {
    core.requireOwner(a);
    return cleanupPreview();
  });
  core.register('workspace_cleanup', async (a, x) => {
    core.requireOwner(a);
    if (x.confirm !== true) throw new E('cleanup_refused', 'Confirm the cleanup to remove workspaces');
    if (x.attemptId !== undefined) {
      const at = get<Attempt>('attempt', str(x, 'attemptId'));
      const e = await classify(at.id);
      if (!e.removable) throw new E('cleanup_refused', 'This workspace is retained: ' + e.detail);
      await removeWorkspace(e);
      announce(a, [e]);
      return { removed: at.id };
    }
    const code = str(x, 'preview', 64), preview = await cleanupPreview();
    if (code.length < 12 || !preview.digest.startsWith(code))
      throw new E('cleanup_changed', 'The workspaces changed since this preview. Preview again before removing anything', 409);
    const candidates = preview.entries.filter((e) => e.removable);
    if (!candidates.length) throw new E('cleanup_refused', 'Nothing can be removed', 409);
    const removed: CleanupEntry[] = [], failed: { name: string; path: string; message: string }[] = [];
    for (const e of candidates)
      try {
        await removeWorkspace(e);
        removed.push(e);
      } catch (error) {
        failed.push({ name: e.name, path: e.path, message: error instanceof Error ? error.message : 'Removal failed' });
      }
    announce(a, removed);
    return { removed, failed, bytes: removed.reduce((n, e) => n + e.bytes, 0) };
  });
  core.register('attempt_release', (a, x) => journal(a, 'attempt_release', x, async () => {
    const roomId = str(x, 'roomId');
    core.requireOwner(a, roomId);
    const at = get<Attempt>('attempt', str(x, 'attemptId'));
    const reason = str(x, 'reason');
    if (at.roomId !== roomId || x.confirm !== true ||
      !['ready', 'completed', 'quarantined', 'uncertain'].includes(at.status))
      throw new E('release_refused', 'Inspect and confirm an inactive attempt', 409);
    const turns = s.list<Turn & { dispatchBoundaryAt?: number }>('turn')
      .filter((t) => t.attemptId === at.id);
    if (!workerStopped(at))
      throw new E('release_refused', 'Uncertain or active worker stop must be confirmed first', 409);
    s.transaction(() => {
      for (const turn of turns.filter((t) => t.status === 'queued'))
        cancelTurn(s, a, turn, 'Attempt released before the turn started', 'attempt_released');
      const current = task(roomId, at.taskId);
      if (current.generation === at.generation)
        putTask({ ...current, generation: current.generation + 1, status: 'rework' });
      s.put('attempt', at.id, { ...at, status: 'draining', leaseExpiresAt: 0 });
      s.put('resource', at.resourceId, { ...get<ToolArgs>('resource', at.resourceId), status: 'draining' });
      ev(a, roomId, 'attempt.release_requested', { attemptId: at.id, reason, generation: at.generation });
    });
    await brokers.get(at.id)?.close();
    brokers.delete(at.id);
    executionEnvironments.delete(at.id);
    s.put('attempt', at.id, { ...get<Attempt>('attempt', at.id), status: 'released' });
    s.put('resource', at.resourceId, { ...get<ToolArgs>('resource', at.resourceId),
      status: 'released', releasedAt: Date.now(), credentialRevoked: true });
    ev(a, roomId, 'attempt.released', { attemptId: at.id, reason, workspacePreserved: true });
    return { released: at.id, workspacePreserved: true };
  }));
  const checkpointNumber = (x: ToolArgs, key: string) => {
    const value = x[key];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
      throw new E('invalid_argument', 'Invalid ' + key);
    return value;
  };
  const basis = async (at: Attempt) => {
    const base = await load(at.basePath);
    if (base.digest !== at.effectiveBase) throw new E('digest_mismatch', 'Attempt base changed');
    return base;
  };
  const checkpointReader = (a: Actor, x: ToolArgs) => {
    const roomId = str(x, 'roomId');
    if (a.kind === 'human') core.requireOwner(a, roomId);
    else core.requireRoom(a, roomId);
    const at = get<Attempt>('attempt', str(x, 'attemptId'));
    if (at.roomId !== roomId || !attemptAccess(a, roomId, at))
      throw new E('forbidden', 'Only the owner, the attempt\'s worker or the host can read its checkpoints', 403);
    return at;
  };
  // FR-55: runs once a completed coding turn's process stop is confirmed, so nothing else writes to the clone.
  const checkpoint = async (attemptId: string, turnId: string) => {
    const at = get<Attempt>('attempt', attemptId);
    if (at.status !== 'checkpointing') return;
    const settle = (fields: Partial<Attempt>, event: string, data: ToolArgs, records: Checkpoint[] = []) => s.transaction(() => {
      for (const c of records) s.put('checkpoint', c.id, c);
      s.put('attempt', at.id, { ...get<Attempt>('attempt', at.id), status: 'completed', ...fields });
      s.append(at.roomId, event, 'runtime', { attemptId, turnId, ...data });
    });
    try {
      const base = await basis(at), current = await attemptTree(at.path, get<Profile>('profile', at.profileId).generatedPaths);
      if (current.digest === (at.treeDigest ?? at.effectiveBase)) {
        const c = at.checkpointSeq ? s.get<Checkpoint>('checkpoint', at.id + ':' + at.checkpointSeq) : undefined;
        settle({}, 'checkpoint.unchanged', { checkpoint: at.checkpointSeq ?? 0, treeDigest: current.digest },
          c ? [{ ...c, turnIds: [...c.turnIds, turnId] }] : []);
        return;
      }
      const { record, pruned } = await checkpoints.prepare(at, turnId, current, base);
      settle({ treeDigest: current.digest, checkpointSeq: record.seq },
        record.status === 'kept' ? 'checkpoint.recorded' : 'checkpoint.skipped',
        { checkpoint: record.seq, treeDigest: current.digest,
          ...(record.status === 'kept' ? { newBytes: record.newBytes, pruned: pruned.map((c) => c.seq) } : { reason: record.reason }) },
        [record, ...pruned.map((c) => ({ ...c, status: 'pruned' as const, prunedAt: Date.now(), reason: 'limit' }))]);
      await checkpoints.collect(at, base).catch(() => undefined);
    } catch (error) {
      const seq = (checkpoints.list(at.roomId, at.id).at(-1)?.seq ?? 0) + 1;
      const reason = error instanceof E ? error.code : 'checkpoint_failed';
      // An empty tree digest matches no clone, so the attempt takes no further turns until it is submitted or released.
      settle({ treeDigest: '', checkpointSeq: seq }, 'checkpoint.skipped', { checkpoint: seq, reason }, [{
        id: at.id + ':' + seq, roomId: at.roomId, attemptId: at.id, taskId: at.taskId, seq, parentSeq: at.checkpointSeq ?? 0,
        turnIds: [turnId], treeDigest: '', status: 'skipped', files: 0, changed: null, newBytes: 0, createdAt: Date.now(), reason,
      }]);
    }
  };
  core.register('checkpoint_list', async (a, x) => {
    const at = checkpointReader(a, x);
    return {
      attemptId: at.id, treeDigest: at.treeDigest ?? at.effectiveBase, checkpoint: at.checkpointSeq ?? 0,
      rollback: at.rollbackSeq ?? null, limit: CHECKPOINT_LIMIT, budgetBytes: checkpoints.budget,
      usedBytes: await checkpoints.usedBytes(at.id), checkpoints: checkpoints.list(at.roomId, at.id),
    };
  });
  core.register('checkpoint_diff', async (a, x) => {
    const at = checkpointReader(a, x), seq = checkpointNumber(x, 'checkpoint');
    const parent = seq ? s.get<Checkpoint>('checkpoint', at.id + ':' + seq)?.parentSeq ?? 0 : 0;
    const against = x.against === undefined
      ? parent && s.get<Checkpoint>('checkpoint', at.id + ':' + parent)?.status === 'kept' ? parent : 0
      : checkpointNumber(x, 'against');
    const base = await basis(at), from = await checkpoints.tree(at, against, base), to = await checkpoints.tree(at, seq, base);
    return { attemptId: at.id, from: { checkpoint: against, treeDigest: from.digest },
      to: { checkpoint: seq, treeDigest: to.digest }, ...treeDiff(from, to) };
  });
  core.register('attempt_rollback', (a, x) => journal(a, 'attempt_rollback', x, async () => {
    const roomId = str(x, 'roomId'), room = workspaceAccess(a, roomId);
    if (a.kind === 'human') core.requireOwner(a, roomId);
    const at = get<Attempt>('attempt', str(x, 'attemptId')), seq = checkpointNumber(x, 'checkpoint'), reason = str(x, 'reason');
    if (at.roomId !== roomId || !attemptAccess(a, roomId, at))
      throw new E('forbidden', 'Only the owner, the attempt\'s worker or the host can roll it back', 403);
    const idle = (current: Attempt) => current.status === 'completed' && current.leaseExpiresAt >= Date.now() &&
      current.generation === task(roomId, current.taskId).generation && workerStopped(current);
    if (x.confirm !== true || !idle(at))
      throw new E('rollback_refused', 'Confirm a rollback of a completed attempt with no turn in flight', 409);
    const generated = get<Profile>('profile', at.profileId).generatedPaths, base = await basis(at);
    const target = await checkpoints.tree(at, seq, base), before = await attemptTree(at.path, generated);
    if (before.digest !== (at.treeDigest ?? at.effectiveBase))
      throw new E('workspace_changed', 'The clone changed outside a turn; submit or release it instead', 409);
    s.transaction(() => {
      const current = get<Attempt>('attempt', at.id);
      if (!idle(current)) throw new E('rollback_refused', 'The attempt changed; inspect it again', 409);
      for (const turn of s.list<Turn>('turn', { roomId }).filter((t) => t.attemptId === at.id && t.status === 'queued'))
        cancelTurn(s, a, turn, 'Attempt rolled back before the turn started', 'attempt_rolled_back');
      s.put('attempt', at.id, { ...current, status: 'rolling_back' });
    });
    try {
      await writeSnapshot(at.path, target, [...generated, ...(await ignoredPaths(at.path))]);
      if ((await attemptTree(at.path, generated)).digest !== target.digest)
        throw new E('rollback_mismatch', 'Restored content mismatch');
    } catch (error) {
      s.put('attempt', at.id, { ...get<Attempt>('attempt', at.id), status: 'quarantined' });
      s.put('resource', at.resourceId, { ...get<ToolArgs>('resource', at.resourceId), status: 'quarantined' });
      throw error;
    }
    s.transaction(() => {
      s.put('attempt', at.id, { ...get<Attempt>('attempt', at.id), status: 'completed', treeDigest: target.digest,
        checkpointSeq: seq, rollbackSeq: seq });
      for (const c of checkpoints.list(roomId, at.id))
        if (c.seq > seq && c.status === 'kept' && !c.superseded) s.put('checkpoint', c.id, { ...c, superseded: true });
      authority(s, a, room, 'attempt.rolled_back', { attemptId: at.id, taskId: at.taskId, generation: at.generation,
        checkpoint: seq, treeDigest: target.digest, previousTreeDigest: before.digest, reason });
    });
    return { attemptId: at.id, checkpoint: seq, treeDigest: target.digest };
  }));
  for (const c of s.list<Candidate>('candidate'))
    if (c.status === 'applying') s.put('candidate', c.id, { ...c, status: 'uncertain' });
  for (const at of s.list<Attempt>('attempt'))
    if (['provisioning', 'ready', 'running', 'checkpointing', 'rolling_back', 'submitting', 'draining'].includes(at.status)) {
      s.put('attempt', at.id, { ...at, status: 'uncertain' });
      s.put('resource', at.resourceId, {
        ...(s.get('resource', at.resourceId) as ToolArgs),
        status: 'quarantined',
      });
    }
  expireJournal(Date.now() - RESULT_RETENTION_MS, RESULT_EXPIRY_BATCH);
  return {
    expireJournal,
    checkpoint,
    revoke: async (id) => {
      await brokers.get(id)?.close();
      brokers.delete(id);
      executionEnvironments.delete(id);
    },
    close: async () => {
      for (const [id, b] of brokers) {
        await b.close();
        executionEnvironments.delete(id);
      }
      brokers.clear();
    },
  };
}
