import { it, expect, vi } from 'vitest';
import { editConfig, installSkill, privateJson } from '../apps/cli/src/support.js';
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
