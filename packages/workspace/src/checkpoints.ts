import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ConveroomError as E, type Store } from '../../shared/src/contracts.js';
import { run } from '../../adapters/src/process.js';
import { snapshot, validateSnapshot, type Snapshot } from './content.js';

// NFR-19: at most 20 checkpoints and 512 MiB of deduplicated blobs per attempt.
export const CHECKPOINT_LIMIT = 20;
export const CHECKPOINT_BUDGET = 512 * 1024 * 1024;
export interface Checkpoint {
  id: string;
  roomId: string;
  attemptId: string;
  taskId: string;
  seq: number;
  parentSeq: number;
  turnIds: string[];
  treeDigest: string;
  status: 'kept' | 'pruned' | 'skipped';
  files: number;
  changed: { added: number; modified: number; deleted: number } | null;
  newBytes: number;
  createdAt: number;
  superseded?: boolean;
  prunedAt?: number;
  reason?: string;
}
interface Entry {
  path: string;
  mode: number;
  digest: string;
}
interface AttemptTree {
  id: string;
  roomId: string;
  taskId: string;
  effectiveBase: string;
  treeDigest?: string;
  checkpointSeq?: number;
  rollbackSeq?: number;
}
// run() keeps only the last 256 KiB of output, so a longer listing is incomplete.
const LISTING_LIMIT = 262144;
export async function ignoredPaths(path: string): Promise<string[]> {
  const r = await run('git', ['ls-files', '-z', '--others', '--ignored', '--exclude-standard', '--directory'], path);
  if (r.exitCode || r.output.length >= LISTING_LIMIT)
    throw new E('checkpoint_unreadable', 'Cannot list the clone\'s ignored paths');
  return r.output.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, ''));
}
// Checkpoints and the checks that compare against them leave out Git-ignored and generated paths.
export async function attemptTree(path: string, generated: string[]): Promise<Snapshot> {
  return snapshot(path, [...generated, ...(await ignoredPaths(path))]);
}
export function changeCounts(from: Entry[], to: Entry[]): { added: number; modified: number; deleted: number } {
  const before = new Map(from.map((f) => [f.path, f])), after = new Set(to.map((f) => f.path));
  let added = 0, modified = 0;
  for (const f of to) {
    const b = before.get(f.path);
    if (!b) added++;
    else if (b.digest !== f.digest || b.mode !== f.mode) modified++;
  }
  return { added, modified, deleted: from.filter((f) => !after.has(f.path)).length };
}
export function checkpointStore(store: Store, dataDir: string, budget = CHECKPOINT_BUDGET) {
  const dir = (attemptId: string) => join(dataDir, 'checkpoints', attemptId);
  const blob = (attemptId: string, digest: string) => join(dir(attemptId), 'blobs', digest);
  const list = (roomId: string, attemptId: string) => store.list<Checkpoint>('checkpoint', { roomId })
    .filter((c) => c.attemptId === attemptId).sort((a, b) => a.seq - b.seq);
  const entries = async (attemptId: string, seq: number) =>
    JSON.parse(await readFile(join(dir(attemptId), seq + '.json'), 'utf8')) as Entry[];
  const tree = async (at: AttemptTree, seq: number, base: Snapshot): Promise<Snapshot> => {
    if (seq === 0) return base;
    const c = store.get<Checkpoint>('checkpoint', at.id + ':' + seq);
    if (!c || c.attemptId !== at.id || c.status !== 'kept') throw new E('not_found', 'Checkpoint not kept', 404);
    const known = new Map(base.files.map((f) => [f.digest, f.bytes]));
    const files = await Promise.all((await entries(at.id, seq)).map(async (f) => ({
      ...f, bytes: known.get(f.digest) ?? (await readFile(blob(at.id, f.digest))).toString('base64'),
    })));
    const content = { digest: c.treeDigest, files };
    validateSnapshot(content);
    return content;
  };
  const blobBytes = async (attemptId: string, digest: string) =>
    (await lstat(blob(attemptId, digest)).catch(() => ({ size: 0 }))).size;
  // Stores the files a checkpoint adds and decides which older checkpoints to prune. The caller commits the records.
  const prepare = async (at: AttemptTree, turnId: string, current: Snapshot, base: Snapshot) => {
    const all = list(at.roomId, at.id), kept = all.filter((c) => c.status === 'kept');
    const parentSeq = at.checkpointSeq ?? 0, seq = (all.at(-1)?.seq ?? 0) + 1;
    const inBase = new Set(base.files.map((f) => f.digest));
    const own = (files: Entry[]) => files.filter((f) => !inBase.has(f.digest)).map((f) => f.digest);
    const trees = new Map<number, Entry[]>();
    for (const c of kept) trees.set(c.seq, await entries(at.id, c.seq));
    const size = new Map<string, number>();
    for (const f of current.files) if (!inBase.has(f.digest)) size.set(f.digest, Buffer.byteLength(f.bytes, 'base64'));
    for (const files of trees.values())
      for (const d of own(files)) if (!size.has(d)) size.set(d, await blobBytes(at.id, d));
    const used = (seqs: number[]) => [...new Set([...seqs.flatMap((s) => own(trees.get(s)!)), ...own(current.files)])]
      .reduce((n, d) => n + size.get(d)!, 0);
    const held = new Set([kept[0]?.seq, kept.at(-1)?.seq, at.rollbackSeq]);
    let remaining = kept.map((c) => c.seq);
    const pruned: number[] = [];
    while (remaining.length + 1 > CHECKPOINT_LIMIT || used(remaining) > budget) {
      const victim = remaining.find((s) => !held.has(s));
      if (victim === undefined) break;
      remaining = remaining.filter((s) => s !== victim);
      pruned.push(victim);
    }
    const parent = parentSeq === 0 ? base.files : trees.get(parentSeq);
    const record: Checkpoint = {
      id: at.id + ':' + seq, roomId: at.roomId, attemptId: at.id, taskId: at.taskId, seq, parentSeq,
      turnIds: [turnId], treeDigest: current.digest, status: 'kept', files: current.files.length,
      changed: parent ? changeCounts(parent, current.files) : null, newBytes: 0, createdAt: Date.now(),
    };
    if (remaining.length + 1 > CHECKPOINT_LIMIT || used(remaining) > budget)
      return { record: { ...record, status: 'skipped' as const, reason: 'budget' }, pruned: [] };
    await mkdir(join(dir(at.id), 'blobs'), { recursive: true });
    for (const f of current.files)
      if (!inBase.has(f.digest) && !existsSync(blob(at.id, f.digest))) {
        await writeFile(blob(at.id, f.digest), Buffer.from(f.bytes, 'base64'), { mode: 0o600 });
        record.newBytes += size.get(f.digest)!;
      }
    await writeFile(join(dir(at.id), seq + '.json'),
      JSON.stringify(current.files.map(({ path, mode, digest }) => ({ path, mode, digest }))), { mode: 0o600 });
    return { record, pruned: pruned.map((s) => all.find((c) => c.seq === s)!) };
  };
  // Removes tree listings of checkpoints no longer kept and blobs no kept checkpoint references.
  const collect = async (at: AttemptTree, base: Snapshot) => {
    const inBase = new Set(base.files.map((f) => f.digest)), keep = new Set<string>(), all = list(at.roomId, at.id);
    for (const c of all.filter((v) => v.status === 'kept'))
      for (const f of await entries(at.id, c.seq)) if (!inBase.has(f.digest)) keep.add(f.digest);
    for (const name of await readdir(join(dir(at.id), 'blobs')).catch(() => []))
      if (!keep.has(name)) await rm(blob(at.id, name), { force: true });
    for (const c of all.filter((v) => v.status !== 'kept'))
      await rm(join(dir(at.id), c.seq + '.json'), { force: true });
  };
  const usedBytes = async (attemptId: string) => {
    let total = 0;
    for (const name of await readdir(join(dir(attemptId), 'blobs')).catch(() => [])) total += await blobBytes(attemptId, name);
    return total;
  };
  return { dir, list, tree, prepare, collect, usedBytes, budget };
}
