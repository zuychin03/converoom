#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { open, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createRuntime } from '../../daemon/src/runtime.js';
import { createServer } from '../../daemon/src/server.js';
import { serveMcp } from '../../../packages/mcp/src/index.js';
import {
  dataDirectory,
  privateDirectory,
  privateJson,
  json,
  secret,
  installStable,
  editConfig,
  installSkill,
  removeSkill,
  VERSION,
} from './support.js';
import { probeProduct } from '../../../packages/adapters/src/index.js';
import { scopeDigest, redactPublic } from '../../../packages/store/src/index.js';
import type { Product, ToolArgs, Event } from '../../../packages/shared/src/contracts.js';
interface Metadata {
  url: string;
  pid: number;
  controlToken: string;
  version: string;
  startedAt: number;
}
export async function main(argv = process.argv.slice(2)): Promise<void> {
  const command = argv[0] ?? 'help',
    flag = (n: string) => {
      const i = argv.indexOf(n);
      return i >= 0 ? argv[i + 1] : undefined;
    };
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new Error(
      'Converoom preview requires Node 24.14 or later within Node 24. Install Node 24 LTS.',
    );
  if (process.platform !== 'win32' || process.arch !== 'x64')
    throw new Error(
      'This preview is accepted only for Windows x64. Other platforms remain unverified.',
    );
  const dataDir = resolve(flag('--data-dir') ?? dataDirectory());
  await privateDirectory(dataDir);
  const metaPath = join(dataDir, 'runtime.json'),
    products = ['codex', 'cursor', 'claude', 'opencode'] as const;
  const metadata = () => json<Metadata>(metaPath);
  const local = async (path: string, body?: unknown) => {
    const m = await metadata();
    const r = await fetch(m.url + path, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + m.controlToken, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(35000),
    });
    const v = (await r.json()) as ToolArgs;
    if (!r.ok)
      throw new Error(String((v.error as ToolArgs)?.message ?? 'Runtime operation failed'));
    return v;
  };
  const call = async (name: string, args: ToolArgs = {}) =>
    (await local('/local/commands', { name, args: { ...args, clientKey: crypto.randomUUID() } }))
      .result;
  const config = (p: string) =>
    p === 'codex'
      ? join(homedir(), '.codex', 'config.toml')
      : p === 'claude'
        ? join(homedir(), '.claude.json')
        : p === 'cursor'
          ? join(homedir(), '.cursor', 'mcp.json')
          : join(homedir(), '.config', 'opencode', 'opencode.json');
  if (command === 'version') {
    console.log(VERSION);
    return;
  }
  if (command === 'help' || command === '--help') {
    console.log(
      'Converoom ' +
        VERSION +
        '\nstart [--port 0] [--data-dir PATH]\npair | status | stop\nsetup | doctor\nconnect PRODUCT [--config PATH] | disconnect PRODUCT\nmcp --client PRODUCT\nexport ROOM_ID --output PATH | backup --output PATH\nrestore --input PATH (empty data directory only)\ncleanup --attempt ID --confirm\n\nNative subscription sign-in remains with vendors. No model API fallback.',
    );
    return;
  }
  if (command === 'mcp') {
    await serveMcp(dataDir, flag('--client') ?? 'codex', flag('--credential-file'));
    return;
  }
  if (command === 'doctor') {
    console.log(
      JSON.stringify(
        {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
          dataDir,
          credentialStorage: 'degraded user files, not an OS keystore',
          products: await Promise.all(products.map((p) => probeProduct(p, dataDir))),
          smoke: 'Approve a bounded managed turn in the room UI; doctor never starts inference',
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'start') {
    if (existsSync(metaPath))
      try {
        const m = await metadata();
        const health = (await (
          await fetch(m.url + '/health', { signal: AbortSignal.timeout(1500) })
        ).json()) as ToolArgs;
        if (health.name === 'converoom' && health.pid === m.pid) {
          console.log('Converoom running at ' + m.url);
          return;
        }
      } catch {
        /* Never terminate a PID from stale metadata. */
      }
    const lockPath = join(dataDir, 'runtime.lock');
    if (existsSync(lockPath)) {
      const previous = await json<{ pid: number }>(lockPath).catch(() => undefined);
      if (previous && Number.isInteger(previous.pid) && previous.pid > 0) {
        let dead = false;
        try {
          process.kill(previous.pid, 0);
        } catch (e) {
          dead = (e as NodeJS.ErrnoException).code === 'ESRCH';
        }
        if (dead) await unlink(lockPath);
      }
    }
    const lock = await open(lockPath, 'wx', 0o600).catch(() => {
      throw new Error(
        'An active or unidentifiable runtime lock exists. No process was killed. Inspect: ' +
          lockPath,
      );
    });
    const runtime = await createRuntime(dataDir).catch(async (e) => {
        await lock.close();
        await unlink(lockPath).catch(() => {});
        throw e;
      }),
      controlToken = secret(),
      pairingCode = secret().slice(0, 12);
    let server: Awaited<ReturnType<typeof createServer>> | undefined,
      closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await server?.close();
      await runtime.stop();
      await lock.close();
      await unlink(lockPath).catch(() => {});
      await unlink(metaPath).catch(() => {});
    };
    try {
      server = await createServer(runtime, {
        port: Number(flag('--port') ?? 0),
        pairingCode,
        controlToken,
        onStop: close,
      });
      await privateJson(metaPath, {
        url: server.url,
        pid: process.pid,
        controlToken,
        version: VERSION,
        startedAt: Date.now(),
      });
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      console.log(
        'Converoom ' +
          VERSION +
          ' at ' +
          server.url +
          '\nBrowser pairing code: ' +
          pairingCode +
          '\nCredential storage: user files, OS keystore unavailable.\nCtrl+C stops the runtime.',
      );
      process.once('SIGINT', () => void close());
      process.once('SIGTERM', () => void close());
    } catch (e) {
      await close();
      throw e;
    }
    return;
  }
  if (command === 'pair') {
    console.log('Browser pairing code: ' + (await local('/local/pair', {})).code);
    return;
  }
  if (command === 'status') {
    const m = await metadata();
    console.log(
      JSON.stringify(
        {
          url: m.url,
          ...((await (
            await fetch(m.url + '/health', { signal: AbortSignal.timeout(1500) })
          ).json()) as ToolArgs),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'stop') {
    await local('/local/stop', {});
    console.log('Runtime stop requested.');
    return;
  }
  if (command === 'setup') {
    console.log(
      'Installed stable runtime: ' +
        (await installStable(dataDir)) +
        '\nRun doctor; sign in with codex login or agent login; start the runtime; connect a product; pair the browser; create and close a bounded smoke room.',
    );
    return;
  }
  if (command === 'connect' || command === 'disconnect') {
    const product = argv[1] as Product;
    if (!products.includes(product)) throw new Error('Choose codex, cursor, claude or opencode');
    const path = resolve(flag('--config') ?? config(product)),
      clientFile = join(dataDir, 'clients', product + '.json');
    if (command === 'disconnect') {
      if (existsSync(clientFile)) {
        await local('/local/revoke', {
          principalId: (await json<{ principalId: string }>(clientFile)).principalId,
        });
        const saved = await json<{ skill?: { path: string; digest: string } }>(clientFile);
        if (saved.skill) await removeSkill(saved.skill);
        await unlink(clientFile);
      }
      await editConfig(path, product, {}, true);
      console.log('Removed only Converoom registration for ' + product);
      return;
    }
    const stable = await installStable(dataDir);
    const skills = resolve(
      flag('--skills-dir') ??
        (flag('--config')
          ? join(resolve(path, '..'), 'skills', 'converoom-room')
          : join(
              homedir(),
              product === 'opencode' ? '.config/opencode' : '.' + product,
              'skills',
              'converoom-room',
            )),
    );
    const skill = await installSkill(skills);
    if (existsSync(clientFile)) {
      const previous = await json<{ principalId: string }>(clientFile);
      await local('/local/revoke', { principalId: previous.principalId });
    }
    await privateJson(clientFile, { ...(await local('/local/credentials', { product })), skill });
    await editConfig(path, product, {
      command: process.execPath,
      args: [stable, 'mcp', '--client', product, '--data-dir', dataDir],
    });
    console.log('Connected ' + product + '. Restart its MCP connection.');
    return;
  }
  if (command === 'export') {
    if (!argv[1]) throw new Error('Room ID required');
    const output = resolve(flag('--output') ?? 'converoom-' + argv[1] + '.json');
    const exported = (await call('room_export', { roomId: argv[1] })) as {
      records: unknown[];
      events: Event[];
    };
    const text = output.endsWith('.md')
      ? '# Converoom room history\n\n' +
        exported.events
          .map(
            (e) =>
              '## ' +
              e.seq +
              ' ' +
              e.type +
              '\n\n```json\n' +
              JSON.stringify(e.data, null, 2) +
              '\n```',
          )
          .join('\n\n') +
        '\n'
      : JSON.stringify(exported, null, 2) + '\n';
    await writeFile(output, text, { mode: 0o600 });
    console.log('Export: ' + output);
    return;
  }
  if (command === 'backup') {
    const output = resolve(flag('--output') ?? join(dataDir, 'backup-' + Date.now()));
    await call('backup_request', { path: output });
    console.log('Backup: ' + output);
    return;
  }
  if (command === 'restore') {
    const input = flag('--input');
    if (!input || existsSync(join(dataDir, 'converoom.sqlite')))
      throw new Error('Restore requires --input and an empty data directory');
    const e = await json<{
      schemaVersion: number;
      digest: string;
      records: { kind: string; id: string; value: ToolArgs }[];
      events: Event[];
    }>(resolve(input));
    if (
      e.schemaVersion !== 2 ||
      !Array.isArray(e.events) ||
      e.events.length > 50000 ||
      scopeDigest({ records: e.records, events: e.events }) !== e.digest ||
      e.records.some(
        (r) =>
          ![
            'room',
            'seat',
            'interaction',
            'turn',
            'policy',
            'permission',
            'manifest',
            'verification',
            'review',
            'candidate',
            'task',
          ].includes(r.kind),
      )
    )
      throw new Error('Export digest/schema invalid');
    const runtime = await createRuntime(dataDir, { noScheduler: true });
    for (const r of e.records) {
      const v = { ...r.value };
      for (const k of ['path', 'dataPath', 'basePath', 'workspace', 'foundationPath']) delete v[k];
      if (r.kind === 'turn') v.status = 'uncertain';
      if (r.kind === 'room') v.status = 'closed';
      if (r.kind === 'seat') {
        v.consent = false;
        v.status = 'left';
      }
      if (r.kind === 'permission') v.status = 'denied';
      runtime.core.store.put(r.kind, r.id, v);
    }
    runtime.core.store.importEvents(e.events);
    const owners = [
      ...new Set(e.records.filter((r) => r.kind === 'room').map((r) => r.value.ownerId)),
    ];
    if (owners.length !== 1) throw new Error('History requires exactly one local owner');
    runtime.core.store.put('identity', 'human', {
      kind: 'human',
      principalId: owners[0],
      ownerId: owners[0],
    });
    await runtime.stop();
    console.log('Read-only history restored. Re-register local execution resources.');
    return;
  }
  if (command === 'cleanup') {
    console.log(
      JSON.stringify(
        await call('workspace_cleanup', {
          attemptId: flag('--attempt'),
          confirm: argv.includes('--confirm'),
        }),
      ),
    );
    return;
  }
  throw new Error('Unknown command. Run converoom help.');
}
const entry = process.argv[1] && resolve(process.argv[1]);
if (entry === fileURLToPath(import.meta.url) || entry?.endsWith('cli.js'))
  void main().catch((e) => {
    console.error(redactPublic(e instanceof Error ? e.message : 'Converoom failed'));
    process.exitCode = 1;
  });
