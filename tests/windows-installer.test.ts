import { it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseOnboardProducts } from '../apps/cli/src/onboard.js';

async function install(mode: string) {
  const root = await mkdtemp(join(tmpdir(), 'converoom-windows-bundle-'));
  try {
    const bundle = join(root, 'bundle');
    const assets = [];
    const paths = ['node/node.exe', 'node/node_modules/npm/bin/npm-cli.js', 'runtime/dist/cli.js', 'runtime/package.json'];
    if (mode === 'unicode') paths.push('runtime/snow ☃/[...]/100%.txt');
    for (const path of paths) {
      const content = 'fixture ' + path;
      await mkdir(join(bundle, path, '..'), { recursive: true });
      await writeFile(join(bundle, path), content);
      assets.push({ path, sha256: createHash('sha256').update(content).digest('hex') });
    }
    await writeFile(join(bundle, 'bundle.json'), JSON.stringify({ schemaVersion: 1, version: '0.2.0', nodeVersion: '24.21.0', assets }));
    if (mode === 'tampered') await writeFile(join(bundle, 'runtime/dist/cli.js'), 'modified');
    if (mode === 'escape') {
      assets[0].path = '../outside.exe';
      await writeFile(join(bundle, 'bundle.json'), JSON.stringify({ schemaVersion: 1, version: '0.2.0', nodeVersion: '24.21.0', assets }));
    }
    const fixture = join(root, 'fixture.ps1');
    if (mode === 'entry') await writeFile(join(root, 'install.ps1'), await readFile('scripts/install-windows.ps1'));
    await writeFile(fixture, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), await readFile('tests/fixtures/windows-installer.ps1')]));
    const result = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fixture, '-ModulePath', resolve('scripts/windows-install.psm1'), '-NodePath', process.execPath, '-Root', root, '-Mode', mode], { windowsHide: true, timeout: 15000 });
    const receipt = JSON.parse((await readFile(join(root, 'result.json'), 'utf8')).replace(/^\uFEFF/, ''));
    if (mode === 'entry') receipt.receipt = JSON.parse(await readFile(join(root, 'argv.json'), 'utf8'));
    return { ...receipt, output: result.stdout };
  } finally { await rm(root, { recursive: true, force: true }); }
}

it('installs missing Git, Tailscale and the selected agent before reporting local readiness', async () => {
  const result = await install('missing');
  expect(result.error).toBeNull();
  expect(result.calls.filter((c: { args: string[] }) => c.args[0] === 'install').map((c: { args: string[] }) => c.args)).toEqual([
    ['install', '--id', 'Git.Git', '--exact', '--source', 'winget', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'],
    ['install', '--id', 'Tailscale.Tailscale', '--exact', '--source', 'winget', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'],
  ]);
  expect(result.calls.some((c: { args: string[] }) => c.args.includes('@openai/codex'))).toBe(true);
  expect(result.receipt.products).toEqual(['codex']);
  expect(result.receipt.tailscale).toBe('NeedsLogin');
  expect(result.receipt.sharedAccess).toBe('disabled');
  expect(result.launcher).toContain('dist');
});

it('reuses installed prerequisites without reinstalling them', async () => {
  const result = await install('existing');
  expect(result.error).toBeNull();
  expect(result.calls.some((c: { args: string[] }) => c.args[0] === 'install' || c.args.includes('@openai/codex'))).toBe(false);
});

it('accepts valid Unicode, brackets and percent characters in bundled dependency filenames', async () => {
  const result = await install('unicode');
  expect(result.error).toBeNull();
  expect(result.receipt.localInstallation).toBe('verified');
});

it.each(['tampered', 'escape'])('rejects a %s bundle before installing prerequisites', async (mode) => {
  const result = await install(mode);
  expect(result.error).toMatch(mode === 'tampered' ? /digest/i : /path/i);
  expect(result.calls).toEqual([]);
  expect(result.receipt).toBeNull();
});

it('does not report readiness after a prerequisite installer fails', async () => {
  const result = await install('failed');
  expect(result.error).toContain('Git.Git');
  expect(result.receipt).toBeNull();
  expect(result.calls.some((c: { args: string[] }) => c.args.includes('setup'))).toBe(false);
});

it('preserves a locked runtime before modifying its tools or registrations', async () => {
  const result = await install('locked');
  expect(result.error).toMatch(/stop.*runtime/i);
  expect(result.calls).toEqual([]);
  expect(result.retained).toBe('keep existing work');
});

it('passes quotes, empty arguments and shell characters literally to native installers', async () => {
  const result = await install('argv');
  expect(result.error).toBeNull();
  expect(result.receipt).toEqual(['a "quote"', '', 'C:\\space path\\', '$(literal); & whoami', 'Tiếng Việt']);
});

it('starts onboarding without an agent through the Windows PowerShell installer entry point', async () => {
  const result = await install('entry');
  expect(result.error).toBeNull();
  expect(result.receipt.slice(0, 2)).toEqual(['onboard', '--products']);
  expect(parseOnboardProducts(result.receipt[2])).toEqual([]);
  expect(result.receipt[3]).toBe('--data-dir');
  expect(result.receipt[4]).toMatch(/data$/);
});
