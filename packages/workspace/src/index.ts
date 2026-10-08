import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, realpath, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  ConveroomError as E,
  requiredString as str,
  type Core,
  type Actor,
  type ToolArgs,
  type Seat,
  type Turn,
} from '../../shared/src/contracts.js';
import { scopeDigest, redactPublic } from '../../store/src/index.js';
import { run, canonicalRoot, inside } from '../../adapters/src/process.js';
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
export function mountWorkspace(
  core: Core,
  dataDir: string,
): { close(): Promise<void>; revoke(id: string): Promise<void> } {
  const s = core.store;
  const workspaceAccess = (a: Actor, id: string) => {
    const room = core.requireRoom(a, id);
    if (a.kind === 'agent' && core.requireSeat(a, id).role === 'observer')
      throw new E('observer', 'Observer cannot mutate or execute workspace operations', 403);
    if (room.status !== 'open')
      throw new E('inactive', 'Room must be open for workspace operations', 409);
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
  const workerStopped = (at: Attempt) => !s.list<Turn & { dispatchBoundaryAt?: number; sessionId?: string }>('turn')
    .some((turn) => turn.attemptId === at.id && (
      ['running', 'dispatching', 'cancelling', 'uncertain'].includes(turn.status) ||
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
    s.put('command', key, { hash, status: 'working' });
    try {
      const result = await fn();
      s.put('command', key, { hash, status: 'done', result });
      return result;
    } catch (e) {
      s.put('command', key, {
        hash,
        status: 'failed',
        error: e instanceof E ? e.code : 'execution_failure',
      });
      throw e;
    }
  };
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
  core.register('review_submit', (a, x) => {
    const roomId = str(x, 'roomId');
    workspaceAccess(a, roomId);
    const m = get<Manifest>('manifest', str(x, 'manifestId'));
    if (m.roomId !== roomId) throw new E('forbidden', 'Manifest mismatch');
    if (a.kind === 'agent' && core.requireSeat(a, roomId).id === m.implementerSeatId)
      throw new E('self_review', 'Implementer cannot accept own implementation', 403);
    assertCurrent(m);
    if (!['accept', 'reject'].includes(String(x.verdict)))
      throw new E('review', 'Choose accept/reject');
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
    const review = {
      id: randomUUID(),
      roomId,
      manifestId: m.id,
      contentDigest: m.resultDigest,
      reviewerId: a.principalId,
      verdict: x.verdict,
      reason: str(x, 'reason'),
      createdAt: Date.now(),
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
    ev(a, roomId, 'review.submitted', review);
    return review;
  });
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
  core.register('workspace_cleanup', async (a, x) => {
    core.requireOwner(a);
    const at = get<Attempt>('attempt', str(x, 'attemptId'));
    if (
      !['submitted', 'retained'].includes(at.status) ||
      x.confirm !== true ||
      !s.get('exported', at.roomId)
    )
      throw new E('cleanup_refused', 'Dirty, unexported or uncertain work is retained');
    const t = task(at.roomId, at.taskId),
      m = t.manifestId ? get<Manifest>('manifest', t.manifestId) : undefined,
      p = get<Profile>('profile', at.profileId);
    if (
      !m ||
      m.attemptId !== at.id ||
      (await snapshot(at.path, p.generatedPaths)).digest !== m.resultDigest
    )
      throw new E('cleanup_refused', 'Dirty or changed work is retained');
    if (!inside(join(dataDir, 'workspaces'), at.path))
      throw new E('cleanup_refused', 'Invalid workspace root');
    await rm(at.path, { recursive: true, force: true });
    s.put('attempt', at.id, { ...at, status: 'removed' });
    return { removed: at.id };
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
      for (const turn of turns.filter((t) => t.status === 'queued')) {
        s.put('turn', turn.id, { ...turn, status: 'cancelled' });
        const permission = s.get<ToolArgs>('permission', turn.permissionRequestId ?? '');
        if (permission) s.put('permission', String(permission.id), { ...permission, status: 'denied' });
      }
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
  for (const c of s.list<Candidate>('candidate'))
    if (c.status === 'applying') s.put('candidate', c.id, { ...c, status: 'uncertain' });
  for (const at of s.list<Attempt>('attempt'))
    if (['provisioning', 'ready', 'running', 'submitting', 'draining'].includes(at.status)) {
      s.put('attempt', at.id, { ...at, status: 'uncertain' });
      s.put('resource', at.resourceId, {
        ...(s.get('resource', at.resourceId) as ToolArgs),
        status: 'quarantined',
      });
    }
  return {
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
