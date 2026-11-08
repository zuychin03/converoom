import { expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const run = (cwd: string, step: string) =>
  promisify(execFile)(process.execPath, [resolve('scripts/production-shrinkwrap.mjs'), step], { cwd, windowsHide: true });

it('packs a lockfile with only production entries, so installing the package never pulls its development tools, and restores the full one afterwards', async () => {
  const root = await mkdtemp(join(tmpdir(), 'converoom-shrinkwrap-'));
  try {
    const original = await readFile('npm-shrinkwrap.json', 'utf8'), full = JSON.parse(original);
    await copyFile('npm-shrinkwrap.json', join(root, 'npm-shrinkwrap.json'));
    await run(root, 'prepack');
    const packed = await readFile(join(root, 'npm-shrinkwrap.json'), 'utf8'), lock = JSON.parse(packed);
    const production = Object.keys(full.packages).filter((path) => !full.packages[path].dev);
    expect(Object.keys(lock.packages).sort()).toEqual(production.sort());
    for (const path of production.filter(Boolean)) expect(lock.packages[path]).toEqual(full.packages[path]);
    expect(lock.packages['']).not.toHaveProperty('devDependencies');
    expect(lock.packages[''].dependencies).toEqual(full.packages[''].dependencies);
    expect(lock.packages).toHaveProperty(['node_modules/better-sqlite3']);
    for (const tool of ['typescript', 'vitest', 'eslint', '@playwright/test']) expect(lock.packages).not.toHaveProperty(['node_modules/' + tool]);
    const manifest = JSON.parse(await readFile('RELEASE_MANIFEST.json', 'utf8'));
    expect(manifest.lockfileSha256).toBe(createHash('sha256').update(packed).digest('hex'));

    await expect(run(root, 'prepack')).rejects.toThrow(/interrupted pack/);
    expect(await readFile(join(root, 'npm-shrinkwrap.json'), 'utf8')).toBe(packed);
    await run(root, 'postpack');
    expect(await readFile(join(root, 'npm-shrinkwrap.json'), 'utf8')).toBe(original);
    expect(existsSync(join(root, 'npm-shrinkwrap.full.json'))).toBe(false);

    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    expect(pkg.scripts).toMatchObject({
      prepack: 'node scripts/production-shrinkwrap.mjs prepack',
      postpack: 'node scripts/production-shrinkwrap.mjs postpack',
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
