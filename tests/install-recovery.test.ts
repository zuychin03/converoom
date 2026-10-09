import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { installStable, VERSION } from '../apps/cli/src/support.js';

it('preserves a partial installation while a runtime lock is present', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-install-recovery-'));
  const target = resolve(root), inside = relative(tmpdir(), target);
  if (!inside || inside.startsWith('..')) throw new Error('Unsafe fixture cleanup');
  try {
    const payload = join(root, 'runtime', VERSION, 'dist', 'cli.js');
    await mkdir(join(root, 'runtime', VERSION, 'dist'), { recursive: true });
    await writeFile(payload, 'retained partial payload');
    await writeFile(join(root, 'runtime.lock'), JSON.stringify({ pid: process.pid }));
    await expect(installStable(root)).rejects.toMatchObject({ code: 'runtime_active' });
    expect(await readFile(payload, 'utf8')).toBe('retained partial payload');
  } finally {
    await rm(target, { recursive: true, force: true });
  }
}, 90000);
