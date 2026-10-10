import { it, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { onboard, parseOnboardProducts } from '../apps/cli/src/onboard.js';

it('rejects unknown onboarding products before changing native configurations', () => {
  expect(() => parseOnboardProducts('codex,other')).toThrow(/supported product/i);
});

it('registers each selected product once and supports installation without an agent', () => {
  expect(parseOnboardProducts('codex,qoder,codex')).toEqual(['codex', 'qoder']);
  expect(parseOnboardProducts('')).toEqual([]);
});

it('reports the shared listener when onboarding reuses an existing runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-onboard-shared-'));
  const server = createServer((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ name: 'converoom', pid: process.pid })); });
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    await writeFile(join(root, 'runtime.json'), JSON.stringify({ url: 'http://127.0.0.1:' + port,
      pid: process.pid, controlToken: 'fixture', sharedOrigin: 'https://fixture.tailnet.invalid', sharedPort: 50182 }));
    await onboard('unused', root, [], false);
    const text = output.mock.calls.flat().join('\n');
    expect(text).toContain('Shared listener configured at https://fixture.tailnet.invalid');
    expect(text).not.toContain('Shared access is disabled');
    expect(text).toContain('existing runtime was reused');
  } finally { output.mockRestore(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
