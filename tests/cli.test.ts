import { it, expect } from 'vitest';
import { editConfig } from '../apps/cli/src/support.js';
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
