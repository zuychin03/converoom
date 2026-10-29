import { it, expect, vi } from 'vitest';
import { connectionReport, editConfig, installSkill, privateJson, registeredEntry } from '../apps/cli/src/support.js';
import { main } from '../apps/cli/src/index.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer } from '../apps/daemon/src/server.js';
import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
it.each(['antigravity', 'kiro', 'qoder'])('preserves unrelated JSON settings when connecting %s', async (product) => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-config-'));
  try {
    const file = join(root, 'mcp.json');
    await writeFile(file, JSON.stringify({ setting: 'preserve', mcpServers: { other: { command: 'other' } } }));
    await editConfig(file, product, { command: 'node', args: ['stable/cli.js', 'mcp', '--client', product] });
    expect(JSON.parse(await readFile(file, 'utf8')).mcpServers.converoom.args).toContain(product);
    await editConfig(file, product, {}, true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ setting: 'preserve', mcpServers: { other: { command: 'other' } } });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('registers and removes Grok TOML without consuming neighbouring tables', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-grok-config-'));
  try {
    const file = join(root, 'config.toml');
    await writeFile(file, 'model = "preserve"\n[mcp_servers.other]\ncommand = "other"\n');
    await editConfig(file, 'grok', { command: 'node', args: ['stable/cli.js', 'mcp', '--client', 'grok'] });
    expect(await readFile(file, 'utf8')).toContain('[mcp_servers.converoom]');
    await editConfig(file, 'grok', {}, true);
    expect(await readFile(file, 'utf8')).toContain('[mcp_servers.other]\ncommand = "other"');
    expect(await readFile(file, 'utf8')).not.toContain('[mcp_servers.converoom]');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('round-trips app-owned vendor registrations while preserving other settings', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-config-'));
  try {
    const file = join(root, 'cursor.json');
    await writeFile(
      file,
      JSON.stringify({ setting: 'preserve', mcpServers: { other: { command: 'other' } } }),
    );
    await editConfig(file, 'cursor', { command: 'node', args: ['stable/cli.js', 'mcp'] });
    await editConfig(file, 'cursor', {}, true);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({
      setting: 'preserve',
      mcpServers: { other: { command: 'other' } },
    });
    const toml = join(root, 'codex.toml');
    await writeFile(toml, 'model = "preserve"\n[mcp_servers.other]\ncommand = "other"\n');
    await editConfig(toml, 'codex', { command: 'node', args: ['stable/cli.js', 'mcp'] });
    await editConfig(toml, 'codex', {}, true);
    expect(await readFile(toml, 'utf8')).toContain('[mcp_servers.other]');
    expect(await readFile(toml, 'utf8')).not.toContain('[mcp_servers.converoom]');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([['an edited', true], ['an unchanged', false]] as const)('disconnect removes the registration and client record with %s room skill', async (_, edited) => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-disconnect-'));
  const dataDir = join(root, 'data'), config = join(root, 'config.toml'), skills = join(root, 'skills', 'converoom-room'), skill = join(skills, 'SKILL.md');
  const runtime = await createRuntime(dataDir, { noScheduler: true });
  const server = await createServer(runtime, { port: 0, controlToken: 'disconnect-fixture' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ url: server.url, controlToken: 'disconnect-fixture' }));
    const credential = await (await fetch(server.url + '/local/credentials', { method: 'POST', body: JSON.stringify({ product: 'codex' }),
      headers: { authorization: 'Bearer disconnect-fixture', 'content-type': 'application/json' } })).json() as { principalId: string };
    await privateJson(join(dataDir, 'clients', 'codex.json'), { ...credential, skill: await installSkill(skills) });
    await writeFile(config, 'model = "preserve"\n');
    await editConfig(config, 'codex', { command: 'node', args: ['stable/cli.js', 'mcp', '--client', 'codex'] });
    if (edited) await writeFile(skill, 'Owner notes\n');
    await main(['disconnect', 'codex', '--config', config, '--data-dir', dataDir]);
    expect(await readFile(config, 'utf8')).toContain('model = "preserve"');
    expect(await readFile(config, 'utf8')).not.toContain('converoom');
    expect(existsSync(join(dataDir, 'clients', 'codex.json'))).toBe(false);
    expect(runtime.core.store.get('revoked', credential.principalId)).toBe(true);
    expect(existsSync(skill) && await readFile(skill, 'utf8')).toBe(edited && 'Owner notes\n');
    expect(log.mock.calls.flat().join('\n').includes(skill)).toBe(edited);
  } finally { log.mockRestore(); await server.close(); await runtime.stop(); await rm(root, { recursive: true, force: true }); }
}, 30000);
it('records auto-start in the registration only when connect asks for it, and doctor reports it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-autostart-'));
  const dataDir = join(root, 'data'), config = join(root, 'config.toml'), skills = join(root, 'skills', 'converoom-room');
  const runtime = await createRuntime(dataDir, { noScheduler: true });
  const server = await createServer(runtime, { port: 0, controlToken: 'connect-fixture' });
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await writeFile(join(dataDir, 'runtime.json'), JSON.stringify({ url: server.url, controlToken: 'connect-fixture' }));
    await writeFile(config, 'model = "preserve"\n');
    const connect = (...extra: string[]) => main(['connect', 'codex', '--config', config, '--skills-dir', skills, '--data-dir', dataDir, ...extra]);
    await connect('--auto-start');
    expect((await registeredEntry('codex', config))?.args.slice(1)).toEqual(['mcp', '--client', 'codex', '--data-dir', dataDir, '--auto-start']);
    expect(await connectionReport('codex', dataDir, config)).toMatchObject({ registration: 'registered', autoStart: true });
    expect(log.mock.calls.flat().join('\n')).toContain('Auto-start is on');
    await connect();
    expect((await registeredEntry('codex', config))?.args).not.toContain('--auto-start');
    expect(await connectionReport('codex', dataDir, config)).toMatchObject({ registration: 'registered', autoStart: false });
    await connect('--auto-start');
    await main(['disconnect', 'codex', '--config', config, '--data-dir', dataDir]);
    expect(await connectionReport('codex', dataDir, config)).toMatchObject({ registration: 'not registered', autoStart: false });
    expect(await readFile(config, 'utf8')).toContain('model = "preserve"');
  } finally { log.mockRestore(); await server.close(); await runtime.stop(); await rm(root, { recursive: true, force: true }); }
}, 180000);
it('reports whether a product is registered for this data directory and its saved credential is still active', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-doctor-'));
  const dataDir = join(root, 'data'), codexConfig = join(root, 'codex.toml'), cursorConfig = join(root, 'cursor.json'), qoderConfig = join(root, 'qoder.json');
  const runtime = await createRuntime(dataDir, { noScheduler: true });
  const server = await createServer(runtime, { port: 0, controlToken: 'doctor-fixture' });
  try {
    const post = async (path: string, body: unknown) => (await fetch(server.url + path, { method: 'POST', body: JSON.stringify(body),
      headers: { authorization: 'Bearer doctor-fixture', 'content-type': 'application/json' } })).json() as Promise<Record<string, unknown>>;
    const active = async (principalId: string) => (await post('/local/credentials/status', { principalId })).active === true;
    const credential = await post('/local/credentials', { product: 'codex' }) as { principalId: string; token: string };
    await privateJson(join(dataDir, 'clients', 'codex.json'), { ...credential, config: codexConfig });
    await editConfig(codexConfig, 'codex', { command: 'node', args: ['stable/cli.js', 'mcp', '--client', 'codex', '--data-dir', dataDir] });
    await editConfig(cursorConfig, 'cursor', { command: 'node', args: ['stable/cli.js', 'mcp', '--client', 'cursor', '--data-dir', join(root, 'other')] });
    await writeFile(qoderConfig, '{ not json');
    expect(await connectionReport('codex', dataDir, join(root, 'default.toml'), active))
      .toEqual({ registration: 'registered', config: codexConfig, credential: 'active', autoStart: false });
    expect(await connectionReport('cursor', dataDir, cursorConfig, active))
      .toEqual({ registration: 'registered for another data directory', config: cursorConfig, credential: 'none saved', autoStart: false });
    expect(await connectionReport('kiro', dataDir, join(root, 'missing.json'), active)).toMatchObject({ registration: 'no config file' });
    expect(await connectionReport('qoder', dataDir, qoderConfig, active)).toMatchObject({ registration: 'unreadable config' });
    expect(await connectionReport('codex', dataDir, codexConfig)).toMatchObject({ credential: 'saved; runtime not running, so not checked' });
    await post('/local/revoke', { principalId: credential.principalId });
    expect(await connectionReport('codex', dataDir, codexConfig, active)).toMatchObject({ credential: 'revoked or unknown to this runtime' });
    await editConfig(codexConfig, 'codex', {}, true);
    expect(await connectionReport('codex', dataDir, codexConfig, active)).toMatchObject({ registration: 'not registered' });
    expect((await fetch(server.url + '/local/credentials/status', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })).status).toBe(401);
    expect(JSON.stringify(await connectionReport('codex', dataDir, codexConfig, active))).not.toContain(credential.token);
  } finally { await server.close(); await runtime.stop(); await rm(root, { recursive: true, force: true }); }
}, 30000);
