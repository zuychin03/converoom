import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:net';
import type { ChildProcess } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { executable, launch } from '../../../packages/adapters/src/process.js';
import {
  recordOpenCodeInbox, recordOpenCodePost, type Attachment, type OpenCodeAction, type OpenCodeServerState, type WakeNotice, type Withdrawal,
} from '../../../packages/core/src/attachments.js';
import { ConveroomError, type Store } from '../../../packages/shared/src/contracts.js';

// FR-40: the OpenCode bridge runs its own `opencode serve` on loopback; the routes are OpenCode 2's /api surface.
export const OPENCODE_TESTED = '2.1.4';
export const supportedOpenCode = (version: string) => {
  const m = /^(\d+)\.(\d+)/.exec(version);
  return !!m && (Number(m[1]) > 2 || (Number(m[1]) === 2 && Number(m[2]) >= 1));
};
export const wakeText = (kind: WakeNotice['kind'], roomId: string) => kind === 'check'
  ? `Converoom attachment check for your seat in room ${roomId}. Call room_inbox for that room; reading it is all this check needs.`
  : `Converoom has something new for your seat in room ${roomId}. Call room_inbox for that room and handle what it returns.`;
export interface OpenCodeAccess { url: string; key: string; version: string }

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(0, '127.0.0.1', () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});
const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 300);

export function createOpenCodeServer(store: Store, dataDir: string, o: { readyMs?: number } = {}) {
  let child: ChildProcess | undefined, access: OpenCodeAccess | undefined, nonce: string | undefined;
  let starting: Promise<OpenCodeAccess> | undefined, stopping: Promise<void> | undefined, failure: string | undefined;
  let wanted = false, backoff = 1000, retry: NodeJS.Timeout | undefined;
  const enabled = () => store.get<{ enabled?: boolean }>('push_bridge', 'opencode')?.enabled === true;
  const request = async (method: string, path: string, body?: unknown) => {
    if (!access) throw new Error('The OpenCode server is not running');
    const r = await fetch(access.url + path, { method, signal: AbortSignal.timeout(10000),
      headers: { authorization: 'Basic ' + Buffer.from('opencode:' + access.key).toString('base64'),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await r.text();
    let json: unknown = text;
    try { json = text ? JSON.parse(text) : null; } catch { /* keep the text */ }
    return { status: r.status, json: json as { data?: unknown; message?: unknown; error?: { message?: unknown } } | null };
  };
  const start = async (): Promise<OpenCodeAccess> => {
    const command = await executable('opencode');
    const port = await freePort(), key = randomBytes(24).toString('base64url'), id = randomBytes(18).toString('base64url');
    const url = `http://127.0.0.1:${port}`;
    // Every process OpenCode starts, MCP servers included, inherits this environment; the nonce lets the daemon tell its own server's sessions apart.
    const proc = launch(command.command, [...command.args, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], dataDir,
      { OPENCODE_PASSWORD: key, OPENCODE_SERVER_PASSWORD: undefined, OPENCODE_DISABLE_AUTOUPDATE: '1', CONVEROOM_OPENCODE_SERVER: id });
    // npm's opencode.ps1 shim pipes a redirected stdin into opencode.exe, and Windows PowerShell starts it only once that input ends.
    proc.stdin.end();
    proc.stdout.resume();
    proc.stderr.resume();
    let exited = false;
    proc.once('exit', () => {
      exited = true;
      if (child !== proc) return;
      const ready = !!access;
      child = undefined;
      access = undefined;
      nonce = undefined;
      // A start that fails is rescheduled by ensure.
      if (ready && !stopping && wanted && enabled()) schedule();
    });
    child = proc;
    const auth = { authorization: 'Basic ' + Buffer.from('opencode:' + key).toString('base64') };
    const deadline = Date.now() + (o.readyMs ?? 30000);
    for (;;) {
      if (exited) throw new Error('OpenCode exited before its server was ready');
      try {
        if ((await fetch(url + '/api/session', { headers: auth, signal: AbortSignal.timeout(2000) })).status === 200) break;
      } catch { /* not listening yet */ }
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error('The OpenCode server did not start within ' + Math.round((o.readyMs ?? 30000) / 1000) + ' seconds');
      }
      await sleep(200);
    }
    const info = await (await fetch(url + '/api/info', { headers: auth, signal: AbortSignal.timeout(5000) })).json() as { version?: unknown };
    const version = String(info?.version ?? 'unknown');
    if (!supportedOpenCode(version)) {
      proc.kill();
      throw new Error(`OpenCode ${version} is too old for the push bridge; Converoom needs OpenCode 2.1 or later`);
    }
    access = { url, key, version };
    nonce = id;
    return access;
  };
  const schedule = () => {
    clearTimeout(retry);
    retry = setTimeout(() => { void ensure().catch(() => undefined); }, backoff);
    retry.unref();
    backoff = Math.min(backoff * 2, 60000);
  };
  const ensure = async (): Promise<OpenCodeAccess> => {
    if (!enabled()) throw new ConveroomError('push_disabled', 'Turn on the OpenCode push bridge with converoom bridge enable opencode', 409);
    wanted = true;
    if (access) return access;
    await stopping;
    return starting ??= start().then((a) => {
      failure = undefined;
      backoff = 1000;
      return a;
    }, (e: unknown) => {
      failure = message(e);
      schedule();
      throw new ConveroomError('opencode_unavailable', failure, 503);
    }).finally(() => { starting = undefined; });
  };
  const stop = () => stopping ??= (async () => {
    wanted = false;
    clearTimeout(retry);
    await starting?.catch(() => undefined);
    // A queued wake would otherwise outlive the bridge in OpenCode's shared session store.
    const pending = access ? store.list<Withdrawal>('opencode_withdrawal') : [];
    if (pending.length) {
      store.transaction(() => { for (const w of pending) store.remove('opencode_withdrawal', w.id); });
      await Promise.allSettled(pending.map((w) =>
        request('DELETE', '/api/session/' + encodeURIComponent(w.sessionId) + '/inbox/' + encodeURIComponent(w.inboxId))));
    }
    const proc = child;
    child = undefined;
    access = undefined;
    nonce = undefined;
    failure = undefined;
    if (proc && proc.exitCode === null) {
      const gone = new Promise((resolve) => proc.once('exit', resolve));
      proc.kill();
      await Promise.race([gone, sleep(5000)]);
    }
  })().finally(() => { stopping = undefined; });
  const perform = (actions: OpenCodeAction[]) => {
    for (const a of actions) void (async () => {
      const session = '/api/session/' + encodeURIComponent(a.sessionId);
      if (a.type === 'post') {
        const r = await request('POST', session + '/synthetic',
          { text: wakeText(a.kind, a.roomId), description: 'Converoom wake', metadata: { converoomWake: a.wakeId }, delivery: 'queue' });
        const inboxId = r.status === 200 ? (r.json?.data as { id?: unknown } | undefined)?.id : undefined;
        const detail = r.json?.error?.message ?? r.json?.message ?? 'no detail';
        store.transaction(() => recordOpenCodePost(store, a.seatId, a.sessionId, a.wakeId,
          typeof inboxId === 'string' ? { inboxId } : { status: r.status, message: String(detail) }));
      } else if (a.type === 'poll') {
        const r = await request('GET', session + '/inbox');
        const items = Array.isArray(r.json?.data) ? r.json.data as { id?: unknown }[] : undefined;
        if (r.status === 404) store.transaction(() => recordOpenCodeInbox(store, a.seatId, a.wakeId, 'missing'));
        else if (items) store.transaction(() => recordOpenCodeInbox(store, a.seatId, a.wakeId, items.some((i) => i.id === a.inboxId) ? 'pending' : 'gone'));
      } else await request('DELETE', session + '/inbox/' + encodeURIComponent(a.inboxId));
    })().catch(() => undefined);
  };
  return {
    ensure,
    stop,
    perform,
    // Once stopping, withdrawals wait for stop's own flush rather than racing the kill.
    state: (): OpenCodeServerState => ({ ready: !!access && !stopping, ...(failure ? { failure } : {}) }),
    status: () => ({ enabled: enabled(), running: !!access, ...(access ? { version: access.version } : {}), ...(failure ? { failure } : {}),
      tested: OPENCODE_TESTED }),
    accepts: (id: string) => !!nonce && id.length === nonce.length && timingSafeEqual(Buffer.from(id), Buffer.from(nonce)),
    // Called on every wake tick: the server stops with the bridge, and starts for attached seats that need it.
    sync() {
      if (!enabled()) {
        if (child || starting) void stop();
        return;
      }
      if (!access && !starting && !wanted && store.list<Attachment>('attachment').some((t) => t.bridge === 'opencode'))
        void ensure().catch(() => undefined);
    },
  };
}
export type OpenCodeServer = ReturnType<typeof createOpenCodeServer>;
