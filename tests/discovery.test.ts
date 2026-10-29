import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Actor } from '../packages/shared/src/contracts.js';
const vendors = vi.hoisted(() => ({ missing: new Set<string>() }));
vi.mock('../packages/adapters/src/process.js', async (original) => ({
  ...await original<typeof import('../packages/adapters/src/process.js')>(),
  executable: async (name: string) => {
    if (vendors.missing.has(name)) throw new Error(name + ' is not installed');
    return name === process.execPath ? { command: name, args: [] } : { command: process.execPath,
      args: [join(process.cwd(), 'tests', 'fixtures', 'managed-vendor.mjs'),
        ({ agent: 'cursor', 'kiro-cli': 'kiro', agy_acp_server: 'antigravity', agy: 'antigravity' } as Record<string, string>)[name] ?? name] };
  },
}));
import { discover, type Discovery } from '../packages/adapters/src/discover.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, humanIdentity, issueBridgeCredential } from '../apps/daemon/src/server.js';
import { main } from '../apps/cli/src/index.js';
import { autoConnectable, discoveryFile } from '../apps/cli/src/discovery.js';
import { editConfig, mcpArgs, privateJson, registeredEntry } from '../apps/cli/src/support.js';
import { TOOL_DEFINITIONS } from '../packages/mcp/src/tools.js';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'converoom-discovery-')); vendors.missing = new Set(); });
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });
const log = () => join(dir, 'vendor.log');
const calls = async () => existsSync(log())
  ? (await readFile(log(), 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { product: string; method: string; params?: unknown }) : [];
const statuses = (d: Discovery) => Object.fromEntries(d.harnesses.map((h) => [h.product, h.status]));

it('classifies every product from bounded handshakes without authenticating, opening a session or keeping account details', async () => {
  vendors.missing = new Set(['qoder']);
  const result = await discover(dir, async (product) => product === 'claude', { env: { CONVEROOM_VENDOR_LOG: log() } });
  expect(statuses(result)).toEqual({ codex: 'ready_managed', cursor: 'ready_managed', claude: 'ready_polling', opencode: 'needs_mcp_registration',
    antigravity: 'ready_managed', kiro: 'ready_managed', qoder: 'not_installed', grok: 'ready_managed' });
  const codex = result.harnesses.find((h) => h.product === 'codex');
  expect(codex).toMatchObject({ installed: true, version: 'codex fixture 1.0.0', signIn: 'signed_in', models: ['gpt-fixture'], registered: false });
  expect(result.harnesses.find((h) => h.product === 'kiro')).toMatchObject({ signIn: 'not_checked' });
  expect(result.harnesses.find((h) => h.product === 'claude')).toMatchObject({ signIn: 'not_applicable', registered: true });
  const seen = await calls();
  expect(new Set(seen.map((c) => c.method))).toEqual(new Set(['initialize', 'initialized', 'account/read', 'model/list']));
  expect(seen.find((c) => c.method === 'account/read')?.params).toEqual({ refreshToken: false });
  expect(JSON.stringify(result)).not.toContain('owner@example.com');
});

it.each([['signed-out', 'codex'], ['api-only', 'cursor'], ['api-only', 'grok']])(
  'reports needs_login when the %s handshake shows %s cannot use its native sign-in', async (scenario, product) => {
    const result = await discover(dir, async () => false, { env: { CONVEROOM_VENDOR_FIXTURE: scenario } });
    expect(result.harnesses.find((h) => h.product === product)).toMatchObject({ status: 'needs_login', detail: expect.any(String) });
  });

it('says why an installed product whose managed server is a separate install can only join by polling', async () => {
  vendors.missing = new Set(['agy_acp_server']);
  const result = await discover(dir, async () => false);
  expect(result.harnesses.find((h) => h.product === 'antigravity')).toMatchObject({ status: 'needs_mcp_registration', installed: true,
    managedIssue: 'its agy_acp_server ACP server is not installed', detail: expect.stringMatching(/^Antigravity's managed route is unavailable: its agy_acp_server/) });
});

it('bounds a vendor that never answers and scans the products in parallel', async () => {
  const started = Date.now();
  const result = await discover(dir, async () => false, { env: { CONVEROOM_VENDOR_FIXTURE: 'hang' }, waitMs: 1000 });
  expect(Date.now() - started).toBeLessThan(5000);
  expect(result.harnesses.find((h) => h.product === 'codex')).toMatchObject({ status: 'needs_mcp_registration', detail: expect.stringMatching(/did not answer/) });
});

it('scans only when the owner asks, never at startup or in a health check, and lets agents read the latest result', async () => {
  vi.stubEnv('CONVEROOM_VENDOR_LOG', log());
  const runtime = await createRuntime(dir, { noScheduler: true }), server = await createServer(runtime, { port: 0 });
  try {
    await fetch(server.url + '/health');
    const owner = humanIdentity(runtime), { principalId } = issueBridgeCredential(runtime, 'codex');
    const agent: Actor = { kind: 'agent', principalId, ownerId: owner.ownerId };
    expect(await runtime.core.dispatch(agent, 'adapter_discover', {})).toEqual({ discovery: null });
    expect(existsSync(discoveryFile(dir))).toBe(false);
    expect(await calls()).toEqual([]);
    const fresh = await runtime.core.dispatch(owner, 'adapter_discover', { refresh: true }) as { discovery: Discovery };
    expect(fresh.discovery.harnesses).toHaveLength(8);
    expect(JSON.parse(await readFile(discoveryFile(dir), 'utf8'))).toEqual(fresh.discovery);
    expect(await runtime.core.dispatch(agent, 'adapter_discover', {})).toEqual(fresh);
    await expect(runtime.core.dispatch(agent, 'adapter_discover', { refresh: true })).rejects.toMatchObject({ code: 'human_required' });
    await expect(runtime.core.dispatch(agent, 'adapter_autoconnect', {})).rejects.toMatchObject({ code: 'human_required' });
  } finally { await server.close(); await runtime.stop(); }
});

it('connects installed agents that are not yet connected, keeping existing connections and other settings', async () => {
  const home = join(dir, 'home');
  vi.stubEnv('USERPROFILE', home);
  vendors.missing = new Set(['qoder', 'opencode', 'agy', 'agy_acp_server', 'kiro-cli', 'grok']);
  const runtime = await createRuntime(join(dir, 'data'), { noScheduler: true });
  try {
    const dataDir = join(dir, 'data'), cursorConfig = join(home, '.cursor', 'mcp.json'), codexConfig = join(home, '.codex', 'config.toml');
    await mkdir(join(home, '.cursor'), { recursive: true });
    await writeFile(cursorConfig, JSON.stringify({ setting: 'preserve', mcpServers: { other: { command: 'other' } } }));
    const existing = issueBridgeCredential(runtime, 'codex');
    await privateJson(join(dataDir, 'clients', 'codex.json'), { ...existing, config: codexConfig });
    await editConfig(codexConfig, 'codex', { command: process.execPath, args: mcpArgs('stable/cli.js', 'codex', dataDir, false) });
    const result = await runtime.core.dispatch(humanIdentity(runtime), 'adapter_autoconnect', {});
    expect(result).toMatchObject({ connected: ['cursor', 'claude'], alreadyConnected: ['codex'], failed: [] });
    expect((result as { notInstalled: string[] }).notInstalled.sort()).toEqual(['antigravity', 'grok', 'kiro', 'opencode', 'qoder']);
    expect(JSON.parse(await readFile(cursorConfig, 'utf8'))).toMatchObject({ setting: 'preserve', mcpServers: { other: { command: 'other' } } });
    expect((await registeredEntry('cursor', cursorConfig))?.args).toEqual(mcpArgs(join(dataDir, 'runtime', '0.2.0', 'dist', 'cli.js'), 'cursor', dataDir, false));
    expect(existsSync(join(home, '.claude', 'skills', 'converoom-room', 'SKILL.md'))).toBe(true);
    expect(JSON.parse(await readFile(join(dataDir, 'clients', 'codex.json'), 'utf8'))).toMatchObject({ principalId: existing.principalId });
    const latest = JSON.parse(await readFile(discoveryFile(dataDir), 'utf8')) as Discovery;
    expect(latest.harnesses.find((h) => h.product === 'cursor')).toMatchObject({ registered: true });
    expect(runtime.core.store.list<{ type: string }>('authority_audit').filter((r) => r.type === 'bridge.credential_issued')).toHaveLength(2);
  } finally { await runtime.stop(); }
}, 180000);

it('picks installed agents that are not yet connected for one-step connection', () => {
  const harness = (product: string, status: string, registered: boolean) => ({ product, status, registered, installed: status !== 'not_installed' });
  expect(autoConnectable({ at: 1, harnesses: [harness('codex', 'ready_managed', true), harness('cursor', 'needs_login', false),
    harness('qoder', 'not_installed', false), harness('claude', 'needs_mcp_registration', false), harness('kiro', 'ready_managed', false)] } as Discovery))
    .toEqual(['cursor', 'claude', 'kiro']);
});

it('runs discovery from doctor only when asked, and refuses mixing onboard --auto with a product list', async () => {
  vi.stubEnv('CONVEROOM_VENDOR_LOG', log());
  const out = vi.spyOn(console, 'log').mockImplementation(() => {});
  await main(['doctor', '--data-dir', dir]);
  expect(existsSync(discoveryFile(dir))).toBe(false);
  expect((await calls()).filter((c) => c.method === 'initialize')).toEqual([]);
  await main(['doctor', '--discover', '--data-dir', dir]);
  const printed = JSON.parse(String(out.mock.calls.at(-1)?.[0])) as { discovery: Discovery };
  expect(printed.discovery.harnesses).toHaveLength(8);
  expect(JSON.parse(await readFile(discoveryFile(dir), 'utf8'))).toEqual(printed.discovery);
  await expect(main(['onboard', '--auto', '--products', 'codex', '--data-dir', dir])).rejects.toThrow(/--auto or --products/);
});

it('offers agents a read-only discovery tool and keeps connecting to the owner', () => {
  const discoverTool = TOOL_DEFINITIONS.find((t) => t.name === 'adapter_discover');
  expect(discoverTool?.inputSchema).toMatchObject({ required: [], additionalProperties: false });
  expect(discoverTool?.inputSchema.properties).not.toHaveProperty('refresh');
  expect(TOOL_DEFINITIONS.some((t) => t.name === 'adapter_autoconnect')).toBe(false);
});
