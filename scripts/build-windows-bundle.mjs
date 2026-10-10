import { mkdir, readFile, writeFile, cp, readdir, access } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

if (process.platform !== 'win32' || process.arch !== 'x64' || process.versions.node !== '24.21.0') {
  throw new Error('Build the Windows x64 bundle with Node 24.21.0');
}
const digest = (data) => createHash('sha256').update(data).digest('hex');
const root = process.cwd(), meta = JSON.parse(await readFile('package.json', 'utf8'));
const output = resolve('.artifacts/windows-bundle'), stage = join(output, 'build-' + Date.now());
const bundle = join(stage, 'converoom-' + meta.version + '-windows-x64');
const nodeFile = 'node-v24.21.0-win-x64.zip';
const nodeSha256 = '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541';
const nodeUrl = 'https://nodejs.org/dist/v24.21.0/' + nodeFile;
await mkdir(bundle, { recursive: true });
const cache = join(output, nodeFile);
try { await access(cache); }
catch {
  const response = await fetch(nodeUrl, { signal: globalThis.AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error('Node download failed: ' + response.status);
  await writeFile(cache, Buffer.from(await response.arrayBuffer()));
}
if (digest(await readFile(cache)) !== nodeSha256) throw new Error('Official Node ZIP checksum mismatch');
const run = promisify(execFile);
await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:CONVEROOM_BUILD_ZIP,$env:CONVEROOM_BUILD_NODE)"],
  { windowsHide: true, timeout: 180000, env: { ...process.env, CONVEROOM_BUILD_ZIP: cache, CONVEROOM_BUILD_NODE: join(stage, 'node-source') } });
await cp(join(stage, 'node-source', 'node-v24.21.0-win-x64'), join(bundle, 'node'), { recursive: true });
const sourceData = join(stage, 'source-data');
await run(process.execPath, [join(root, 'dist/cli.js'), 'setup', '--data-dir', sourceData], { windowsHide: true, timeout: 180000 });
await cp(join(sourceData, 'runtime', meta.version), join(bundle, 'runtime'), { recursive: true,
  filter: (path) => !path.endsWith('installation.json') });
await cp('scripts/install-windows.ps1', join(bundle, 'install.ps1'));
await cp('scripts/windows-install.psm1', join(bundle, 'windows-install.psm1'));
await cp('docs/WINDOWS_INSTALL.md', join(bundle, 'INSTALL.md'));
const assets = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) assets.push({ path: relative(bundle, path).replaceAll('\\', '/'), sha256: digest(await readFile(path)) });
    else throw new Error('Unexpected link in bundle: ' + path);
  }
}
await walk(bundle);
await writeFile(join(bundle, 'bundle.json'), JSON.stringify({ schemaVersion: 1, version: meta.version, nodeVersion: '24.21.0',
  nodeSource: { url: nodeUrl, sha256: nodeSha256 }, assets: assets.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2) + '\n');
const archive = join(stage, 'converoom-' + meta.version + '-windows-x64.zip');
await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
  "Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:CONVEROOM_BUILD_SOURCE,$env:CONVEROOM_BUILD_ARCHIVE)"],
  { windowsHide: true, timeout: 180000, env: { ...process.env, CONVEROOM_BUILD_SOURCE: bundle, CONVEROOM_BUILD_ARCHIVE: archive } });
const receipt = { archive, bundle, version: meta.version, node: '24.21.0', nodeSha256, assets: assets.length,
  archiveSha256: digest(await readFile(archive)), sourceCommit: (await run('git.exe', ['rev-parse', 'HEAD'])).stdout.trim() };
await writeFile(join(output, 'latest.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(JSON.stringify(receipt, null, 2));
