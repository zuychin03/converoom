import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshot, compose, delta, writeSnapshot } from '../packages/workspace/src/content.js';
describe('exact source content', () => {
  it('reconstructs mixed-case and nested filenames with the same content identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'converoom-content-'));
    const rebuilt = await mkdtemp(join(tmpdir(), 'converoom-rebuilt-'));
    try {
      await mkdir(join(root, 'a'));
      await writeFile(join(root, 'README.md'), 'Public project\n');
      await writeFile(join(root, 'package.json'), '{}\n');
      await writeFile(join(root, 'a.md'), 'Top-level document\n');
      await writeFile(join(root, 'a', 'File.ts'), 'export const value = 1;\n');
      const foundation = await snapshot(root);
      expect(compose(foundation, []).digest).toBe(foundation.digest);
      await writeFile(join(root, 'a', 'File.ts'), 'export const value = 2;\n');
      const submitted = await snapshot(root);
      const reconstructed = compose(foundation, [delta(foundation, submitted)]);
      expect(reconstructed.digest).toBe(submitted.digest);
      await writeSnapshot(rebuilt, reconstructed);
      expect((await snapshot(rebuilt)).digest).toBe(submitted.digest);
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(rebuilt, { recursive: true, force: true });
    }
  });
  it('identifies byte changes and deletion without requiring commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'converoom-content-'));
    try {
      await mkdir(join(root, '.git'));
      await writeFile(join(root, '.git', 'ignored'), 'metadata');
      await writeFile(join(root, 'code.ts'), 'a\n');
      const a = await snapshot(root);
      expect(a.files.map((f) => f.path)).toEqual(['code.ts']);
      await writeFile(join(root, 'code.ts'), 'b\n');
      const b = await snapshot(root);
      expect(b.digest).not.toBe(a.digest);
      await rm(join(root, 'code.ts'));
      expect((await snapshot(root)).digest).not.toBe(b.digest);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it('excludes only explicitly generated outputs and refuses symlinks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'converoom-content-'));
    try {
      await mkdir(join(root, 'build'));
      await writeFile(join(root, 'build', 'result'), 'generated');
      await writeFile(join(root, 'source'), 'safe');
      expect((await snapshot(root, ['build'])).files.map((f) => f.path)).toEqual(['source']);
      await symlink(join(root, 'build'), join(root, 'escape'), 'junction');
      await expect(snapshot(root)).rejects.toThrow(/symlink|junction/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
