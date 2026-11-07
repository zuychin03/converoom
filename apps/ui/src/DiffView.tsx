import { useState, type MouseEvent } from 'react';
import { lineDiff, type DiffLine } from '../../../packages/shared/src/diff.js';
import { string, type RecordData } from './api.js';
import { num } from './model.js';

export interface LineComment {
  path: string;
  side: 'result' | 'base';
  startLine: number;
  endLine: number;
  comment: string;
  digest: string;
}
type Side = LineComment['side'];
type Pick = { side: Side; anchor: number; start: number; end: number };
const CONTEXT = 3;
const CHANGES: Record<string, string> = { added: 'Added', deleted: 'Deleted', modified: 'Modified' };
const MARK: Record<DiffLine['kind'], [string, string]> = { same: [' ', 'Unchanged'], add: ['+', 'Added'], del: ['-', 'Removed'] };
const VERSION: Record<Side, string> = { result: 'submitted', base: 'previous' };
const span = (start: number, end: number) => (start === end ? `line ${start}` : `lines ${start} to ${end}`);
// Removed lines belong to the previous version; added and unchanged lines are numbered in the submitted one.
const covers = (line: DiffLine, side: Side, n: number) =>
  side === 'base' ? line.kind !== 'add' && line.old === n : line.kind !== 'del' && line.new === n;
type Part = { gap: boolean; lines: [DiffLine, number][] };
// Unchanged runs longer than the context around each change or comment fold into one row.
function parts(lines: DiffLine[], pinned: Set<number>): Part[] {
  const anchors = lines.flatMap((l, i) => (l.kind === 'same' && !pinned.has(i) ? [] : [i]));
  const out: Part[] = [];
  lines.forEach((line, i) => {
    const gap = anchors.length > 0 && !anchors.some((c) => Math.abs(c - i) <= CONTEXT);
    if (out.at(-1)?.gap === gap) out.at(-1)!.lines.push([line, i]);
    else out.push({ gap, lines: [[line, i]] });
  });
  return out;
}
interface Notes {
  comments: LineComment[];
  drafts: { comment: LineComment; index: number }[];
  onAdd?: (comment: LineComment) => void;
  onRemove?: (index: number) => void;
}
function Comment({ note, onRemove }: { note: LineComment; onRemove?: () => void }) {
  return (
    <div className="diff-comment">
      <span className="diff-change">
        {onRemove ? 'Draft comment' : 'Review comment'} · {VERSION[note.side]} {span(note.startLine, note.endLine)}
      </span>
      <p>{note.comment}</p>
      {onRemove && (
        <button type="button" className="button small" onClick={onRemove}>
          Remove
        </button>
      )}
    </div>
  );
}
function FileLines({ file, notes }: { file: RecordData; notes: Notes }) {
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [pick, setPick] = useState<Pick>();
  const [text, setText] = useState('');
  const path = string(file, 'path');
  const lines = lineDiff(string(file, 'before'), string(file, 'after'));
  if (!lines.length) return <p className="diff-note">Empty file.</p>;
  const mine = (c: LineComment) => c.path === path;
  const saved = notes.comments.filter(mine), drafts = notes.drafts.filter((d) => mine(d.comment));
  const endsAt = (line: DiffLine, c: Pick | LineComment) => covers(line, c.side, 'end' in c ? c.end : c.endLine);
  const pinned = new Set(lines.flatMap((l, i) =>
    [...saved, ...drafts.map((d) => d.comment), ...(pick ? [pick] : [])].some((c) => endsAt(l, c)) ? [i] : []));
  const choose = (side: Side, n: number, event: MouseEvent) =>
    setPick((p) => {
      const anchor = event.shiftKey && p && p.side === side ? p.anchor : n;
      return { side, anchor, start: Math.min(anchor, n), end: Math.max(anchor, n) };
    });
  const add = () => {
    if (!pick || !notes.onAdd) return;
    notes.onAdd({ path, side: pick.side, startLine: pick.start, endLine: pick.end, comment: text.trim(),
      digest: string(file, pick.side === 'result' ? 'afterDigest' : 'beforeDigest') });
    setPick(undefined);
    setText('');
  };
  const number = (line: DiffLine, side: Side) => {
    const n = side === 'base' ? line.old : line.new;
    if (n === undefined) return '';
    if (!notes.onAdd || (side === 'base') !== (line.kind === 'del')) return n;
    return (
      <button type="button" className="diff-line-button" aria-label={`Comment on ${VERSION[side]} line ${n}`}
        onClick={(event) => choose(side, n, event)}>
        {n}
      </button>
    );
  };
  return (
    <table className="diff-lines">
      <tbody>
        {parts(lines, pinned).map((part, p) =>
          part.gap && !open.has(p) ? (
            <tr key={p} className="diff-gap">
              <td colSpan={4}>
                <button type="button" className="diff-expand" onClick={() => setOpen(new Set(open).add(p))}>
                  Show {part.lines.length} unchanged {part.lines.length === 1 ? 'line' : 'lines'}
                </button>
              </td>
            </tr>
          ) : (
            part.lines.flatMap(([line, i]) => {
              const picked = pick && Array.from({ length: pick.end - pick.start + 1 }, (_, k) => pick.start + k)
                .some((n) => covers(line, pick.side, n));
              return [
                <tr key={i} className={`diff-${line.kind}${picked ? ' diff-picked' : ''}`}>
                  <td className="num diff-old">{number(line, 'base')}</td>
                  <td className="num diff-new">{number(line, 'result')}</td>
                  <td className="diff-mark" aria-hidden="true">{MARK[line.kind][0]}</td>
                  <td className="diff-text">
                    <span className="sr-only">{MARK[line.kind][1]}: </span>
                    {line.text}
                  </td>
                </tr>,
                ...[...saved.map((c) => ({ c, index: -1 })), ...drafts.map((d) => ({ c: d.comment, index: d.index }))]
                  .filter(({ c }) => endsAt(line, c))
                  .map(({ c, index }, k) => (
                    <tr key={`${i}:note:${k}`} className="diff-note-row">
                      <td colSpan={4}>
                        <Comment note={c} onRemove={index >= 0 && notes.onRemove ? () => notes.onRemove!(index) : undefined} />
                      </td>
                    </tr>
                  )),
                ...(pick && endsAt(line, pick) ? [
                  <tr key={`${i}:form`} className="diff-note-row">
                    <td colSpan={4}>
                      <div className="diff-comment">
                        <label className="field">
                          <span className="field-label">Your comment on {VERSION[pick.side]} {span(pick.start, pick.end)}</span>
                          <textarea value={text} rows={3} maxLength={1000} onChange={(event) => setText(event.target.value)} />
                        </label>
                        <div className="row-actions">
                          <button type="button" className="button small" disabled={!text.trim()} onClick={add}>
                            Add comment
                          </button>
                          <button type="button" className="button small" onClick={() => { setPick(undefined); setText(''); }}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    </td>
                  </tr>,
                ] : []),
              ];
            })
          ),
        )}
      </tbody>
    </table>
  );
}
export function DiffView({
  files,
  omittedFiles = 0,
  comments = [],
  drafts = [],
  onAdd,
  onRemove,
}: {
  files: RecordData[];
  omittedFiles?: number;
  comments?: LineComment[];
  drafts?: LineComment[];
  onAdd?: (comment: LineComment) => void;
  onRemove?: (index: number) => void;
}) {
  if (!files.length) return <p className="diff-note">No file changes.</p>;
  const notes: Notes = { comments, drafts: drafts.map((comment, index) => ({ comment, index })), onAdd, onRemove };
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
                : <FileLines file={file} notes={notes} />}
          </section>
        );
      })}
      {omittedFiles > 0 && <p className="diff-note">{omittedFiles} more changed {omittedFiles === 1 ? 'file is' : 'files are'} not shown.</p>}
    </div>
  );
}
