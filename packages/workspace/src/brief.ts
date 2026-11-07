import { redactPublic } from '../../store/src/index.js';
import type { Event, Review, ToolArgs } from '../../shared/src/contracts.js';

export interface BriefInput {
  room: ToolArgs;
  decision?: Event;
  interactions: ToolArgs[];
  seats: ToolArgs[];
  candidate: ToolArgs;
  verification: ToolArgs;
  manifests: { manifest: ToolArgs; task: ToolArgs; review?: Review; verification?: ToolArgs }[];
  branch: string;
  commit: string;
  base: string;
  author: { name: string; email: string };
}
const inline = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').replace(/[|`]/g, '\\$&').trim();
const code = (v: unknown) => '`' + String(v ?? '').replace(/`/g, '') + '`';
const list = (v: unknown) => (Array.isArray(v) ? v : []);
// FR-58: a Markdown PR brief built only from recorded room state, redacted before it leaves the runtime.
export function prBrief(x: BriefInput): string {
  const seat = (id: unknown) => inline(x.seats.find((s) => s.id === id)?.name) || 'a seat';
  const open = x.interactions.filter((i) => i.status !== 'resolved');
  const d = (x.decision?.data ?? {}) as ToolArgs;
  const out = [
    '# ' + (inline(x.room.title) || 'Converoom room'), '',
    ...(x.room.objective ? [inline(x.room.objective), ''] : []),
    `Branch ${code(x.branch)} at commit ${code(x.commit)}, based on ${code(x.base)}. It holds candidate ${code(x.candidate.id)} with result ${
      code(x.candidate.resultDigest)}, committed as ${inline(x.author.name)} <${inline(x.author.email)}>. Converoom did not push it.`, '',
    '## Decision', '',
    ...(x.decision ? [
      `Proposed in room event #${x.decision.seq}; the room is in its ${inline(String(x.room.phase ?? 'deliberation').replaceAll('_', ' '))} phase.`, '',
      ...String(d.decision ?? '').split('\n').map((line) => '> ' + line), '',
      ...(list(d.dissent).length ? ['Dissent:', '', ...list(d.dissent).map((v) => '- ' + inline(typeof v === 'string' ? v : JSON.stringify(v))), ''] : []),
    ] : ['No decision was proposed in this room.', '']),
    '## Obligations', '',
    `${x.interactions.length - open.length} resolved, ${open.length} open.`, '',
    ...open.map((i) => `- ${inline(i.intent ?? 'request')} for ${seat(i.recipientId)}, ${inline(i.status)}`),
    ...(open.length ? [''] : []),
    '## Tasks', '',
    '| Task | Title | Submission | Delta | Result | Files | Review |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...x.manifests.map(({ manifest: m, task: t, review: r }) => `| ${code(t.id)} | ${inline(t.title)} | ${code(m.id)} | ${code(m.deltaDigest)} | ${
      code(m.resultDigest)} | ${list(m.files).length} | ${r ? `${r.verdict === 'accept' ? 'accepted' : 'rework requested'}: ${inline(r.reason)}` : 'none'} |`),
    '',
    '## Verification', '',
    `Combined checks ${inline(x.verification.status)} on content ${code(x.verification.contentDigest)} with profile ${
      code(x.verification.profileDigest)} in environment ${code(x.verification.environmentDigest)}.`, '',
    ...list(x.verification.checks).map((c: ToolArgs) =>
      `- ${code([c.executable, ...list(c.args)].join(' '))} exited ${c.timedOut ? 'after timing out' : String(c.exitCode)}`),
    ...(list(x.verification.checks).length ? [''] : []),
    ...x.manifests.filter((v) => v.verification).map(({ task: t, verification: v }) =>
      `- Task ${code(t.id)} checks ${inline(v!.status)} on content ${code(v!.contentDigest)}, environment ${code(v!.environmentDigest)}`),
  ];
  return redactPublic(out.join('\n').trimEnd() + '\n');
}
