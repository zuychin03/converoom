import { spawn } from 'node:child_process';
import { open, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { ConveroomError } from '../../shared/src/contracts.js';
import { localRuntime } from '../../../apps/cli/src/onboard.js';
import { dataDirectory, samePath } from '../../../apps/cli/src/support.js';

export interface AutoStart { launch: () => unknown; waitMs?: number }
type Reply = { result?: unknown; error?: { message?: string }; committed?: boolean; retrySafe?: boolean };

export class RuntimeUnavailable extends ConveroomError {
  readonly committed = false;
  readonly retrySafe = true;
  constructor(message: string, readonly startCommand: string) { super('runtime_unavailable', message, 503); }
}

// The call never left the bridge: the runtime's metadata is gone or nothing listens on its recorded port.
const unsent = (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT' || (e as { cause?: { code?: string } }).cause?.code === 'ECONNREFUSED';

export function runtimeCaller(o: { dataDir: string; client: string; token: string; autoStart?: AutoStart }) {
  const send = async (name: string, args: Record<string, unknown>) => {
    const runtime = JSON.parse(await readFile(join(o.dataDir, 'runtime.json'), 'utf8')) as { url: string };
    const response = await fetch(runtime.url + '/agent/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + o.token },
      body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(35000) });
    return { response, value: await response.json() as Reply };
  };
  const dataDir = samePath(o.dataDir, dataDirectory()) ? '' : ' --data-dir "' + o.dataDir + '"', start = 'converoom start' + dataDir;
  const unavailable = () => new RuntimeUnavailable(o.autoStart
    ? `Converoom did not start. Ask the owner to run ${start} in their own terminal to see why.`
    : `Converoom is not running. Ask the owner to run ${start} in their own terminal; do not run it yourself, because it prints a private pairing code. ` +
      `To let this agent start it next time, the owner can run converoom connect ${o.client} --auto-start${dataDir}.`, start);
  let starting: Promise<boolean> | undefined;
  return async (name: string, args: Record<string, unknown>) => {
    try { return await send(name, args); } catch (e) { if (!unsent(e)) throw e; }
    if (!o.autoStart || !await (starting ??= startRuntime(o.dataDir, o.autoStart).finally(() => { starting = undefined; }))) throw unavailable();
    try { return await send(name, args); } catch (e) { throw unsent(e) ? unavailable() : e; }
  };
}

// One bridge launches; other bridges, and its own concurrent calls, wait for the same runtime. The runtime lock still refuses a second store.
async function startRuntime(dataDir: string, { launch, waitMs = 15000 }: AutoStart): Promise<boolean> {
  if (await localRuntime(dataDir)) return true;
  const marker = join(dataDir, 'autostart.lock'), owned = await claim(marker, waitMs);
  try {
    if (owned && !await localRuntime(dataDir)) await launch();
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (await localRuntime(dataDir)) return true;
      await sleep(200);
    }
    return false;
  } catch {
    return false;
  } finally {
    if (owned) await rm(marker, { force: true });
  }
}

// A bridge that exited while launching leaves its marker; once it is older than two waits, nobody is still launching.
async function claim(marker: string, waitMs: number): Promise<boolean> {
  for (const retry of [true, false]) {
    try {
      await (await open(marker, 'wx', 0o600)).close();
      return true;
    } catch {
      const modified = (await stat(marker).catch(() => undefined))?.mtimeMs ?? Date.now();
      if (!retry || Date.now() - modified < 2 * waitMs) return false;
      await rm(marker, { force: true });
    }
  }
  return false;
}

// cmd's start builtin gives the runtime a console of its own, so its pairing code prints there and never in the agent's stdio.
export function consoleStart(node: string, nodeFlags: string[], cli: string, dataDir: string) {
  const parts = [node, ...nodeFlags, cli, 'start', '--data-dir', dataDir];
  // cmd expands % even inside quotes, and a trailing backslash would escape the closing quote.
  if (parts.some((p) => /["%\r\n]|\\$/.test(p))) return undefined;
  return { file: process.env.ComSpec ?? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/v:off', '/s', '/c', '"start "Converoom" ' + parts.map((p) => '"' + p + '"').join(' ') + '"'] };
}

export const launchConsole = (cli: string, dataDir: string) => () => {
  const start = consoleStart(process.execPath, process.execArgv, cli, dataDir);
  if (!start) throw new Error('The runtime path cannot be passed to cmd');
  return new Promise<void>((resolve, reject) => {
    const child = spawn(start.file, start.args, { detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
    child.once('error', reject);
    child.once('spawn', () => { child.unref(); resolve(); });
  });
};
