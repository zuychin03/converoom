import { it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { main } from '../apps/cli/src/index.js';
import { editConfig, privateJson, VERSION } from '../apps/cli/src/support.js';
import { installationStatus, withoutPathEntry } from '../apps/cli/src/lifecycle.js';
import { createStore, scopeDigest } from '../packages/store/src/index.js';

const OLD = '0.1.9', EARLIER_SKILL = 'Earlier room skill\n';
const bundledSkill = () => readFile('packages/plugin-content/skills/converoom-room/SKILL.md', 'utf8');

// The files installStable leaves for a release, small enough to stand in for an earlier one.
async function payload(dataDir: string, version: string) {
  const dir = join(dataDir, 'runtime', version), cli = join(dir, 'dist', 'cli.js'), text = '// ' + version;
  await mkdir(join(dir, 'dist'), { recursive: true });
  await writeFile(cli, text);
  await writeFile(join(dir, 'RELEASE_MANIFEST.json'), JSON.stringify({ assets: [{ path: 'dist/cli.js', sha256: createHash('sha256').update(text).digest('hex') }] }));
  await writeFile(join(dir, 'installation.json'), JSON.stringify({ version }));
  return cli;
}

async function installation(root: string, active?: Record<string, unknown>, registeredVersion = OLD) {
  const dataDir = join(root, 'data'), old = await payload(dataDir, OLD);
  if (active) await writeFile(join(dataDir, 'runtime', 'active.json'), JSON.stringify(active));
  const store = createStore(join(dataDir, 'converoom.sqlite'));
  store.put('bridge', 'codex-hash', { kind: 'agent', principalId: 'codex-principal', ownerId: 'owner' });
  store.put('bridge', 'cursor-hash', { kind: 'agent', principalId: 'cursor-principal', ownerId: 'owner' });
  store.close();
  const codexConfig = join(root, 'codex.toml'), cursorConfig = join(root, 'cursor.json');
  await writeFile(codexConfig, 'model = "preserve"\n');
  await writeFile(cursorConfig, JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
  const cli = join(dataDir, 'runtime', registeredVersion, 'dist', 'cli.js');
  await editConfig(codexConfig, 'codex', { command: process.execPath, args: [cli, 'mcp', '--client', 'codex', '--data-dir', dataDir] });
  await editConfig(cursorConfig, 'cursor', { command: process.execPath, args: [cli, 'mcp', '--client', 'cursor', '--data-dir', dataDir] });
  const skills = { codex: join(root, 'skills', 'codex'), cursor: join(root, 'skills', 'cursor') };
  for (const path of Object.values(skills)) { await mkdir(path, { recursive: true }); await writeFile(join(path, 'SKILL.md'), EARLIER_SKILL); }
  await writeFile(join(skills.cursor, 'SKILL.md'), 'Owner notes\n');
  for (const product of ['codex', 'cursor'] as const)
    await privateJson(join(dataDir, 'clients', product + '.json'), { principalId: product + '-principal', token: product + '-token',
      config: product === 'codex' ? codexConfig : cursorConfig, skill: { path: skills[product], digest: scopeDigest(EARLIER_SKILL) } });
  return { dataDir, old, codexConfig, cursorConfig, skills, activeFile: join(dataDir, 'runtime', 'active.json') };
}

async function registered(product: 'codex' | 'cursor', file: string) {
  const text = await readFile(file, 'utf8');
  if (product === 'codex') {
    const table = text.slice(text.indexOf('[mcp_servers.converoom]'));
    if (!text.includes('[mcp_servers.converoom]')) return undefined;
    const value = (key: string) => JSON.parse(table.match(new RegExp('^' + key + ' = (.*)$', 'm'))![1]);
    return { command: value('command'), args: value('args') };
  }
  return JSON.parse(text).mcpServers.converoom;
}

const deadPid = async () => {
  const child = spawn(process.execPath, ['-e', ''], { windowsHide: true });
  await once(child, 'exit');
  return child.pid!;
};
const output = (log: ReturnType<typeof vi.spyOn>) => log.mock.calls.flat().join('\n');

it('upgrades to this package: backs up the store, repoints registrations without new credentials and refreshes unchanged skills', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-upgrade-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const f = await installation(root, { version: OLD, selectedAt: 1 });
    await main(['upgrade', '--data-dir', f.dataDir]);
    const stable = join(f.dataDir, 'runtime', VERSION, 'dist', 'cli.js');
    expect(existsSync(join(f.dataDir, 'runtime', VERSION, 'installation.json'))).toBe(true);
    const active = JSON.parse(await readFile(f.activeFile, 'utf8'));
    expect(active).toMatchObject({ version: VERSION, previous: OLD });
    expect(active.upgrade).toBeUndefined();
    expect(await registered('codex', f.codexConfig)).toEqual({ command: process.execPath, args: [stable, 'mcp', '--client', 'codex', '--data-dir', f.dataDir] });
    expect(await readFile(f.codexConfig, 'utf8')).toContain('model = "preserve"');
    expect((await registered('cursor', f.cursorConfig)).args[0]).toBe(stable);
    expect(JSON.parse(await readFile(f.cursorConfig, 'utf8')).mcpServers.other).toEqual({ command: 'other' });
    expect(await readFile(join(f.skills.codex, 'SKILL.md'), 'utf8')).toBe(await bundledSkill());
    expect(await readFile(join(f.skills.cursor, 'SKILL.md'), 'utf8')).toBe('Owner notes\n');
    expect(JSON.parse(await readFile(join(f.dataDir, 'clients', 'codex.json'), 'utf8')))
      .toMatchObject({ principalId: 'codex-principal', token: 'codex-token', skill: { digest: scopeDigest(await bundledSkill()) } });
    const backups = await readdir(join(f.dataDir, 'backups'));
    expect(backups).toEqual([expect.stringMatching(new RegExp('^upgrade-' + OLD + '-' + VERSION + '-'))]);
    const backup = createStore(join(f.dataDir, 'backups', backups[0]!, 'converoom.sqlite'));
    try { expect(backup.list('bridge')).toHaveLength(2); } finally { backup.close(); }
    expect(existsSync(f.old)).toBe(true);
    expect(output(log)).toContain(join(f.skills.cursor, 'SKILL.md'));
  } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 180000);

it('refuses a downgrade, a running runtime, a version mismatch and an interrupted upgrade without changing anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-refuse-'));
  try {
    const f = await installation(root, { version: '9.0.0', selectedAt: 1 });
    const config = await readFile(f.codexConfig, 'utf8');
    await expect(main(['upgrade', '--data-dir', f.dataDir])).rejects.toThrow(/downgrade/i);
    await expect(main(['setup', '--data-dir', f.dataDir])).rejects.toThrow(/9\.0\.0/);
    expect(await installationStatus(f.dataDir)).toMatchObject({ active: '9.0.0', package: VERSION, status: 'package older than the installed version' });
    await writeFile(f.activeFile, JSON.stringify({ version: OLD, selectedAt: 1 }));
    expect(await installationStatus(f.dataDir)).toMatchObject({ active: OLD, status: 'upgrade available' });
    for (const args of [['setup'], ['start'], ['connect', 'codex', '--config', f.codexConfig], ['onboard', '--no-open']])
      await expect(main([...args, '--data-dir', f.dataDir])).rejects.toThrow(/converoom upgrade/);
    await rm(f.activeFile);
    await expect(main(['setup', '--data-dir', f.dataDir])).rejects.toThrow(new RegExp(OLD.replaceAll('.', '\\.') + '[\\s\\S]*converoom upgrade'));
    await writeFile(join(f.dataDir, 'runtime.lock'), JSON.stringify({ pid: process.pid }));
    for (const args of [['upgrade'], ['uninstall', '--confirm'], ['recover']])
      await expect(main([...args, '--data-dir', f.dataDir])).rejects.toThrow(/converoom stop/);
    await rm(join(f.dataDir, 'runtime.lock'));
    await writeFile(f.activeFile, JSON.stringify({ version: OLD, selectedAt: 1, upgrade: { from: OLD, to: '0.2.5', backup: join(root, 'backup'), startedAt: 1 } }));
    for (const args of [['start'], ['setup'], ['upgrade']])
      await expect(main([...args, '--data-dir', f.dataDir])).rejects.toThrow(/converoom recover/);
    expect(await readFile(f.codexConfig, 'utf8')).toBe(config);
    expect(existsSync(join(f.dataDir, 'backups'))).toBe(false);
    expect(existsSync(join(f.dataDir, 'runtime', VERSION))).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120000);

it('recovers an interrupted upgrade, clears a dead runtime, repoints stale registrations and verifies the payload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-recover-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const f = await installation(root);
    const backup = join(f.dataDir, 'backups', 'upgrade-fixture');
    await writeFile(f.activeFile, JSON.stringify({ version: OLD, selectedAt: 1, upgrade: { from: OLD, to: VERSION, backup, startedAt: 1 } }));
    const pid = await deadPid();
    await writeFile(join(f.dataDir, 'runtime.lock'), JSON.stringify({ pid }));
    await writeFile(join(f.dataDir, 'runtime.json'), JSON.stringify({ url: 'http://127.0.0.1:9', pid, controlToken: 'stale' }));
    await main(['recover', '--data-dir', f.dataDir]);
    const stable = join(f.dataDir, 'runtime', VERSION, 'dist', 'cli.js');
    expect(JSON.parse(await readFile(f.activeFile, 'utf8'))).toMatchObject({ version: VERSION, previous: OLD, backup });
    expect((await registered('codex', f.codexConfig)).args[0]).toBe(stable);
    expect(existsSync(join(f.dataDir, 'runtime.lock')) || existsSync(join(f.dataDir, 'runtime.json'))).toBe(false);

    await editConfig(f.codexConfig, 'codex', { command: process.execPath, args: [join(f.dataDir, 'runtime', '0.1.5', 'dist', 'cli.js'), 'mcp', '--client', 'codex', '--data-dir', f.dataDir] });
    await writeFile(join(f.dataDir, 'runtime', VERSION, 'dist', 'cli.js'), 'damaged');
    log.mockClear();
    await main(['recover', '--data-dir', f.dataDir]);
    expect((await registered('codex', f.codexConfig)).args[0]).toBe(stable);
    expect(await readFile(stable, 'utf8')).toBe(await readFile('dist/cli.js', 'utf8'));
    expect(output(log)).toMatch(/codex/);
  } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 180000);

it('rolls back to the previous version, restoring the pre-upgrade backup only with --confirm when the schema changed', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-rollback-'));
  try {
    const backup = join(root, 'data', 'backups', 'upgrade-fixture');
    const f = await installation(root, { version: '0.2.5', previous: OLD, selectedAt: 1, backup, previousSchema: 1, schema: 1 }, '0.2.5');
    await payload(f.dataDir, '0.2.5');
    await main(['recover', '--rollback', '--data-dir', f.dataDir]);
    expect(JSON.parse(await readFile(f.activeFile, 'utf8'))).toMatchObject({ version: OLD });
    expect((await registered('codex', f.codexConfig)).args[0]).toBe(f.old);
    expect((await registered('cursor', f.cursorConfig)).args[0]).toBe(f.old);
    await expect(main(['recover', '--rollback', '--data-dir', f.dataDir])).rejects.toThrow(/no previous version/i);

    await mkdir(backup, { recursive: true });
    const saved = createStore(join(backup, 'converoom.sqlite'));
    saved.put('room', 'before-upgrade', { id: 'before-upgrade' });
    saved.close();
    const current = createStore(join(f.dataDir, 'converoom.sqlite'));
    current.put('room', 'after-upgrade', { id: 'after-upgrade' });
    current.close();
    await writeFile(f.activeFile, JSON.stringify({ version: '0.2.5', previous: OLD, selectedAt: 1, backup, previousSchema: 1, schema: 2 }));
    await expect(main(['recover', '--rollback', '--data-dir', f.dataDir])).rejects.toThrow(/--confirm/);
    expect(JSON.parse(await readFile(f.activeFile, 'utf8')).version).toBe('0.2.5');
    await main(['recover', '--rollback', '--confirm', '--data-dir', f.dataDir]);
    const restored = createStore(join(f.dataDir, 'converoom.sqlite'));
    try {
      expect(restored.get('room', 'before-upgrade')).toBeTruthy();
      expect(restored.get('room', 'after-upgrade')).toBeUndefined();
    } finally { restored.close(); }
    const aside = (await readdir(join(f.dataDir, 'backups'))).find((name) => name.startsWith('rolled-back-0.2.5-'))!;
    const moved = createStore(join(f.dataDir, 'backups', aside, 'converoom.sqlite'));
    try { expect(moved.get('room', 'after-upgrade')).toBeTruthy(); } finally { moved.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120000);

it('uninstall previews by default, then removes only what Converoom owns and revokes its credentials', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-uninstall-'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const f = await installation(root, { version: OLD, selectedAt: 1 });
    await mkdir(join(f.dataDir, 'bin'));
    await writeFile(join(f.dataDir, 'bin', 'converoom.ps1'), 'launcher');
    await mkdir(join(f.dataDir, 'tools', 'agents'), { recursive: true });
    await writeFile(join(f.dataDir, 'tools', 'agents', 'codex.cmd'), 'agent');
    await mkdir(join(f.dataDir, 'artefacts'));
    await writeFile(join(f.dataDir, 'artefacts', 'shared.txt'), 'artefact');
    const codex = await readFile(f.codexConfig, 'utf8');
    await main(['uninstall', '--data-dir', f.dataDir]);
    expect(output(log)).toMatch(/nothing was changed/i);
    expect(output(log)).toContain(f.codexConfig);
    expect(await readFile(f.codexConfig, 'utf8')).toBe(codex);
    expect(existsSync(join(f.dataDir, 'runtime')) && existsSync(join(f.dataDir, 'bin', 'converoom.ps1'))).toBe(true);

    log.mockClear();
    await main(['uninstall', '--confirm', '--data-dir', f.dataDir]);
    expect(await registered('codex', f.codexConfig)).toBeUndefined();
    expect(await readFile(f.codexConfig, 'utf8')).toContain('model = "preserve"');
    expect(JSON.parse(await readFile(f.cursorConfig, 'utf8')).mcpServers).toEqual({ other: { command: 'other' } });
    expect(existsSync(join(f.skills.codex, 'SKILL.md'))).toBe(false);
    expect(await readFile(join(f.skills.cursor, 'SKILL.md'), 'utf8')).toBe('Owner notes\n');
    for (const gone of ['clients', 'runtime', 'bin']) expect(existsSync(join(f.dataDir, gone))).toBe(false);
    for (const kept of ['converoom.sqlite', join('artefacts', 'shared.txt'), join('tools', 'agents', 'codex.cmd')]) expect(existsSync(join(f.dataDir, kept))).toBe(true);
    const store = createStore(join(f.dataDir, 'converoom.sqlite'));
    try {
      expect(store.get('revoked', 'codex-principal')).toBe(true);
      expect(store.get('revoked', 'cursor-principal')).toBe(true);
      expect(store.list<{ type: string }>('authority_audit').filter((r) => r.type === 'bridge.credential_revoked')).toHaveLength(2);
    } finally { store.close(); }
    expect(output(log)).toContain('npm uninstall --global @converoom/cli');
    expect(output(log)).toContain(f.dataDir);

    await mkdir(join(f.dataDir, 'workspaces', 'attempt-1'), { recursive: true });
    await expect(main(['uninstall', '--confirm', '--delete-data', f.dataDir, '--data-dir', f.dataDir])).rejects.toThrow(/attempt-1/);
    await rm(join(f.dataDir, 'workspaces'), { recursive: true });
    await expect(main(['uninstall', '--confirm', '--delete-data', join(root, 'elsewhere'), '--data-dir', f.dataDir])).rejects.toThrow(/data folder/i);
    await expect(main(['uninstall', '--delete-data', f.dataDir, '--data-dir', f.dataDir])).resolves.toBeUndefined();
    expect(existsSync(join(f.dataDir, 'converoom.sqlite'))).toBe(true);
    await main(['uninstall', '--confirm', '--delete-data', f.dataDir, '--data-dir', f.dataDir]);
    expect(await readdir(f.dataDir)).toEqual(['tools']);
  } finally { log.mockRestore(); await rm(root, { recursive: true, force: true }); }
}, 120000);

it('removes only the exact launcher folder from a PATH value', () => {
  expect(withoutPathEntry('C:\\Tools;C:\\Data\\bin\\;D:\\x', 'c:\\data\\bin')).toBe('C:\\Tools;D:\\x');
  expect(withoutPathEntry('C:\\Tools;C:\\Data\\binary', 'C:\\Data\\bin')).toBeUndefined();
  expect(withoutPathEntry('%USERPROFILE%\\bin;C:\\Data\\bin', 'C:\\Data\\bin')).toBe('%USERPROFILE%\\bin');
  expect(withoutPathEntry('C:\\Data\\bin', 'C:\\Data\\bin')).toBe('');
});
