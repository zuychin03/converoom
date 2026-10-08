import { readdir, lstat, readFile, realpath, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { join, relative, resolve, dirname } from 'node:path';
import { ConveroomError } from '../../shared/src/contracts.js';
import { scopeDigest } from '../../store/src/index.js';
import { bytesDigest } from '../../shared/src/hash.js';
export interface SourceFile {
  path: string;
  mode: number;
  digest: string;
  bytes: string;
}
export interface Snapshot {
  digest: string;
  files: SourceFile[];
}
export function validateSnapshot(content: Snapshot): void {
  if (
    !content ||
    !Array.isArray(content.files) ||
    content.digest !==
      scopeDigest(content.files.map(({ path, mode, digest }) => ({ path, mode, digest })))
  )
    throw new ConveroomError('digest_mismatch', 'Content digest mismatch');
  const paths = new Set<string>();
  let total = 0;
  for (const f of content.files) {
    safeRelative(f.path);
    const key = process.platform === 'win32' ? f.path.toLowerCase() : f.path;
    if (paths.has(key) || ![0o100644, 0o100755].includes(f.mode) || typeof f.bytes !== 'string')
      throw new ConveroomError('digest_mismatch', 'Invalid source manifest');
    paths.add(key);
    const bytes = Buffer.from(f.bytes, 'base64');
    total += bytes.length;
    if (total > 50 * 1024 * 1024)
      throw new ConveroomError('artefact_limit', 'Source exceeds 50 MiB');
    if (bytesDigest(bytes) !== f.digest)
      throw new ConveroomError('digest_mismatch', 'File digest mismatch');
  }
}
export function safeRelative(path: string): string {
  const p = path.replaceAll('\\', '/');
  if (
    !p ||
    p.startsWith('/') ||
    p.includes(':') ||
    p.split('/').some((s) => s === '..' || s === '' || s === '.git') ||
    p.includes('\0')
  )
    throw new ConveroomError('unsafe_path', 'Unsafe source path');
  return p;
}
export async function snapshot(root: string, generated: string[] = []): Promise<Snapshot> {
  if ((await lstat(root)).isSymbolicLink())
    throw new ConveroomError('unsafe_path', 'Workspace root is a symlink or junction');
  const base = await realpath(root),
    files: SourceFile[] = [];
  let total = 0;
  async function walk(dir: string) {
    for (const name of (await readdir(dir)).sort()) {
      if (name === '.git' || name === '.converoom') continue;
      const full = join(dir, name),
        path = relative(base, full).replaceAll('\\', '/'),
        stat = await lstat(full);
      if (stat.isSymbolicLink())
        throw new ConveroomError('unsafe_path', 'Symlink or junction in source');
      if (relative(base, await realpath(full)).startsWith('..'))
        throw new ConveroomError('unsafe_path', 'Source escaped workspace');
      if (generated.some((g) => path === g || path.startsWith(g + '/'))) continue;
      if (stat.isDirectory()) await walk(full);
      else if (stat.isFile()) {
        total += stat.size;
        if (total > 50 * 1024 * 1024)
          throw new ConveroomError('artefact_limit', 'Source exceeds 50 MiB');
        const b = await readFile(full);
        files.push({
          path: safeRelative(path),
          mode: stat.mode & 0o111 ? 0o100755 : 0o100644,
          digest: bytesDigest(b),
          bytes: b.toString('base64'),
        });
      } else throw new ConveroomError('unsafe_path', 'Special source file unsupported');
    }
  }
  await walk(base);
  return {
    digest: scopeDigest(files.map(({ path, mode, digest }) => ({ path, mode, digest }))),
    files,
  };
}
export async function writeSnapshot(
  root: string,
  content: Snapshot,
  preserveGenerated: string[] = [],
): Promise<void> {
  validateSnapshot(content);
  const existing = await snapshot(root, preserveGenerated);
  for (const f of existing.files)
    if (!content.files.some((n) => n.path === f.path)) await rm(join(root, f.path));
  for (const f of content.files) {
    const p = resolve(root, safeRelative(f.path));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, Buffer.from(f.bytes, 'base64'));
    if (process.platform !== 'win32') await chmod(p, f.mode & 0o777);
  }
}
export interface DeltaFile {
  path: string;
  beforeDigest?: string;
  afterDigest?: string;
  mode?: number;
  deleted: boolean;
  bytes?: string;
}
export function delta(before: Snapshot, after: Snapshot): DeltaFile[] {
  const paths = [...new Set([...before.files, ...after.files].map((f) => f.path))].sort();
  return paths.flatMap((path) => {
    const b = before.files.find((f) => f.path === path),
      a = after.files.find((f) => f.path === path);
    if (b?.digest === a?.digest && b?.mode === a?.mode) return [];
    return [
      {
        path,
        ...(b ? { beforeDigest: b.digest } : {}),
        ...(a ? { afterDigest: a.digest, bytes: a.bytes, mode: a.mode } : {}),
        deleted: !a,
      },
    ];
  });
}
export function compose(base: Snapshot, patches: DeltaFile[][]): Snapshot {
  const m = new Map(base.files.map((f) => [f.path, { ...f }]));
  for (const p of patches)
    for (const d of p) {
      safeRelative(d.path);
      if (m.get(d.path)?.digest !== d.beforeDigest)
        throw new ConveroomError(
          'content_conflict',
          'Prerequisite source conflict: ' + d.path,
          409,
        );
      if (d.deleted) m.delete(d.path);
      else {
        if (d.bytes === undefined || bytesDigest(Buffer.from(d.bytes, 'base64')) !== d.afterDigest)
          throw new ConveroomError('digest_mismatch', 'Patch mismatch');
        m.set(d.path, { path: d.path, mode: d.mode!, digest: d.afterDigest!, bytes: d.bytes });
      }
    }
  const files = [...m.values()].sort((a, b) => a.path.localeCompare(b.path));
  return {
    files,
    digest: scopeDigest(files.map(({ path, mode, digest }) => ({ path, mode, digest }))),
  };
}
