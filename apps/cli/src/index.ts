#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { open, writeFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline/promises';
import { humanCommand } from './human.js';
import { restoreHistory } from './history.js';
import { onboard, parseOnboardProducts } from './onboard.js';
import { createRuntime } from '../../daemon/src/runtime.js';
import { createServer } from '../../daemon/src/server.js';
import { createSharedServer } from '../../daemon/src/shared-server.js';
import { sharedStartOptions } from './shared.js';
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
import { PRODUCT_IDS, PRODUCT_PROFILES, isProduct } from '../../../packages/shared/src/products.js';
import { redactPublic } from '../../../packages/store/src/index.js';
import type { Product, ToolArgs, Event } from '../../../packages/shared/src/contracts.js';
interface Metadata {
  url: string;
  pid: number;
  controlToken: string;
  version: string;
  startedAt: number;
  sharedOrigin?: string;
  sharedPort?: number;
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
    products = PRODUCT_IDS;
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
  const call = async (name: string, args: ToolArgs = {}) => {
    if (!process.stdin.isTTY)
      throw new Error('Human commands require an interactive terminal. Use the paired room UI.');
    await local('/local/pair', {});
    console.log('A one-use code was printed in the terminal running converoom start.');
    const input = createInterface({ input: process.stdin, output: process.stdout });
    let code: string;
    try {
      code = (await input.question('Enter that code to authorise this command: ')).trim();
    } finally {
      input.close();
    }
    return humanCommand((await metadata()).url, code, name, args);
  };
  const config = (p: Product) => join(homedir(), ...PRODUCT_PROFILES[p].config);
  if (command === 'version') {
    console.log(VERSION);
    return;
  }
  if (command === 'help' || command === '--help') {
    console.log(
      'Converoom ' +
        VERSION +
        '\nProducts: ' + products.join(', ') +
        '\nstart [--port 0] [--data-dir PATH] [--shared-origin HTTPS_ORIGIN --shared-port PORT]\npair | status | stop\nsetup | doctor\nonboard --products codex,cursor [--no-open]\nconnect PRODUCT [--config PATH] [--remote-connection ID] | disconnect PRODUCT\nremote-connect --origin HTTPS_ORIGIN --room ID --product PRODUCT\nremote-disconnect ID | remote-enable ID --max-turns N --max-turn-ms N\nmcp --client PRODUCT\nexport ROOM_ID --output PATH | backup --output PATH\nrestore --input PATH (empty data directory only)\ncleanup --attempt ID --confirm\n\nShared access is disabled by default. Tailscale Serve setup is explicit and separate. Never expose the local control listener. Native subscription sign-in remains with vendors. No model API fallback.',
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
    const sharedOptions = sharedStartOptions(argv);
    let running: Metadata | undefined;
    if (existsSync(metaPath))
      try {
        const m = await metadata();
        const health = (await (
          await fetch(m.url + '/health', { signal: AbortSignal.timeout(1500) })
        ).json()) as ToolArgs;
        if (health.name === 'converoom' && health.pid === m.pid) {
          running = m;
        }
      } catch {
        /* Never terminate a PID from stale metadata. */
      }
    if (running) {
      if (sharedOptions && (running.sharedOrigin !== sharedOptions.origin || running.sharedPort !== sharedOptions.port))
        throw new Error('Stop the existing runtime before changing shared listener configuration.');
      console.log('Converoom running at ' + running.url);
      return;
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
      sharedServer: Awaited<ReturnType<typeof createSharedServer>>,
      closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await sharedServer?.close();
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
        onPairingCode: (code) => console.log('Browser or CLI pairing code: ' + code),
        onStop: close,
      });
      if (sharedOptions) sharedServer = await createSharedServer(runtime.core, { ...sharedOptions,
        uiDir: resolve(fileURLToPath(new URL('./ui', import.meta.url))) });
      await privateJson(metaPath, {
        url: server.url,
        pid: process.pid,
        controlToken,
        version: VERSION,
        startedAt: Date.now(),
        ...(sharedOptions ? { sharedOrigin: sharedOptions.origin, sharedPort: sharedOptions.port } : {}),
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
      if (sharedOptions) console.log('Shared listener at ' + sharedServer!.url + '\nExpected private origin: ' + sharedOptions.origin +
        '\nConfigure Tailscale Serve explicitly for this shared listener only. No Tailscale, firewall or public exposure was changed. Shared room UI: ' + sharedOptions.origin + '/shared');
      process.once('SIGINT', () => void close());
      process.once('SIGTERM', () => void close());
    } catch (e) {
      await close();
      throw e;
    }
    return;
  }
  if (command === 'pair') {
    await local('/local/pair', {});
    console.log('A new one-use pairing code was printed in the terminal running converoom start.');
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
        '\nRun doctor; sign in through your native agent client; start the runtime; connect a product; pair the browser; create and close a bounded smoke room. Agent setup: docs/AGENT_SUPPORT.md',
    );
    return;
  }
  if (command === 'onboard') {
    const selected = parseOnboardProducts(flag('--products') ?? 'codex');
    await onboard(await installStable(dataDir), dataDir, selected, !argv.includes('--no-open'));
    return;
  }
  if (command === 'connect' || command === 'disconnect') {
    const product = argv[1] as Product;
    if (!isProduct(product)) throw new Error('Choose ' + products.join(', '));
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
          : join(homedir(), ...PRODUCT_PROFILES[product].skills)),
    );
    const skill = await installSkill(skills);
    if (existsSync(clientFile)) {
      const previous = await json<{ principalId: string }>(clientFile);
      await local('/local/revoke', { principalId: previous.principalId });
    }
    await privateJson(clientFile, { ...(await local('/local/credentials', { product,
      ...(flag('--remote-connection') ? { remoteConnectionId: flag('--remote-connection') } : {}) })), skill });
    await editConfig(path, product, {
      command: process.execPath,
      args: [stable, 'mcp', '--client', product, '--data-dir', dataDir],
    });
    console.log('Connected ' + product + '. Restart its MCP connection.');
    return;
  }
  if (command === 'remote-connect') {
    const result = await call('remote_connection_prepare', { origin: flag('--origin'), remoteRoomId: flag('--room'), product: flag('--product') }) as ToolArgs;
    console.log('Open this private authorisation URL in your browser:\n' + result.authorizationUrl + '\nConnection: ' + result.connectionId);
    console.log('After approval, use connect PRODUCT --remote-connection ID. Native execution requires separate local approval.');
    return;
  }
  if (command === 'remote-disconnect' || command === 'remote-enable') {
    console.log(JSON.stringify(await call(command === 'remote-disconnect' ? 'remote_connection_disconnect' : 'remote_connection_enable', {
      connectionId: argv[1], ...(command === 'remote-enable' ? { maxTurns: Number(flag('--max-turns')), maxTurnMs: Number(flag('--max-turn-ms')) } : {}),
    }))); return;
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
    await restoreHistory(resolve(input), dataDir);
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
