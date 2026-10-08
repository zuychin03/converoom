import { it, expect } from 'vitest';
import { editConfig } from '../apps/cli/src/support.js';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
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
