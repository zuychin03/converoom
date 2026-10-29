import { afterEach, beforeEach, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, issueBridgeCredential } from '../apps/daemon/src/server.js';
import { consoleStart, runtimeCaller } from '../packages/mcp/src/runtime.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'converoom-autostart-')); });
afterEach(() => rm(dir, { recursive: true, force: true }));

// Stands in for `converoom start` in its own console: the runtime is reachable only once launched.
async function installed() {
  const runtime = await createRuntime(dir, { noScheduler: true });
  const { token } = issueBridgeCredential(runtime, 'codex');
  let server: Awaited<ReturnType<typeof createServer>> | undefined, launches = 0;
  const launch = async () => {
    launches++;
    server = await createServer(runtime, { port: 0, controlToken: 'control-fixture' });
    await writeFile(join(dir, 'runtime.json'), JSON.stringify({ url: server.url, pid: process.pid, controlToken: 'control-fixture' }));
  };
  return { runtime, token, launch, launches: () => launches, stop: async () => { await server?.close(); await runtime.stop(); } };
}

it('refuses with runtime_unavailable and starts nothing when the product has not opted in', async () => {
  const f = await installed();
  try {
    const call = runtimeCaller({ dataDir: dir, client: 'codex', token: f.token });
    const refusal = { code: 'runtime_unavailable', committed: false, retrySafe: true, startCommand: 'converoom start --data-dir "' + dir + '"',
      message: expect.stringContaining('converoom connect codex --auto-start') };
    await expect(call('runtime_capabilities', {})).rejects.toMatchObject(refusal);
    const stopped = await createServer(f.runtime, { port: 0 });
    await writeFile(join(dir, 'runtime.json'), JSON.stringify({ url: stopped.url, pid: process.pid }));
    await stopped.close();
    await expect(call('runtime_capabilities', {})).rejects.toMatchObject(refusal);
    expect(f.launches()).toBe(0);
  } finally { await f.stop(); }
});

it('starts the runtime once for concurrent first calls from two bridges and forwards each call once', async () => {
  const f = await installed();
  try {
    const bridges = [0, 1].map(() => runtimeCaller({ dataDir: dir, client: 'codex', token: f.token, autoStart: { launch: f.launch } }));
    const created = await Promise.all(bridges.flatMap((call, b) => [0, 1].map((n) =>
      call('room_create', { title: `Room ${b}${n}`, objective: 'Start once', product: 'codex', clientKey: `create-${b}${n}` }))));
    expect(f.launches()).toBe(1);
    expect(created.map((c) => c.response.ok)).toEqual([true, true, true, true]);
    expect(f.runtime.core.store.list('room')).toHaveLength(4);
    expect(JSON.stringify(created.map((c) => c.value))).not.toContain('control-fixture');
    expect(existsSync(join(dir, 'autostart.lock'))).toBe(false);
  } finally { await f.stop(); }
});

it.each([['does not become ready', () => {}], ['cannot be launched', () => { throw new Error('spawn cmd.exe ENOENT'); }]])(
  'refuses with runtime_unavailable when an opted-in start %s', async (_, launch) => {
    const call = runtimeCaller({ dataDir: dir, client: 'codex', token: 'unused', autoStart: { launch, waitMs: 300 } });
    await expect(call('runtime_capabilities', {})).rejects.toMatchObject({ code: 'runtime_unavailable', committed: false, retrySafe: true,
      message: expect.stringContaining('did not start') });
    expect(existsSync(join(dir, 'autostart.lock'))).toBe(false);
  });

it('starts the installed runtime in a console of its own without shared access, and refuses arguments cmd would rewrite', () => {
  expect(consoleStart('C:\\node\\node.exe', ['--max-old-space-size=512'], 'C:\\Data dir\\runtime\\0.2.0\\dist\\cli.js', 'C:\\Data dir')).toEqual({
    file: expect.stringMatching(/cmd\.exe$/i),
    args: ['/d', '/v:off', '/s', '/c', '"start "Converoom" "C:\\node\\node.exe" "--max-old-space-size=512" ' +
      '"C:\\Data dir\\runtime\\0.2.0\\dist\\cli.js" "start" "--data-dir" "C:\\Data dir""'],
  });
  for (const dataDir of ['C:\\100%\\data', 'C:\\data\\']) expect(consoleStart('C:\\node.exe', [], 'C:\\cli.js', dataDir)).toBeUndefined();
});
