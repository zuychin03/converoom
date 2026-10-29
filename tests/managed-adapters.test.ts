import { it, expect, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Actor, ToolArgs, Turn, Seat } from '../packages/shared/src/contracts.js';
vi.mock('../packages/adapters/src/process.js', async (original) => ({
  ...await original<typeof import('../packages/adapters/src/process.js')>(),
  executable: async (name: string) => name === process.execPath ? { command: name, args: [] } : ({ command: process.execPath,
    args: [join(process.cwd(), 'tests', 'fixtures', 'managed-vendor.mjs'),
      ({ agent: 'cursor', 'kiro-cli': 'kiro', agy_acp_server: 'antigravity', agy: 'antigravity' } as Record<string, string>)[name] ?? name] }),
}));
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer } from '../apps/daemon/src/server.js';
import { authCheck, startManaged } from '../packages/adapters/src/index.js';
const acpProducts = ['cursor', 'antigravity', 'kiro', 'qoder', 'grok'] as const;
it('reports which managed adapters verify the native sign-in before inference', () => {
  expect(authCheck('codex')).toContain('ChatGPT sign-in');
  expect(authCheck('grok')).toContain('cached native token');
  expect(authCheck('antigravity')).toContain('personal Google OAuth');
  expect(authCheck('cursor')).toContain('cursor_login');
  expect(authCheck('kiro')).toContain('--auth-method=cli');
  expect(authCheck('qoder')).toMatch(/^Not verified by Converoom/);
  for (const product of ['claude', 'opencode'] as const) expect(authCheck(product)).toMatch(/^Not applicable/);
});
it.each(acpProducts)('publishes only public output belonging to the %s session', async (product) => {
  const session = await startManaged(product, process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'public' });
  try { expect(await session.prompt('Public response')).toBe('Public protocol fixture answer'); }
  finally { expect(await session.close()).toBe(true); }
});
it.each(acpProducts)('round-trips one-time approvals and denials for %s', async (product) => {
  for (const allowed of [true, false]) {
    let received: ToolArgs | undefined;
    const session = await startManaged(product, process.cwd(), async (scope) => { received = scope; return allowed; },
      { CONVEROOM_VENDOR_FIXTURE: 'permission' });
    try {
      expect(await session.prompt('Request one check')).toBe(allowed ? 'Permission allowed' : 'Permission denied');
      expect(received?.toolCall).toMatchObject({ toolCallId: 'tool-1' });
      if (product === 'kiro') expect(received?._meta).toMatchObject({ kiro: { consent: { capability: 'shell' } } });
    } finally { expect(await session.close()).toBe(true); }
  }
});
it.each(['codex', ...acpProducts] as const)('settles %s cancellation from the native prompt response', async (product) => {
  const session = await startManaged(product, process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'cancel' });
  try {
    const prompt = session.prompt('Wait');
    const rejected = expect(prompt).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.cancel(); await rejected;
  } finally { expect(await session.close()).toBe(true); }
});
it.each(acpProducts)('surfaces %s quota failure without another provider attempt', async (product) => {
  const session = await startManaged(product, process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'quota' });
  try { await expect(session.prompt('Respond')).rejects.toThrow(/quota/i); }
  finally { expect(await session.close()).toBe(true); }
});
it('marks a Codex turn the vendor refuses to start as never started, but not one lost after starting', async () => {
  const refused = await startManaged('codex', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'quota' });
  try { await expect(refused.prompt('Respond')).rejects.toMatchObject({ message: expect.stringMatching(/quota/i), notStarted: true }); }
  finally { expect(await refused.close()).toBe(true); }
  const dropped = await startManaged('codex', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'drop' });
  try { expect((await dropped.prompt('Respond').catch((error: unknown) => error) as { notStarted?: boolean }).notStarted).toBeUndefined(); }
  finally { await dropped.close(); }
});
it.each([[-32000, true], [-32602, true], [-32603, false]])('marks an ACP prompt rejected with %i as never started: %s', async (code, unstarted) => {
  const session = await startManaged('qoder', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'prompt-error:' + code });
  try { expect((await session.prompt('Respond').catch((error: unknown) => error) as { notStarted?: boolean }).notStarted === true).toBe(unstarted); }
  finally { expect(await session.close()).toBe(true); }
});
it('treats an ACP prompt aborted with -32800 as a confirmed cancellation', async () => {
  const session = await startManaged('kiro', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'prompt-error:-32800' });
  try { await expect(session.prompt('Respond')).rejects.toMatchObject({ code: 'cancelled' }); }
  finally { expect(await session.close()).toBe(true); }
});
it.each(acpProducts)('refuses incompatible %s protocol versions', async (product) => {
  await expect(startManaged(product, process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'wrong-protocol' }))
    .rejects.toMatchObject({ code: 'protocol_version' });
});
it.each(['grok', 'cursor'] as const)('refuses %s API-only authentication before creating a session', async (product) => {
  await expect(startManaged(product, process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'api-only' }))
    .rejects.toMatchObject({ code: 'subscription_required' });
});
it.each(acpProducts)('surfaces missing %s native login without another provider attempt', async (product) => {
  await expect(startManaged(product, process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'auth-required' }))
    .rejects.toThrow(/authentication/i);
});
it('requires an absolute Antigravity ACP override', async () => {
  await expect(startManaged('antigravity', process.cwd(), async () => false, { CONVEROOM_ANTIGRAVITY_ACP: 'relative.exe' }))
    .rejects.toMatchObject({ code: 'invalid_executable' });
});
it('refuses overlapping prompts on one ACP session', async () => {
  const session = await startManaged('kiro', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'cancel' });
  try {
    const pending = expect(session.prompt('Wait')).rejects.toMatchObject({ code: 'cancelled' });
    await expect(session.prompt('Overlap')).rejects.toMatchObject({ code: 'session_busy' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.cancel(); await pending;
  } finally { expect(await session.close()).toBe(true); }
});
it('stops an ACP process that exceeds the public-output limit', async () => {
  const session = await startManaged('qoder', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'output-limit' });
  try { await expect(session.prompt('Bounded output')).rejects.toThrow(/1 MiB/); }
  finally { expect(await session.close()).toBe(true); }
});
it.each(acpProducts)('provides approved workspace files and supervised terminals to coding %s', async (product) => {
  const cwd = await mkdtemp(join(tmpdir(), 'converoom-client-tools-'));
  const permissions: ToolArgs[] = [];
  const session = await startManaged(product, cwd, async (scope) => { permissions.push(scope); return true; },
    { CONVEROOM_VENDOR_FIXTURE: 'client-tools' }, false);
  try {
    expect(await session.prompt('Use assigned workspace')).toBe('Approved content|literal $() "quoted" trailing\\');
    expect(await readFile(join(cwd, 'approved.txt'), 'utf8')).toBe('Approved content');
    expect(permissions.map((p) => p.method)).toEqual(['fs/write_text_file', 'fs/read_text_file', 'terminal/create']);
  } finally { await session.close(); await rm(cwd, { recursive: true, force: true }); }
});
it.each(acpProducts)('preserves allocated resources in %s client terminals', async (product) => {
  const cwd = await mkdtemp(join(tmpdir(), 'converoom-terminal-resources-'));
  const allocated = { TEMP: join(cwd, 'temp'), TMP: join(cwd, 'temp'), TMPDIR: join(cwd, 'temp'),
    CONVEROOM_BUILD_DIR: join(cwd, 'build'), CONVEROOM_TEST_DATA: join(cwd, 'test-data'), CONVEROOM_FIXTURE_SAMPLE: 'allocated fixture' };
  const session = await startManaged(product, cwd, async () => true,
    { CONVEROOM_VENDOR_FIXTURE: 'terminal-resources', ...allocated }, false);
  try { expect(JSON.parse(await session.prompt('Check allocated terminal resources'))).toEqual({ ...allocated, CLIENT_SETTING: 'approved' }); }
  finally { await session.close(); await rm(cwd, { recursive: true, force: true }); }
});
it.each(['foreign-file', 'outside-file', 'outside-terminal'])('refuses %s client requests before asking for permission', async (scenario) => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-client-scope-')), cwd = join(root, 'assigned');
  await mkdir(cwd); await writeFile(join(root, 'outside.txt'), 'Private outside content');
  const permission = vi.fn(async () => true);
  const session = await startManaged('qoder', cwd, permission, { CONVEROOM_VENDOR_FIXTURE: scenario }, false);
  try { expect(await session.prompt('Check scope')).toBe('Client request denied'); expect(permission).not.toHaveBeenCalled(); }
  finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});
it('withholds filesystem and terminal callbacks from discussion sessions', async () => {
  const permission = vi.fn(async () => true);
  const session = await startManaged('qoder', process.cwd(), permission, { CONVEROOM_VENDOR_FIXTURE: 'discussion-tools' });
  try { expect(await session.prompt('Discuss only')).toBe('Client request denied'); expect(permission).not.toHaveBeenCalled(); }
  finally { await session.close(); }
});
it('denies file writes without changing the assigned workspace', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'converoom-client-denial-'));
  const session = await startManaged('qoder', cwd, async () => false, { CONVEROOM_VENDOR_FIXTURE: 'denied-write' }, false);
  try {
    expect(await session.prompt('Request a write')).toBe('Client request denied');
    await expect(readFile(join(cwd, 'approved.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await session.close(); await rm(cwd, { recursive: true, force: true }); }
});
it('refuses client reads through a junction outside the assigned workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-client-link-')), cwd = join(root, 'assigned');
  const outside = join(root, 'outside');
  await mkdir(cwd); await mkdir(outside); await writeFile(join(outside, 'approved.txt'), 'Private outside content');
  await symlink(outside, join(cwd, 'escape'), 'junction');
  const permission = vi.fn(async () => true);
  const session = await startManaged('qoder', cwd, permission, { CONVEROOM_VENDOR_FIXTURE: 'symlink-file' }, false);
  try { expect(await session.prompt('Check link')).toBe('Client request denied'); expect(permission).not.toHaveBeenCalled(); }
  finally { await session.close(); await rm(root, { recursive: true, force: true }); }
});
it('bounds terminal output at UTF-8 character boundaries', async () => {
  const session = await startManaged('qoder', process.cwd(), async () => true, { CONVEROOM_VENDOR_FIXTURE: 'terminal-output' }, false);
  try { expect(await session.prompt('Bound terminal output')).toBe('c中abc|truncated'); }
  finally { expect(await session.close()).toBe(true); }
});
it('cancels owned terminal descendants before confirming the session stop', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'converoom-client-cancel-'));
  const session = await startManaged('qoder', cwd, async () => true, { CONVEROOM_VENDOR_FIXTURE: 'live-terminal' }, false);
  try {
    const pending = expect(session.prompt('Wait for cancellation')).rejects.toMatchObject({ code: 'cancelled' });
    let pid = 0;
    await expect.poll(async () => { try { pid = Number(await readFile(join(cwd, 'descendant'), 'utf8')); return pid > 0; } catch { return false; } }).toBe(true);
    await session.cancel(); await pending;
    await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
  } finally { await session.close(); await rm(cwd, { recursive: true, force: true }); }
});

it.each(['codex', 'cursor', 'antigravity', 'kiro', 'qoder', 'grok'])('injects the scoped MCP bridge through the %s native wire format', async (product) => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-protocol-'));
  const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
  const runtime = await createRuntime(dir, { tickMs: 10 });
  const server = await createServer(runtime, { port: 0 });
  const call = (name: string, args: ToolArgs) => runtime.core.dispatch(owner, name, args) as Promise<ToolArgs>;
  try {
    await writeFile(join(dir, 'runtime.json'), JSON.stringify({ url: server.url }));
    const room = await call('room_create', { title: 'Native wire fixture', objective: 'Check room tools' });
    const seat = await call('seat_add', { roomId: room.id, product, mode: 'managed', name: 'Fixture' });
    await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
    const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Post with Converoom MCP' });
    await call('permission_grant', { requestId: turn.permissionRequestId });
    await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status, { timeout: 15000 }).toBe('completed');
    await expect.poll(() => runtime.core.store.list('bridge').length).toBe(0);
    const events = runtime.core.store.events(String(room.id));
    expect(JSON.stringify(events)).toContain(product + ' protocol fixture MCP message');
    expect(runtime.core.store.get<Seat>('seat', String(seat.id))?.capabilities.probed).not.toContain('room-mcp');
    expect(events.find((event) => event.type === 'turn.started')?.data.mcpInjected).toBe(true);
  } finally {
    await server.close(); await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

const vendorLog = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-profile-log-')), path = join(dir, 'vendor.log');
  const read = async () => (await readFile(path, 'utf8').catch(() => '')).split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as { method: string; params: ToolArgs });
  return { path, read, remove: () => rm(dir, { recursive: true, force: true }) };
};
it('checks a Codex model and effort against model/list and starts the thread and turn with them', async () => {
  const log = await vendorLog();
  const session = await startManaged('codex', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'profile', CONVEROOM_VENDOR_LOG: log.path },
    true, undefined, { model: 'gpt-fixture', effort: 'max' });
  try {
    expect(session.profile).toEqual({ model: 'gpt-fixture', effort: 'xhigh' });
    expect(await session.prompt('Answer')).toBe('Public protocol fixture answer');
    const calls = await log.read();
    expect(calls.find((c) => c.method === 'thread/start')?.params.model).toBe('gpt-fixture');
    expect(calls.find((c) => c.method === 'turn/start')?.params.effort).toBe('xhigh');
  } finally { expect(await session.close()).toBe(true); await log.remove(); }
});
// A named model is checked before any thread starts; an effort alone is checked against the model the thread reports, before any turn.
it.each([
  [{ model: 'gpt-fixture', effort: 'low' }, /gpt-fixture does not offer low effort\. It offers: minimal, medium, high, xhigh/, 'model/list'],
  [{ model: 'gpt-missing' }, /Codex does not offer the model gpt-missing\. It offers: gpt-fixture/, 'model/list'],
  [{ effort: 'low' }, /gpt-fixture does not offer low effort/, 'thread/start'],
] as const)('refuses an unsupported Codex profile %j before the prompt', async (profile, message, last) => {
  const log = await vendorLog();
  try {
    await expect(startManaged('codex', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'profile', CONVEROOM_VENDOR_LOG: log.path },
      true, undefined, profile)).rejects.toMatchObject({ code: 'profile_unsupported', message: expect.stringMatching(message), notStarted: true, stopped: true });
    expect((await log.read()).map((c) => c.method).at(-1)).toBe(last);
  } finally { await log.remove(); }
});
it('refuses a Codex thread that started on another model instead of the one asked for', async () => {
  await expect(startManaged('codex', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'other-model' }, true, undefined, { model: 'gpt-fixture' }))
    .rejects.toMatchObject({ code: 'profile_unsupported', message: expect.stringMatching(/started gpt-other instead of gpt-fixture/), stopped: true });
});
it('reports that Codex stopped when it refuses a signed-out account', async () => {
  await expect(startManaged('codex', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'signed-out' }))
    .rejects.toMatchObject({ code: 'subscription_required', stopped: true });
});
it.each(acpProducts)('sets the %s model and effort through ACP session config options before the prompt', async (product) => {
  const log = await vendorLog();
  const session = await startManaged(product, process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: 'public', CONVEROOM_VENDOR_LOG: log.path },
    true, undefined, { model: 'fixture-deep', effort: 'max' });
  try {
    expect(session.profile).toEqual({ model: 'fixture-deep', effort: 'high' });
    expect(await session.prompt('Answer')).toBe('Public protocol fixture answer');
    const methods = (await log.read()).map((c) => c.method + (c.params?.configId ? ':' + String(c.params.configId) + '=' + String(c.params.value) : ''));
    expect(methods.slice(methods.indexOf('session/new') + 1).filter((m) => m !== 'session/set_mode'))
      .toEqual(['session/set_config_option:model=fixture-deep', 'session/set_config_option:thought=high', 'session/prompt']);
  } finally { expect(await session.close()).toBe(true); await log.remove(); }
});
it.each([
  ['no-config', { effort: 'high' }, /Qoder offers no effort choice to Converoom/],
  ['public', { model: 'fixture-huge' }, /Qoder does not offer the model fixture-huge\. It offers: fixture-fast, fixture-deep/],
  ['config-ignored', { effort: 'medium' }, /Qoder kept effort low instead of medium/],
] as const)('refuses an unsupported ACP profile (%s) before any prompt', async (scenario, profile, message) => {
  const log = await vendorLog();
  try {
    await expect(startManaged('qoder', process.cwd(), async () => false, { CONVEROOM_VENDOR_FIXTURE: scenario, CONVEROOM_VENDOR_LOG: log.path },
      true, undefined, profile)).rejects.toMatchObject({ code: 'profile_unsupported', message: expect.stringMatching(message), notStarted: true, stopped: true });
    expect((await log.read()).map((c) => c.method)).not.toContain('session/prompt');
  } finally { await log.remove(); }
});
