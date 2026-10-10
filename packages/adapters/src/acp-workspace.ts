import * as acp from '@agentclientprotocol/sdk';
import { open, mkdir, realpath, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { canonicalRoot, inside, executable, launch } from './process.js';
import { ConveroomError, type ToolArgs } from '../../shared/src/contracts.js';

interface Terminal {
  child: ChildProcessWithoutNullStreams;
  output: string;
  truncated: boolean;
  exitStatus?: acp.TerminalExitStatus;
  exited: Promise<acp.TerminalExitStatus>;
}

export async function mountAcpWorkspace(
  client: acp.ClientApp, cwd: string, enabled: boolean,
  authorize: (sessionId: string, scope?: ToolArgs) => Promise<void>,
  env: NodeJS.ProcessEnv,
) {
  const root = await canonicalRoot(cwd), terminals = new Map<string, Terminal>();
  async function pathWithin(path: string, create = false): Promise<string> {
    if (!isAbsolute(path)) throw new ConveroomError('workspace_scope', 'An absolute workspace path is required');
    let candidate = resolve(path);
    const missing: string[] = [];
    while (true) {
      try {
        const actual = await realpath(candidate);
        const target = resolve(actual, ...missing);
        const compared = process.platform === 'win32' ? target.toLowerCase() : target;
        if (!inside(root, compared)) throw new ConveroomError('workspace_scope', 'Client request is outside the assigned workspace');
        return target;
      } catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(candidate) === candidate) throw error;
        missing.unshift(basename(candidate)); candidate = dirname(candidate);
      }
    }
  }
  async function check(sessionId: string, scope?: ToolArgs) {
    if (!enabled) throw new ConveroomError('client_capability', 'Workspace client tools are disabled for discussion');
    await authorize(sessionId, scope);
  }
  async function terminal(sessionId: string, terminalId: string) {
    await check(sessionId);
    const item = terminals.get(terminalId);
    if (!item) throw new ConveroomError('terminal_missing', 'Unknown owned terminal');
    return item;
  }
  async function stopTerminal(item: Terminal): Promise<boolean> {
    if (item.exitStatus) return true;
    item.child.kill();
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([item.exited.then(() => true), new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  const stop = async () => {
    const results = await Promise.all([...terminals].map(async ([id, item]) => {
      const confirmed = await stopTerminal(item);
      if (confirmed) terminals.delete(id);
      return confirmed;
    }));
    return results.every(Boolean);
  };
  client.onRequest(acp.methods.client.fs.readTextFile, async ({ params: p }) => {
    await check(p.sessionId);
    const path = await pathWithin(p.path);
    if ((p.line != null && (!Number.isSafeInteger(p.line) || p.line < 1)) ||
      (p.limit != null && (!Number.isSafeInteger(p.limit) || p.limit < 1)))
      throw new ConveroomError('file_range', 'Positive line and limit values are required');
    await check(p.sessionId, { method: 'fs/read_text_file', path: p.path, line: p.line, limit: p.limit });
    await pathWithin(p.path);
    const file = await open(path, 'r');
    let content: string;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1048576) throw new ConveroomError('file_limit', 'Client text files are limited to 1 MiB');
      const buffer = Buffer.alloc(1048577);
      let size = 0;
      while (size < buffer.length) {
        const read = await file.read(buffer, size, buffer.length - size, size);
        if (!read.bytesRead) break;
        size += read.bytesRead;
      }
      if (size > 1048576) throw new ConveroomError('file_limit', 'Client text files are limited to 1 MiB');
      content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
      if (content.includes('\0')) throw new ConveroomError('file_encoding', 'Client file reads require UTF-8 text');
    } finally { await file.close(); }
    await check(p.sessionId);
    if (p.line != null || p.limit != null) content = content.split('\n').slice((p.line ?? 1) - 1, p.limit == null ? undefined : (p.line ?? 1) - 1 + p.limit).join('\n');
    return { content };
  });
  client.onRequest(acp.methods.client.fs.writeTextFile, async ({ params: p }) => {
    await check(p.sessionId);
    const bytes = Buffer.byteLength(p.content, 'utf8');
    if (bytes > 1048576) throw new ConveroomError('file_limit', 'Client text files are limited to 1 MiB');
    await pathWithin(p.path, true);
    await check(p.sessionId, { method: 'fs/write_text_file', path: p.path, bytes,
      contentDigest: createHash('sha256').update(p.content).digest('hex') });
    const path = await pathWithin(p.path, true);
    await mkdir(dirname(path), { recursive: true });
    await check(p.sessionId);
    await writeFile(path, p.content, 'utf8');
    return {};
  });
  client.onRequest(acp.methods.client.terminal.create, async ({ params: p }) => {
    await check(p.sessionId);
    if (terminals.size >= 4) throw new ConveroomError('terminal_limit', 'At most four owned terminals may be open');
    const directory = await pathWithin(p.cwd ?? cwd);
    const limit = p.outputByteLimit ?? 262144;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1048576 || (p.args?.length ?? 0) > 256 || (p.env?.length ?? 0) > 128)
      throw new ConveroomError('terminal_limit', 'Terminal arguments, environment and output must be bounded');
    const entry = await executable(p.command), args = [...entry.args, ...p.args ?? []];
    await check(p.sessionId, { method: 'terminal/create', command: entry.command, args, cwd: directory, env: p.env ?? [] });
    await pathWithin(p.cwd ?? cwd);
    await check(p.sessionId);
    if (terminals.size >= 4) throw new ConveroomError('terminal_limit', 'At most four owned terminals may be open');
    const child = launch(entry.command, args, directory, { ...Object.fromEntries((p.env ?? []).map((e) => [e.name, e.value])), ...env });
    let finish!: (status: acp.TerminalExitStatus) => void;
    const item: Terminal = { child, output: '', truncated: false, exited: new Promise((resolve) => { finish = resolve; }) };
    const collect = (text: string) => {
      const bytes = Buffer.from(item.output + text, 'utf8');
      if (bytes.length > limit) {
        item.truncated = true;
        let start = bytes.length - limit;
        while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
        item.output = bytes.subarray(start).toString('utf8');
      } else item.output = bytes.toString('utf8');
    };
    const stdout = new StringDecoder('utf8'), stderr = new StringDecoder('utf8');
    child.stdout.on('data', (bytes: Buffer) => collect(stdout.write(bytes)));
    child.stderr.on('data', (bytes: Buffer) => collect(stderr.write(bytes)));
    const timeout = setTimeout(() => child.kill(), 300000);
    child.once('error', () => { item.exitStatus = { exitCode: -1 }; finish(item.exitStatus); clearTimeout(timeout); });
    child.once('close', (exitCode, signal) => {
      collect(stdout.end()); collect(stderr.end()); clearTimeout(timeout);
      item.exitStatus = { exitCode, signal }; finish(item.exitStatus);
    });
    const terminalId = randomUUID(); terminals.set(terminalId, item);
    return { terminalId };
  });
  client.onRequest(acp.methods.client.terminal.output, async ({ params: p }) => {
    const item = await terminal(p.sessionId, p.terminalId);
    return { output: item.output, truncated: item.truncated, ...(item.exitStatus ? { exitStatus: item.exitStatus } : {}) };
  });
  client.onRequest(acp.methods.client.terminal.waitForExit, async ({ params: p }) => (await terminal(p.sessionId, p.terminalId)).exited);
  client.onRequest(acp.methods.client.terminal.kill, async ({ params: p }) => {
    if (!await stopTerminal(await terminal(p.sessionId, p.terminalId))) throw new ConveroomError('stop_uncertain', 'Terminal shutdown was not confirmed');
    return {};
  });
  client.onRequest(acp.methods.client.terminal.release, async ({ params: p }) => {
    if (!await stopTerminal(await terminal(p.sessionId, p.terminalId))) throw new ConveroomError('stop_uncertain', 'Terminal shutdown was not confirmed');
    terminals.delete(p.terminalId); return {};
  });
  return { stop, capabilities: enabled ? { fs: { readTextFile: true, writeTextFile: true }, terminal: true } : {} };
}
