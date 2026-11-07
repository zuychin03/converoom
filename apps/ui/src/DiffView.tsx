import { useState } from 'react';
import { lineDiff, type DiffLine } from '../../../packages/shared/src/diff.js';
import { string, type RecordData } from './api.js';
import { num } from './model.js';

const CONTEXT = 3;
const CHANGES: Record<string, string> = { added: 'Added', deleted: 'Deleted', modified: 'Modified' };
const MARK: Record<DiffLine['kind'], [string, string]> = { same: [' ', 'Unchanged'], add: ['+', 'Added'], del: ['-', 'Removed'] };
type Part = { gap: boolean; lines: DiffLine[] };
// Unchanged runs longer than the context around each change fold into one row.
function parts(lines: DiffLine[]): Part[] {
  const changed = lines.flatMap((l, i) => (l.kind === 'same' ? [] : [i]));
  const shown = (i: number) => changed.some((c) => Math.abs(c - i) <= CONTEXT);
  const out: Part[] = [];
  lines.forEach((line, i) => {
    const gap = changed.length > 0 && !shown(i);
    if (out.at(-1)?.gap === gap) out.at(-1)!.lines.push(line);
    else out.push({ gap, lines: [line] });
  });
  return out;
}
function FileLines({ file }: { file: RecordData }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const lines = lineDiff(string(file, 'before'), string(file, 'after'));
  if (!lines.length) return <p className="diff-note">Empty file.</p>;
  return (
    <table className="diff-lines">
      <tbody>
        {parts(lines).map((part, p) =>
          part.gap && !open.has(p) ? (
            <tr key={p} className="diff-gap">
              <td colSpan={4}>
                <button type="button" className="diff-expand" onClick={() => setOpen(new Set(open).add(p))}>
                  Show {part.lines.length} unchanged {part.lines.length === 1 ? 'line' : 'lines'}
                </button>
              </td>
            </tr>
          ) : (
            part.lines.map((line) => (
              <tr key={`${p}:${line.old ?? ''}:${line.new ?? ''}`} className={`diff-${line.kind}`}>
                <td className="num diff-old">{line.old ?? ''}</td>
                <td className="num diff-new">{line.new ?? ''}</td>
                <td className="diff-mark" aria-hidden="true">{MARK[line.kind][0]}</td>
                <td className="diff-text">
                  <span className="sr-only">{MARK[line.kind][1]}: </span>
                  {line.text}
                </td>
              </tr>
            ))
          ),
        )}
      </tbody>
    </table>
  );
}
export function DiffView({ files, omittedFiles = 0 }: { files: RecordData[]; omittedFiles?: number }) {
  if (!files.length) return <p className="diff-note">No file changes.</p>;
  return (
    <div className="diff">
      {files.map((file) => {
        const before = num(file, 'beforeMode'), after = num(file, 'afterMode');
        return (
          <section key={string(file, 'path')} className="diff-file" aria-label={string(file, 'path')}>
            <h4 className="diff-head">
              <code>{string(file, 'path')}</code>
              <span className="diff-change">{CHANGES[string(file, 'change')] ?? 'Changed'}</span>
              {before !== undefined && after !== undefined && before !== after && (
                <span className="diff-change">{after === 0o100755 ? 'Now executable' : 'No longer executable'}</span>
              )}
            </h4>
            {file.omitted === 'binary' ? <p className="diff-note">Binary file; its contents are not shown.</p>
              : file.omitted === 'size' ? <p className="diff-note">Too large to show here.</p>
                : <FileLines file={file} />}
          </section>
        );
      })}
      {omittedFiles > 0 && <p className="diff-note">{omittedFiles} more changed {omittedFiles === 1 ? 'file is' : 'files are'} not shown.</p>}
    </div>
  );
}
