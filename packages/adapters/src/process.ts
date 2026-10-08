import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { delimiter, join, extname, relative } from 'node:path';
import { constants, existsSync } from 'node:fs';
import { dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConveroomError } from '../../shared/src/contracts.js';
import { redactPublic } from '../../store/src/index.js';
export interface ProcessResult {
  exitCode: number;
  output: string;
  durationMs: number;
  timedOut: boolean;
}
export async function executable(name: string): Promise<{ command: string; args: string[] }> {
  const candidates =
    name.includes('/') || name.includes('\\')
      ? [name]
      : (process.env.PATH ?? '')
          .split(delimiter)
          .flatMap((p) =>
            process.platform === 'win32'
              ? [
                  join(p, name + '.exe'),
                  join(p, name + '.cmd'),
                  join(p, name + '.ps1'),
                  join(p, name),
                ]
              : [join(p, name)],
          );
  for (const p of candidates)
    try {
      await access(p, constants.F_OK);
      const path = await realpath(p);
      if (process.platform === 'win32' && extname(path) === '.ps1')
        return {
          command: 'powershell.exe',
          args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path],
        };
      if (extname(path) === '.cmd') continue;
      return { command: path, args: [] };
    } catch {
      /* Try the next native entry point. */
    }
  throw new ConveroomError(
    'missing_executable',
    'Install ' + name + ' from its vendor; no compatible native executable found',
    409,
  );
}
export function launch(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv = {},
): ChildProcessWithoutNullStreams {
  let target = command,
    argv = args;
  if (process.platform === 'win32') {
    const here = dirname(fileURLToPath(import.meta.url));
    const helper = [
      resolve(here, '../../../native/bin/win32-x64/converoom-supervisor.exe'),
      resolve(here, '../native/bin/win32-x64/converoom-supervisor.exe'),
    ].find(existsSync);
    if (!helper)
      throw new ConveroomError(
        'supervisor_missing',
        'Windows supervisor prebuild missing; repair the runtime installation',
      );
    const native = isAbsolute(command)
      ? command
      : (process.env.PATH ?? '')
          .split(delimiter)
          .map((p) => join(p, command.endsWith('.exe') ? command : command + '.exe'))
          .find(existsSync);
    if (!native)
      throw new ConveroomError('missing_executable', 'Native executable not found: ' + command);
    target = helper;
    argv = ['--parent', String(process.pid), native, ...args];
  }
  return spawn(target, argv, {
    cwd,
    env: {
      ...process.env,
      ...env,
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: undefined,
      CURSOR_API_KEY: undefined,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
    detached: process.platform !== 'win32',
  });
}
export async function run(
  command: string,
  args: string[],
  cwd: string,
  timeoutMs = 30000,
  env: NodeJS.ProcessEnv = {},
): Promise<ProcessResult> {
  const at = Date.now(),
    child = launch(command, args, cwd, env);
  let output = '',
    timedOut = false;
  return new Promise((resolve, reject) => {
    const collect = (b: Buffer) => {
      output = (output + b.toString()).slice(-262144);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: code ?? -1,
        output: redactPublic(output),
        durationMs: Date.now() - at,
        timedOut,
      });
    });
  });
}
export async function canonicalRoot(path: string): Promise<string> {
  const r = await realpath(path);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
export function inside(base: string, target: string): boolean {
  const r = relative(base, target);
  return !r.startsWith('..') && !r.includes(':');
}
