import { redactPublic } from '../../store/src/index.js';
import type { Snapshot, SourceFile } from './content.js';

export interface FileDiff {
  path: string;
  change: 'added' | 'deleted' | 'modified';
  beforeDigest?: string;
  afterDigest?: string;
  beforeMode?: number;
  afterMode?: number;
  binary: boolean;
  before?: string;
  after?: string;
  omitted?: 'binary' | 'size';
}
const FILE_TEXT = 512 * 1024, TOTAL_TEXT = 4 * 1024 * 1024, FILES = 300;
// Redacted a line at a time so line numbers match the stored bytes.
const text = (f: SourceFile) => {
  const bytes = Buffer.from(f.bytes, 'base64');
  return bytes.includes(0) ? undefined : bytes.toString('utf8').split('\n').map((line) => redactPublic(line)).join('\n');
};
export function treeDiff(from: Snapshot, to: Snapshot): { files: FileDiff[]; omittedFiles: number } {
  const before = new Map(from.files.map((f) => [f.path, f])), after = new Map(to.files.map((f) => [f.path, f]));
  const changed = [...new Set([...before.keys(), ...after.keys()])].sort().filter((path) => {
    const b = before.get(path), a = after.get(path);
    return b?.digest !== a?.digest || b?.mode !== a?.mode;
  });
  let budget = TOTAL_TEXT;
  const files = changed.slice(0, FILES).map((path): FileDiff => {
    const b = before.get(path), a = after.get(path);
    const sizes = [b, a].map((f) => (f ? Buffer.byteLength(f.bytes, 'base64') : 0)), size = sizes[0] + sizes[1];
    const out: FileDiff = {
      path, change: !b ? 'added' : !a ? 'deleted' : 'modified', binary: false,
      ...(b ? { beforeDigest: b.digest, beforeMode: b.mode } : {}), ...(a ? { afterDigest: a.digest, afterMode: a.mode } : {}),
    };
    const left = b && text(b), right = a && text(a);
    if ((b && left === undefined) || (a && right === undefined)) return { ...out, binary: true, omitted: 'binary' };
    if (sizes.some((n) => n > FILE_TEXT) || size > budget) return { ...out, omitted: 'size' };
    budget -= size;
    return { ...out, ...(left !== undefined ? { before: left } : {}), ...(right !== undefined ? { after: right } : {}) };
  });
  return { files, omittedFiles: changed.length - files.length };
}
