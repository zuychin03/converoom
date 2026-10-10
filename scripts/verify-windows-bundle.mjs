import { mkdtemp, readFile, writeFile, mkdir, readdir, access, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve, relative } from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const run = promisify(execFile), receipt = JSON.parse(await readFile('.artifacts/windows-bundle/latest.json', 'utf8'));
const root = await mkdtemp(join(tmpdir(), 'converoom-bundle-smoke-'));
const data = join(root, 'data'), home = join(root, 'home'), extracted = join(root, 'extracted');
const report = { archiveSha256: receipt.archiveSha256, node: '24.21.0', realVendorInference: false,
  machineInstallers: 'fixtures only', realTailscale: false };
let daemon, exited, metadata, client;
const assert = (value, message) => { if (!value) throw new Error(message); };
const pause = () => new Promise((resolve) => setTimeout(resolve, 100));
try {
  assert(createHash('sha256').update(await readFile(receipt.archive)).digest('hex') === receipt.archiveSha256, 'Archive digest changed');
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($env:CONVEROOM_SMOKE_ZIP,$env:CONVEROOM_SMOKE_ROOT)'],
    { windowsHide: true, timeout: 180000, env: { ...process.env, CONVEROOM_SMOKE_ZIP: receipt.archive, CONVEROOM_SMOKE_ROOT: extracted } });
  await mkdir(home, { recursive: true });
  const env = { ...process.env, USERPROFILE: home, HOME: home, CONVEROOM_DATA_DIR: data,
    PATH: join(extracted, 'node') + ';' + join(process.env.SystemRoot, 'System32') + ';' +
      join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0') };
  const fixture = join(root, 'install-fixture.ps1');
  await cp('tests/fixtures/windows-bundle-install.ps1', fixture);
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixture,
    '-Bundle', extracted, '-DataDirectory', data], { env, windowsHide: true, timeout: 180000 });
  const node = join(data, 'tools/node-v24.21.0/node.exe'), cli = join(data, 'runtime', receipt.version, 'dist/cli.js');
  const installedEnv = { ...env, PATH: dirname(node) + ';' + env.PATH };
  const command = (args) => run(node, [cli, ...args, '--data-dir', data], { env: installedEnv, windowsHide: true, timeout: 180000 });
  assert((await run(node, ['--version'])).stdout.trim() === 'v24.21.0', 'Wrong bundled Node');
  await access(join(data, 'runtime', receipt.version, 'node_modules/better-sqlite3/prebuilds/win32-x64.node'));
  await access(join(data, 'runtime', receipt.version, 'native/bin/win32-x64/converoom-supervisor.exe'));
  report.installedWithoutSystemNode = true;
  let output = '';
  daemon = spawn(node, [cli, 'onboard', '--products', 'codex,cursor,claude,opencode,antigravity,kiro,qoder,grok', '--no-open', '--data-dir', data],
    { env: installedEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
  exited = once(daemon, 'exit');
  daemon.stdout.on('data', (chunk) => { output = (output + chunk.toString()).slice(-65536); });
  daemon.stderr.on('data', (chunk) => { output = (output + chunk.toString()).slice(-65536); });
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    if (daemon.exitCode !== null) throw new Error('Bundled onboarding exited early');
    if (output.includes('Ctrl+C stops this local runtime.')) break;
    await pause();
  }
  assert(output.includes('Ctrl+C stops this local runtime.'), 'Bundled onboarding readiness deadline exceeded');
  metadata = JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8'));
  const health = await (await fetch(metadata.url + '/health')).json();
  assert(health.name === 'converoom' && health.pid === metadata.pid && !metadata.sharedOrigin, 'Local identity or isolation failed');
  const pairing = output.match(/Browser pairing code: (\S+)/)?.[1];
  assert(pairing, 'Pairing code missing from terminal');
  const paired = await fetch(metadata.url + '/api/pair', { method: 'POST', headers: { origin: metadata.url, 'content-type': 'application/json' },
    body: JSON.stringify({ code: pairing }) });
  assert(paired.ok, 'Bundled UI pairing failed'); report.browserPairing = true;
  const products = ['codex', 'cursor', 'claude', 'opencode', 'antigravity', 'kiro', 'qoder', 'grok'];
  for (const product of products) await access(join(data, 'clients', product + '.json'));
  const config = await readFile(join(home, '.codex/config.toml'), 'utf8');
  assert(config.includes('[mcp_servers.converoom]') && config.includes('node-v24.21.0') && config.includes('runtime'), 'Registration did not bind bundled Node and stable runtime');
  report.mcpRegistrations = products.length;
  async function mcp(name, args) {
    client = new Client({ name: 'bundle-smoke', version: '1' }, { capabilities: {} });
    await client.connect(new StdioClientTransport({ command: node, args: [cli, 'mcp', '--client', 'codex', '--data-dir', data], env: installedEnv, stderr: 'pipe' }));
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, 'Bundled MCP failed: ' + name);
    await client.close(); client = undefined;
    return JSON.parse(result.content[0].text).result;
  }
  const room = await mcp('room_create', { title: 'Bundle smoke', objective: 'Check installed room lifecycle', clientKey: 'bundle-smoke-room' });
  assert((await mcp('room_get', { roomId: room.id })).title === 'Bundle smoke', 'Installed room not readable');
  report.realMcpRoomExchange = true;
  await command(['stop']); await exited; daemon = undefined; metadata = undefined;
  assert(!(await readdir(data)).includes('runtime.lock'), 'Owned runtime lock retained after shutdown');
  report.ownedRuntimeShutdown = true;
  await command(['setup']); report.repeatedSetup = true;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(data, 'bin/converoom.ps1'), 'version'],
    { env: installedEnv, windowsHide: true, timeout: 30000 }); report.launcher = true;
  daemon = spawn(node, [cli, 'start', '--data-dir', data], { env: installedEnv, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  exited = once(daemon, 'exit'); daemon.stdout.resume(); daemon.stderr.resume();
  for (let i = 0; i < 150; i++) {
    try { metadata = JSON.parse(await readFile(join(data, 'runtime.json'), 'utf8')); if (metadata.pid === daemon.pid && (await fetch(metadata.url + '/health')).ok) break; }
    catch { /* Wait for the fresh owned process. */ }
    await pause();
  }
  assert(metadata?.pid === daemon.pid, 'Restart did not become ready');
  assert((await mcp('room_get', { roomId: room.id })).title === 'Bundle smoke', 'Room history lost on restart');
  report.historyAfterRestart = true;
  await command(['stop']); await exited; daemon = undefined;
  report.outcome = 'passed';
} catch (error) { report.outcome = 'failed'; report.error = error.message; process.exitCode = 1; }
finally {
  await client?.close();
  if (daemon) {
    if (metadata) {
      try { await fetch(metadata.url + '/local/stop', { method: 'POST', headers: { Authorization: 'Bearer ' + metadata.controlToken,
        'content-type': 'application/json' }, body: '{}', signal: globalThis.AbortSignal.timeout(5000) }); } catch { /* Retain a failed smoke for inspection. */ }
    }
    const timer = setTimeout(() => daemon.kill(), 5000); await exited; clearTimeout(timer);
  }
  await writeFile('.artifacts/windows-bundle/smoke.json', JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  const inside = relative(resolve(tmpdir()), root);
  if (report.outcome === 'passed' && inside && !inside.startsWith('..') && !inside.includes(':')) await rm(root, { recursive: true, force: true });
}
