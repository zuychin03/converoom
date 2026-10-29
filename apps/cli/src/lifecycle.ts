import { existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConveroomError, type Product } from '../../../packages/shared/src/contracts.js';
import { isProduct } from '../../../packages/shared/src/products.js';
import { backupDatabase, createStore, databaseSchema, scopeDigest } from '../../../packages/store/src/index.js';
import { revokeBridgeCredential } from '../../daemon/src/bridges.js';
import { VERSION, editConfig, installSkill, installStable, json, mcpArgs, privateJson, registeredEntry, removeSkill, samePath } from './support.js';
import { credentialLocation, migrateCredentials, removeCredential } from './credentials.js';

interface Active {
  version: string;
  selectedAt: number;
  previous?: string;
  backup?: string;
  previousSchema?: number;
  schema?: number;
  upgrade?: { from: string; to: string; backup: string; startedAt: number; schema?: number };
}
interface Client { principalId: string; config?: string; skill?: { path: string; digest: string } }

const runtimeDir = (dataDir: string) => join(dataDir, 'runtime');
const activeFile = (dataDir: string) => join(runtimeDir(dataDir), 'active.json');
const database = (dataDir: string) => join(dataDir, 'converoom.sqlite');
const stableCli = (dataDir: string, version: string) => join(runtimeDir(dataDir), version, 'dist', 'cli.js');
const schema = (dataDir: string) => existsSync(database(dataDir)) ? databaseSchema(database(dataDir)) : undefined;
const notInstalled = () => new ConveroomError('not_installed', 'Converoom is not installed in this data directory. Run converoom setup.');
const interrupted = (step: NonNullable<Active['upgrade']>) =>
  new ConveroomError('upgrade_interrupted', `The upgrade from ${step.from} to ${step.to} did not finish. Run converoom recover.`);

export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

async function activeInstallation(dataDir: string): Promise<Active | undefined> {
  if (existsSync(activeFile(dataDir))) return json<Active>(activeFile(dataDir));
  // Before the active version was recorded, setup left one payload per version; the newest complete one is taken as in use.
  const entries = existsSync(runtimeDir(dataDir)) ? await readdir(runtimeDir(dataDir), { withFileTypes: true }) : [];
  const versions = entries.filter((e) => e.isDirectory() && existsSync(join(runtimeDir(dataDir), e.name, 'installation.json')))
    .map((e) => e.name).sort(compareVersions);
  return versions.length ? { version: versions.at(-1)!, selectedAt: 0 } : undefined;
}

async function select(dataDir: string, active: Active) {
  await mkdir(runtimeDir(dataDir), { recursive: true });
  await writeFile(activeFile(dataDir), JSON.stringify(active, null, 2) + '\n', { mode: 0o600 });
}

export async function installationStatus(dataDir: string) {
  const active = await activeInstallation(dataDir);
  const status = !active ? 'not installed' : active.upgrade ? 'upgrade interrupted; run converoom recover'
    : active.version === VERSION ? 'current' : compareVersions(VERSION, active.version) > 0 ? 'upgrade available' : 'package older than the installed version';
  return { active: active?.version ?? null, package: VERSION, status, ...(active?.previous ? { previous: active.previous } : {}) };
}

// No command migrates silently: a different installed version is only changed by upgrade or recover.
export async function assertCurrent(dataDir: string): Promise<void> {
  const active = await activeInstallation(dataDir);
  if (active?.upgrade) throw interrupted(active.upgrade);
  if (active && active.version !== VERSION)
    throw new ConveroomError('version_mismatch', compareVersions(VERSION, active.version) > 0
      ? `Converoom ${active.version} is installed and this package is ${VERSION}. Stop the runtime, then run converoom upgrade.`
      : `Converoom ${active.version} is installed, which is newer than this package (${VERSION}). Use the installed runtime: ${stableCli(dataDir, active.version)}`);
}

export async function ensureInstalled(dataDir: string): Promise<string> {
  await assertCurrent(dataDir);
  const cli = await installStable(dataDir);
  if (!existsSync(activeFile(dataDir))) await select(dataDir, { version: VERSION, selectedAt: Date.now() });
  return cli;
}

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code !== 'ESRCH'; }
};
// A lock whose process has exited was left by a crash; any other lock may belong to a running runtime.
async function requireStopped(dataDir: string) {
  const lock = join(dataDir, 'runtime.lock');
  if (existsSync(lock)) {
    const pid = (await json<{ pid?: unknown }>(lock).catch(() => undefined))?.pid;
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0 || alive(pid))
      throw new ConveroomError('runtime_active', 'Converoom is running or its lock is unidentified. Stop it with converoom stop, then run this again.');
    await rm(lock);
  }
  await rm(join(dataDir, 'runtime.json'), { force: true });
}

async function clients(dataDir: string) {
  const dir = join(dataDir, 'clients'), names = existsSync(dir) ? await readdir(dir) : [];
  return Promise.all(names.filter((name) => name.endsWith('.json') && isProduct(basename(name, '.json')))
    .map(async (name) => ({ product: basename(name, '.json') as Product, file: join(dir, name), saved: await json<Client>(join(dir, name)) })));
}

async function ownEntry(product: Product, config: string | undefined, dataDir: string) {
  if (!config || !existsSync(config)) return undefined;
  const entry = await registeredEntry(product, config), at = entry?.args.indexOf('--data-dir') ?? -1;
  return entry && at >= 0 && samePath(entry.args[at + 1] ?? '', dataDir) ? entry : undefined;
}

// Keeps the Node executable a registration was written with while it still exists, and the credential it already holds.
async function repoint(dataDir: string, cli: string, refreshSkills: boolean): Promise<string[]> {
  const notes: string[] = [];
  for (const { product, file, saved } of await clients(dataDir)) {
    const entry = await ownEntry(product, saved.config, dataDir);
    if (entry && !samePath(entry.args[0] ?? '', cli)) {
      await editConfig(saved.config!, product, { command: entry.command && existsSync(entry.command) ? entry.command : process.execPath,
        args: mcpArgs(cli, product, dataDir, entry.args.includes('--auto-start')) });
      notes.push(`Pointed ${product} at ${cli} in ${saved.config}`);
    }
    const skill = saved.skill && join(saved.skill.path, 'SKILL.md');
    if (!refreshSkills || !saved.skill || !skill || !existsSync(skill)) continue;
    if (scopeDigest(await readFile(skill, 'utf8')) !== saved.skill.digest) notes.push(`Kept your edited room skill: ${skill}`);
    else {
      await rm(skill);
      await privateJson(file, { ...saved, skill: await installSkill(saved.skill.path) });
    }
  }
  return notes;
}

async function relaunch(dataDir: string, version: string): Promise<string[]> {
  const launcher = join(dataDir, 'bin', 'converoom.ps1');
  if (!existsSync(launcher)) return [];
  const text = await readFile(launcher, 'utf8'), next = text.replace(/runtime\/[^/']+\/dist\/cli\.js/g, `runtime/${version}/dist/cli.js`);
  if (next === text) return [];
  await writeFile(launcher, next);
  return [`Pointed the converoom launcher at ${version}`];
}

async function backupStore(dataDir: string, destination: string, from: string) {
  await mkdir(destination, { recursive: true, mode: 0o700 });
  if (existsSync(database(dataDir))) await backupDatabase(database(dataDir), join(destination, 'converoom.sqlite'));
  if (existsSync(join(dataDir, 'artefacts'))) await cp(join(dataDir, 'artefacts'), join(destination, 'artefacts'), { recursive: true });
  await writeFile(join(destination, 'backup.json'),
    JSON.stringify({ schemaVersion: 1, kind: 'pre-upgrade backup', from, to: VERSION, createdAt: Date.now() }) + '\n', { mode: 0o600 });
}

export async function upgrade(dataDir: string): Promise<string[]> {
  await requireStopped(dataDir);
  const active = await activeInstallation(dataDir);
  if (!active) throw notInstalled();
  if (active.upgrade) {
    if (active.upgrade.to !== VERSION) throw interrupted(active.upgrade);
  } else {
    if (active.version === VERSION) return [`Converoom ${VERSION} is already the active version.`];
    if (compareVersions(VERSION, active.version) < 0)
      throw new ConveroomError('downgrade_refused', `Converoom ${active.version} is installed, so ${VERSION} would be a downgrade, which is refused. converoom recover --rollback returns to the version used before the last upgrade.`);
    const backup = join(dataDir, 'backups', `upgrade-${active.version}-${VERSION}-${Date.now()}`);
    await backupStore(dataDir, backup, active.version);
    await select(dataDir, { ...active, upgrade: { from: active.version, to: VERSION, backup, startedAt: Date.now(), schema: schema(dataDir) } });
  }
  return finishUpgrade(dataDir);
}

async function finishUpgrade(dataDir: string): Promise<string[]> {
  const step = (await activeInstallation(dataDir))!.upgrade!, cli = await installStable(dataDir);
  // Opening the store with this version checks its schema; a release that changes the schema migrates it here, after the backup.
  if (existsSync(database(dataDir))) createStore(database(dataDir)).close();
  const moved = await migrateCredentials(dataDir);
  const notes = [...await repoint(dataDir, cli, true), ...await relaunch(dataDir, VERSION),
    ...(moved ? [`Moved ${moved} saved credential${moved === 1 ? '' : 's'} into Windows Credential Manager.`] : [])];
  await select(dataDir, { version: VERSION, selectedAt: Date.now(), previous: step.from, backup: step.backup, previousSchema: step.schema, schema: schema(dataDir) });
  return [`Upgraded Converoom from ${step.from} to ${VERSION}. Backup: ${step.backup}`, ...notes, `${step.from} is kept; converoom recover --rollback returns to it.`];
}

export async function recover(dataDir: string, options: { rollback: boolean; confirm: boolean }): Promise<string[]> {
  await requireStopped(dataDir);
  const active = await activeInstallation(dataDir);
  if (!active) throw notInstalled();
  if (options.rollback) return rollback(dataDir, active, options.confirm);
  if (active.upgrade) {
    if (active.upgrade.to !== VERSION)
      throw new ConveroomError('version_mismatch', `The interrupted upgrade was to ${active.upgrade.to}. Run converoom recover from that package, or add --rollback to return to ${active.upgrade.from}.`);
    return finishUpgrade(dataDir);
  }
  const notes = [active.version === VERSION ? `Checked the ${VERSION} runtime files and repaired any that differed.` : `The active version is ${active.version}; only its own package can repair its files.`];
  if (active.version === VERSION) await installStable(dataDir);
  notes.push(...await repoint(dataDir, stableCli(dataDir, active.version), false), ...await relaunch(dataDir, active.version));
  return notes.length > 1 ? notes : [...notes, 'Registrations already point at the active runtime.'];
}

async function rollback(dataDir: string, active: Active, confirm: boolean): Promise<string[]> {
  const target = active.upgrade?.from ?? active.previous, backup = active.upgrade?.backup ?? active.backup;
  if (!target) throw new ConveroomError('no_previous_version', 'There is no previous version to roll back to.');
  if (!existsSync(join(runtimeDir(dataDir), target, 'installation.json')))
    throw new ConveroomError('runtime_missing', `The ${target} runtime files are missing, so Converoom cannot return to it.`);
  const before = active.upgrade ? active.upgrade.schema : active.previousSchema, after = active.upgrade ? schema(dataDir) : active.schema;
  const notes: string[] = [];
  if (before !== undefined && after !== undefined && before !== after) {
    if (!confirm)
      throw new ConveroomError('confirmation_required', `The room store changed format in ${active.version}, so ${target} cannot open it. Rolling back restores the backup at ${backup} and moves the current store aside, losing changes made since the upgrade. Run converoom recover --rollback --confirm.`);
    if (!backup || !existsSync(join(backup, 'converoom.sqlite')))
      throw new ConveroomError('backup_missing', `The pre-upgrade backup is missing, so the ${target} store cannot be restored.`);
    const aside = join(dataDir, 'backups', `rolled-back-${active.version}-${Date.now()}`);
    await mkdir(aside, { recursive: true, mode: 0o700 });
    for (const name of ['converoom.sqlite', 'converoom.sqlite-wal', 'converoom.sqlite-shm', 'artefacts'])
      if (existsSync(join(dataDir, name))) await rename(join(dataDir, name), join(aside, name));
    await cp(join(backup, 'converoom.sqlite'), database(dataDir));
    if (existsSync(join(backup, 'artefacts'))) await cp(join(backup, 'artefacts'), join(dataDir, 'artefacts'), { recursive: true });
    notes.push(`Restored the store from ${backup}. The store it replaced is in ${aside}.`);
  }
  notes.push(...await repoint(dataDir, stableCli(dataDir, target), false), ...await relaunch(dataDir, target));
  await select(dataDir, { version: target, selectedAt: Date.now() });
  return [`Rolled back to Converoom ${target}.`, ...notes];
}

export function withoutPathEntry(value: string, entry: string): string | undefined {
  const parts = value.split(';').filter(Boolean), kept = parts.filter((part) => !samePath(part, entry));
  return kept.length === parts.length ? undefined : kept.join(';');
}
const environment = (script: string, value = '') => promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script],
  { windowsHide: true, timeout: 15000, env: { ...process.env, CONVEROOM_PATH_VALUE: value } });
// The user PATH is read unexpanded as UTF-8 and written back with its registry type, so entries such as %USERPROFILE%\bin
// and non-ASCII folders survive. Clearing an unset variable makes Windows announce the change to new terminals.
async function userPathWithout(entry: string) {
  const { stdout } = await environment("$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment'); if ($k) { [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')))) }");
  return withoutPathEntry(Buffer.from(stdout.trim(), 'base64').toString('utf8'), entry);
}
async function setUserPath(value: string) {
  await environment("$k=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true); $k.SetValue('Path', $env:CONVEROOM_PATH_VALUE, $k.GetValueKind('Path')); [Environment]::SetEnvironmentVariable('CONVEROOM_PATH_REFRESH', $null, 'User')", value);
}

export async function uninstall(dataDir: string, options: { confirm: boolean; deleteData?: string }): Promise<string[]> {
  await requireStopped(dataDir);
  if (options.deleteData !== undefined && !samePath(options.deleteData, dataDir))
    throw new ConveroomError('confirmation_required', `--delete-data must repeat the data folder exactly: ${dataDir}`);
  const workspaces = join(dataDir, 'workspaces'), retained = existsSync(workspaces) ? await readdir(workspaces) : [];
  if (options.deleteData !== undefined && retained.length)
    throw new ConveroomError('retained_work', `Retained coding work would be deleted: ${retained.join(', ')}. Inspect and release it with converoom cleanup first.`);
  const owned = await clients(dataDir), bin = join(dataDir, 'bin'), path = await userPathWithout(bin);
  const plan = owned.flatMap(({ product, saved }) => [`- Revoke the ${product} bridge credential`,
    ...(saved.config ? [`- Remove the Converoom entry from ${saved.config}`] : []),
    ...(saved.skill ? [`- Remove the room skill in ${saved.skill.path} unless you edited it`] : [])]);
  for (const dir of [runtimeDir(dataDir), bin]) if (existsSync(dir)) plan.push(`- Delete ${dir}`);
  if (path !== undefined) plan.push(`- Remove ${bin} from your user PATH`);
  const kept = existsSync(join(dataDir, 'tools')) ? [`The bundled Node and the agent CLIs it installed stay in ${join(dataDir, 'tools')}.`] : [];
  const remote = options.deleteData === undefined ? [] : (await readdir(join(dataDir, 'remote')).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.json')).map((name) => join(dataDir, 'remote', name));
  const locations = await Promise.all([...owned.map(({ file }) => file), ...remote].map(credentialLocation));
  if (locations.some((where) => where && where !== 'private file')) plan.push('- Delete these saved credentials from Windows Credential Manager');
  if (options.deleteData !== undefined) plan.push(`- Delete all room data in ${dataDir}: rooms, history, artefacts and backups`);
  else kept.push(`Room data stays in ${dataDir}.`);
  if (!options.confirm) return ['Uninstall preview. Nothing was changed. Planned changes:', ...plan, ...kept, 'Run converoom uninstall --confirm to apply them.'];

  if (owned.length && existsSync(database(dataDir))) {
    const store = createStore(database(dataDir));
    try { for (const { saved } of owned) revokeBridgeCredential(store, saved.principalId); } finally { store.close(); }
  }
  for (const { product, file, saved } of owned) {
    if (await ownEntry(product, saved.config, dataDir)) await editConfig(saved.config!, product, {}, true);
    const edited = saved.skill && await removeSkill(saved.skill);
    if (edited) kept.push(`Your edited room skill stays: ${edited}`);
    await removeCredential(file);
  }
  for (const dir of [join(dataDir, 'clients'), runtimeDir(dataDir), bin]) await rm(dir, { recursive: true, force: true });
  if (path !== undefined) await setUserPath(path);
  for (const file of remote) await removeCredential(file);
  if (options.deleteData !== undefined)
    for (const name of await readdir(dataDir)) if (name !== 'tools') await rm(join(dataDir, name), { recursive: true, force: true });
  return ['Uninstalled Converoom. Changes made:', ...plan, ...kept, 'If you installed the npm package, remove it with: npm uninstall --global @converoom/cli'];
}
