import { readFile, writeFile, mkdir, cp, stat, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ConveroomError } from '../../../packages/shared/src/contracts.js';
import { scopeDigest } from '../../../packages/store/src/index.js';
export const VERSION = '0.2.0';
export function dataDirectory() {
  return (
    process.env.CONVEROOM_DATA_DIR ??
    (process.platform === 'win32'
      ? join(process.env.LOCALAPPDATA ?? homedir(), 'Converoom')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'Converoom')
        : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'converoom'))
  );
}
export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const script =
      "$ErrorActionPreference='Stop'; $p=$env:CONVEROOM_PRIVATE_PATH; $acl=[System.Security.AccessControl.DirectorySecurity]::new(); $acl.SetAccessRuleProtection($true,$false); $ids=@([System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); foreach($id in $ids){$rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new($id),'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule)}; [System.IO.Directory]::SetAccessControl($p,$acl)";
    await promisify(execFile)(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, timeout: 15000, env: { ...process.env, CONVEROOM_PRIVATE_PATH: path } },
    );
  }
}
export async function privateJson(path: string, value: unknown) {
  await privateDirectory(dirname(path));
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
export async function json<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}
export const secret = () => randomBytes(32).toString('base64url');
export function packageRoot() {
  let p = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(p, 'package.json'))) {
      const req = createRequire(join(p, 'package.json'));
      try {
        if (req('./package.json').name === '@converoom/cli') return p;
      } catch {
        /* Keep looking for the runtime package. */
      }
    }
    p = dirname(p);
  }
  throw new ConveroomError('runtime_missing', 'Cannot locate runtime package');
}
export async function installStable(dataDir: string): Promise<string> {
  const root = packageRoot(),
    target = join(dataDir, 'runtime', VERSION);
  if (resolve(root) === resolve(target)) return join(target, 'dist', 'cli.js');
  if (existsSync(join(target, 'installation.json'))) {
    const same = (
      await Promise.all(
        ['dist/cli.js', 'package.json', 'RELEASE_MANIFEST.json'].map(async (name) => {
          try {
            return (
              (await readFile(join(root, name), 'utf8')) ===
              (await readFile(join(target, name), 'utf8'))
            );
          } catch {
            return false;
          }
        }),
      )
    ).every(Boolean);
    const manifest = await json<{ assets?: { path: string; sha256: string }[] }>(
      join(root, 'RELEASE_MANIFEST.json'),
    );
    const valid =
      manifest.assets?.length &&
      (
        await Promise.all(
          manifest.assets.map(async (f) => {
            try {
              return (
                createHash('sha256')
                  .update(await readFile(join(target, f.path)))
                  .digest('hex') === f.sha256
              );
            } catch {
              return false;
            }
          }),
        )
      ).every(Boolean);
    if (same && valid) return join(target, 'dist', 'cli.js');
  }
  if (existsSync(join(dataDir, 'runtime.lock')))
    throw new ConveroomError(
      'runtime_active',
      'Stop the runtime before repairing this preview version. Existing payload preserved',
    );
  await mkdir(target, { recursive: true, mode: 0o700 });
  for (const name of [
    'dist',
    'plugins',
    'native/bin',
    'packages/plugin-content',
    'package.json',
    'README.md',
    'docs/WINDOWS_SHARED_PILOT.md',
    'docs/PREVIEW_ACCEPTANCE.md',
    'docs/REQUIREMENT_MATRIX.md',
    'LICENSE',
    'NOTICE',
    'RELEASE_MANIFEST.json',
    'THIRD_PARTY_NOTICES.md',
  ])
    if (existsSync(join(root, name)))
      await cp(join(root, name), join(target, name), { recursive: true, dereference: true });
  const copied = new Map<string, string>();
  async function dependency(name: string, from: string, destRoot: string) {
    const req = createRequire(join(from, 'package.json'));
    let entry: string;
    try {
      entry = req.resolve(name + '/package.json');
    } catch {
      entry = req.resolve(name);
    }
    let src = dirname(entry);
    let meta: Record<string, unknown>;
    while (true) {
      try {
        meta = await json<Record<string, unknown>>(join(src, 'package.json'));
        if (meta.name === name) break;
      } catch {
        /* Package entry may be nested. */
      }
      const parent = dirname(src);
      if (parent === src) throw new Error('Cannot locate dependency ' + name);
      src = parent;
    }
    const existing = copied.get(name);
    if (existing === String(meta.version)) return;
    const dst = join(existing ? destRoot : target, 'node_modules', name);
    if (existing && existsSync(dst)) return;
    await mkdir(dirname(dst), { recursive: true });
    await cp(src, dst, { recursive: true, dereference: true });
    if (!existing) copied.set(name, String(meta.version));
    for (const dep of Object.keys(meta.dependencies ?? {})) await dependency(dep, src, dst);
  }
  const meta = await json<{ dependencies: Record<string, string> }>(join(root, 'package.json'));
  for (const name of Object.keys(meta.dependencies)) await dependency(name, root, target);
  await privateJson(join(target, 'installation.json'), {
    version: VERSION,
    installedAt: Date.now(),
    source: 'compiled versioned npm package',
    credentialStorage: 'user files; OS keystore unavailable',
  });
  if (!(await stat(join(target, 'dist', 'cli.js'))).isFile())
    throw new ConveroomError('build_required', 'Build the compiled package first');
  return join(target, 'dist', 'cli.js');
}
export async function editConfig(
  path: string,
  product: string,
  entry: unknown,
  remove = false,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (product === 'codex') {
    let text = '';
    try {
      text = await readFile(path, 'utf8');
    } catch {
      /* Fresh config. */
    }
    const marker = '[mcp_servers.converoom]',
      lines = text.split(/\r?\n/),
      out: string[] = [];
    let ours = false;
    for (const line of lines) {
      if (line.trim() === marker) {
        ours = true;
        continue;
      }
      if (ours && /^\s*\[/.test(line)) ours = false;
      if (!ours) out.push(line);
    }
    if (!remove) {
      const e = entry as { command: string; args: string[] };
      out.push(
        '',
        marker,
        'command = ' + JSON.stringify(e.command),
        'args = ' + JSON.stringify(e.args),
      );
    }
    await writeFile(path, out.join('\n').trimEnd() + '\n');
    return;
  }
  let current: Record<string, unknown> = {};
  try {
    current = await json(path);
  } catch (e) {
    if (existsSync(path))
      throw new ConveroomError(
        'config_invalid',
        'Config must be valid JSON; existing file preserved',
      );
    void e;
  }
  const key = product === 'opencode' ? 'mcp' : 'mcpServers';
  const servers = (current[key] as Record<string, unknown>) ?? {};
  if (remove) delete servers.converoom;
  else
    servers.converoom =
      product === 'opencode'
        ? {
            type: 'local',
            command: [
              (entry as { command: string }).command,
              ...(entry as { args: string[] }).args,
            ],
            enabled: true,
          }
        : entry;
  current[key] = servers;
  await writeFile(path, JSON.stringify(current, null, 2) + '\n');
}
export async function installSkill(path: string): Promise<{ path: string; digest: string }> {
  const source = join(
      packageRoot(),
      'packages',
      'plugin-content',
      'skills',
      'converoom-room',
      'SKILL.md',
    ),
    text = await readFile(source, 'utf8');
  const target = join(path, 'SKILL.md');
  if (existsSync(target) && (await readFile(target, 'utf8')) !== text)
    throw new ConveroomError(
      'skill_conflict',
      'An existing different Converoom skill was preserved. Choose a separate --skills-dir',
    );
  await mkdir(path, { recursive: true });
  await cp(source, target);
  return { path, digest: scopeDigest(text) };
}
export async function removeSkill(skill: { path: string; digest: string }): Promise<void> {
  const file = join(skill.path, 'SKILL.md');
  if (!existsSync(file)) return;
  if (scopeDigest(await readFile(file, 'utf8')) !== skill.digest)
    throw new ConveroomError(
      'skill_changed',
      'Modified skill preserved. Inspect it before removing',
    );
  await rm(file);
}
