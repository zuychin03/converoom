import { isProduct, PRODUCT_PROFILES } from '../../shared/src/products.js';
import type { ToolArgs } from '../../shared/src/contracts.js';

export const TRANSCRIPT_FORMAT = 1;
export interface TranscriptSource {
  room: ToolArgs;
  events: ToolArgs[];
  seats: ToolArgs[];
  interactions?: ToolArgs[];
  members?: ToolArgs[];
  artefacts?: ToolArgs[];
  people?: Record<string, string>;
  provenance: string[];
}
type Entry = string | { title: string; body: string[] };

// eslint-disable-next-line no-control-regex -- Control and bidirectional characters can hide or reorder text in an editor or terminal.
const UNSAFE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g;
const clean = (v: unknown) => String(v ?? '').replace(/\r\n?/g, '\n').replace(UNSAFE, '\ufffd');
// Recorded text must not form headings, links, emphasis or HTML that could pass for transcript structure.
export const inline = (v: unknown) => clean(v).replace(/\s+/g, ' ').trim().replace(/[\\`*_[\]<>&~#|]/g, '\\$&');
export const code = (v: unknown) => '`' + (clean(v).replace(/[`\s]+/g, ' ').trim() || '?') + '`';
function fenced(v: unknown, info = 'text') {
  const text = clean(v), fence = '`'.repeat((text.match(/`+/g) ?? []).reduce((n, run) => Math.max(n, run.length + 1), 3));
  return fence + info + '\n' + text + (text.endsWith('\n') ? '' : '\n') + fence;
}
export const time = (at: unknown) => typeof at === 'number' && Math.abs(at) <= 8.64e15
  ? new Date(at).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'an unknown time';
function duration(ms: unknown) {
  const n = Number(ms);
  return !Number.isFinite(n) ? 'unknown length' : n < 60000 ? Math.round(n / 1000) + ' s' : Math.round(n / 60000) + ' min';
}
const record = (v: unknown): ToolArgs => (v && typeof v === 'object' && !Array.isArray(v) ? v as ToolArgs : {});
const items = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const capital = (v: string) => v.charAt(0).toUpperCase() + v.slice(1);
const end = (v: string) => (/[.!?]$/.test(v) ? v : v + '.');
const reason = (base: string, why: unknown) => end(why ? base + ': ' + inline(why) : base);
const plural = (n: number, word: string) => n + ' ' + word + (n === 1 ? '' : 's');
const FINDINGS: Record<string, string> = { acted: 'the agent acted', not_acted: 'the agent did not act', unclear: 'still unclear' };

export function transcriptMarkdown(t: TranscriptSource): string {
  const { room, seats } = t, people = { ...t.people };
  const position = new Map<string, number>(), turns = new Map<string, number>(), requests = new Map<string, number>();
  const members = new Map((t.members ?? []).map((m) => [String(m.id), String(m.displayName)]));
  const interactions = new Map((t.interactions ?? []).map((i) => [String(i.id), i]));
  for (const e of t.events) {
    const d = record(e.data);
    position.set(String(e.id), Number(e.seq));
    if (e.type === 'turn.queued') turns.set(String(d.id), Number(e.seq));
    if (e.type === 'permission.requested') requests.set(String(d.id), Number(e.seq));
    if (e.type === 'membership.pending' && typeof d.displayName === 'string') {
      members.set(String(d.memberId), d.displayName);
      people[String(e.actorId)] ??= d.displayName;
    }
  }
  const seatLabel = (s: ToolArgs) => (inline(s.name) || 'Unnamed') + ' (' +
    (typeof s.product === 'string' && isProduct(s.product) ? PRODUCT_PROFILES[s.product].label : inline(s.product)) + ' seat)';
  const person = (id: unknown) => typeof id === 'string' && id === room.ownerId ? 'Owner'
    : people[String(id)] ? inline(people[String(id)]) + ' (member)' : undefined;
  const seatName = (id: unknown) => {
    const s = seats.find((x) => x.id === id);
    return s ? seatLabel(s) : person(id) ?? 'Participant';
  };
  const actorName = (id: unknown) => {
    const s = seats.find((x) => x.principalId === id);
    return id === 'runtime' ? 'Runtime' : person(id) ?? (s ? seatLabel(s) : 'Participant');
  };
  const ref = (id: unknown) => (position.has(String(id)) ? '#' + position.get(String(id)) : 'an earlier event');
  const turn = (id: unknown) => turns.has(String(id)) ? 'the turn requested in #' + turns.get(String(id)) : 'turn ' + code(String(id).slice(0, 8));
  const request = (id: unknown) => requests.has(String(id)) ? 'request #' + requests.get(String(id)) : 'request ' + code(String(id).slice(0, 8));
  const member = (id: unknown) => (members.has(String(id)) ? inline(members.get(String(id))) : 'a member');
  const interaction = (id: unknown) => interactions.get(String(id));
  const mention = (id: unknown, done: string) => {
    const i = interaction(id);
    return i ? `${done} the ${inline(i.intent)} in ${ref(i.messageId)}` : `${done} a mention`;
  };
  const obligations = (d: ToolArgs) => items(d.unresolved).length ? [plural(items(d.unresolved).length, 'open obligation') + ' at the time.'] : [];
  const list = (label: string, values: unknown[]) => values.length
    ? [label + ':\n\n' + values.map((v) => '- ' + inline(typeof v === 'string' ? v : JSON.stringify(v))).join('\n')] : [];
  const outcome = (d: ToolArgs, expiry: boolean) => [
    request(d.requestId), d.action ? ' (' + inline(String(d.action).replaceAll('_', ' ')) + ')' : '',
    d.scopeDigest ? ', scope digest ' + code(d.scopeDigest) : '', expiry && d.expiresAt ? ', valid until ' + time(d.expiresAt) : '',
  ].join('');
  const SYSTEM: Record<string, (d: ToolArgs) => string> = {
    'room.created': () => 'Room opened.',
    'seat.joined': (d) => `${seatLabel(d)} joined as a ${d.mode === 'managed' ? 'managed' : 'polling'} ${inline(d.role)}.`,
    'seat.left': (d) => `${seatName(d.seatId)} left the room.`,
    'seat.consent': (d) => d.consent === true ? `Turn requests allowed for ${seatName(d.seatId)}.` : `Turn requests turned off for ${seatName(d.seatId)}.`,
    'room.paused': () => 'Room paused; new dispatch is blocked.',
    'room.open': () => 'Room resumed.',
    'room.closed': () => 'Room closed.',
    'policy.changed': (d) => end(`Limits changed to policy version ${Number(d.version)}` +
      (d.previousVersion !== undefined ? ` from ${Number(d.previousVersion)}` : '') +
      (Object.keys(record(d.policy)).length ? ': ' + Object.entries(record(d.policy)).map(([k, v]) => inline(k) + ' ' + inline(v)).join(', ') : '')),
    'host.transferred': (d) => `Host role transferred to ${seatName(d.seatId)}.`,
    'interaction.read': (d) => end(mention(d.interactionId, 'Read')),
    'interaction.responded': (d) => end(mention(d.interactionId, 'Answered') + (d.responseId ? ' with ' + ref(d.responseId) : '')),
    'interaction.resolved': (d) => end(mention(d.interactionId, 'Resolved')),
    'turn.queued': (d) => `Turn requested for ${seatName(d.seatId)}.`,
    'turn.dispatching': (d) => `Dispatch committed for ${turn(d.turnId)}.`,
    'turn.started': (d) => `${capital(turn(d.turnId))} started${d.externalPolling ? ', claimed by a polling agent' : ''}.`,
    'turn.completed': (d) => `${capital(turn(d.turnId))} completed.`,
    'turn.failed': (d) => reason(`${capital(turn(d.turnId))} failed`, d.error),
    'turn.cancelled': (d) => `${capital(turn(d.turnId))} was cancelled.`,
    'turn.uncertain': (d) => reason(`${capital(turn(d.turnId))} is uncertain`, d.error),
    'turn.cancel_requested': (d) => `Cancellation requested for ${turn(d.turnId)}.`,
    'turn.inspected': (d) => `${capital(turn(d.turnId))} was inspected: ${FINDINGS[String(d.finding)] ?? 'finding recorded'}.`,
    'permission.granted': (d) => `Approved ${outcome(d, true)}.`,
    'permission.denied': (d) => `Denied ${outcome(d, false)}.`,
    'permission.cancelled': (d) => `${capital(request(d.requestId))} was cancelled.`,
    'permission.expired': (d) => `${capital(request(d.requestId))} expired unanswered.`,
    'membership.invited': (d) => `Invited ${inline(d.displayName)} as ${inline(d.role)}; the invitation expires ${time(d.expiresAt)}.`,
    'membership.pending': (d) => `${inline(d.displayName)} accepted an invitation; confirmation is pending until ${time(d.expiresAt)}.`,
    'membership.confirmed': (d) => `Membership confirmed for ${member(d.memberId)} as ${inline(d.role)}, generation ${Number(d.generation)}.`,
    'membership.revoked': (d) => `Membership revoked for ${member(d.memberId)}, generation ${Number(d.generation)}.`,
    'membership.recovery_pending': (d) => `Identity recovery started for ${member(d.memberId)}; pending until ${time(d.expiresAt)}.`,
    'invitation.revoked': () => 'An invitation was revoked.',
    'owner.consent_changed': (d) => `${seatName(d.seatId)} may take turns requested by ${plural(items(d.allowedSenderOwnerIds).length, 'owner')}, up to ` +
      `${plural(Number(d.maxTurns), 'turn')} of ${duration(d.maxTurnMs)}.`,
    'artefact.shared': (d) => `Shared ${inline(d.name)} (${inline(d.mimeType)}, ${Number(d.bytes)} bytes, digest ${code(d.digest)}).`,
    'tasks.planned': (d) => `Tasks planned: ${items(d.taskIds).map(inline).join(', ')}.`,
    'task.claimed': (d) => `Task ${inline(d.taskId)} claimed by attempt ${code(String(d.attemptId).slice(0, 8))}, generation ${Number(d.generation)}.`,
    'task.submitted': (d) => `Submission recorded with result ${code(d.resultDigest)}.`,
    'verification.completed': (d) => `Checks ${d.status === 'passing' ? 'passed' : d.status === 'blocked' ? 'were blocked' : 'failed'} on content ${code(d.contentDigest)}.`,
    'review.submitted': (d) => reason(d.verdict === 'accept' ? 'Review accepted the work' : 'Review requested rework', d.reason),
    'candidate.prepared': (d) => `Combined candidate prepared (${inline(d.status)}) with result ${code(d.resultDigest)}.`,
    'candidate.accepted': (d) => `Final candidate accepted with result ${code(d.resultDigest)}.`,
    'candidate.applied': (d) => `Candidate applied to the checkout with result ${code(d.resultDigest)}.`,
    'attempt.release_requested': (d) => reason(`Release requested for attempt ${code(String(d.attemptId).slice(0, 8))}`, d.reason),
    'attempt.released': (d) => `Attempt ${code(String(d.attemptId).slice(0, 8))} released; its workspace is preserved.`,
    'command.cleared': (d) => `Interrupted ${inline(d.command)} cleared; its client key can run again.`,
    'bridge.authorized': (d) => `Room connection approved for a participant bridge, membership generation ${Number(d.generation)}.`,
    'bridge.revoked': () => 'Room connection revoked for a participant bridge.',
    'bridge.cleanup_needed': (d) => `A managed credential file for ${turn(d.turnId)} needs cleanup.`,
    'remote.connected': (d) => `Connected to the shared room for ${d.mode === 'managed' ? 'managed discussion' : 'polling'}.`,
    'remote.managed_enabled': (d) => `Managed discussion enabled: up to ${plural(Number(d.maxTurns), 'turn')} of ${duration(d.maxTurnMs)}.`,
    'remote.proposal_accepted': () => 'Turn proposal accepted; local approval is still required.',
    'remote.proposal_declined': () => 'Turn proposal declined.',
    'remote.disconnected': () => 'Disconnected locally; remote revocation is not confirmed.',
  };
  const describe = (e: ToolArgs): Entry => {
    const d = record(e.data), actor = actorName(e.actorId);
    if (d.omittedForSize === true) return `Content omitted for size (${Number(d.bytes)} bytes).`;
    if (e.type === 'message') {
      const reply = interaction(d.replyToId), mentions = items(d.mentions).map(record);
      return { title: seatName(d.senderId) + (reply ? ' · reply to ' + ref(reply.messageId) : ''), body: [fenced(d.text),
        ...(mentions.length ? ['Mentions ' + mentions.map((m) => `${seatName(m.seatId)} (${inline(m.intent)})`).join(', ') + '.'] : [])] };
    }
    if (e.type === 'agenda') return { title: actor + ' · agenda', body: [fenced(d.agenda), ...obligations(d)] };
    if (e.type === 'decision') return { title: actor + ' · decision proposed', body: [fenced(d.decision),
      ...list('Positions', items(d.positions)), ...list('Dissent', items(d.dissent)), ...list('Evidence', items(d.evidence)), ...obligations(d)] };
    if (e.type === 'turn.queued' && typeof d.prompt === 'string')
      return { title: actor + ' · turn requested for ' + seatName(d.seatId), body: [fenced(d.prompt)] };
    if (e.type === 'permission.requested') return { title: actor + ' · approval requested', body: [
      end(capital(inline(String(d.action ?? '').replaceAll('_', ' '))) + ': ' + inline(d.summary)),
      `Scope digest ${code(d.scopeDigest)}, expires ${time(d.expiresAt)}.`, fenced(JSON.stringify(d.scope ?? {}, null, 2), 'json')] };
    return SYSTEM[String(e.type)]?.(d) ?? end(capital(inline(String(e.type).replace(/[._]/g, ' '))));
  };
  const out = ['# ' + (inline(room.title) || 'Untitled room'), ''];
  if (room.objective) out.push('Objective: ' + inline(room.objective), '');
  out.push(...t.provenance.map((line) => '- ' + line), '');
  if (t.artefacts?.length) out.push('## Shared artefacts', '', ...t.artefacts.map((a) => `- ${inline(a.name)}, ${Number(a.bytes)} bytes, digest ${code(a.digest)}, ` +
    code('converoom://rooms/' + String(room.id) + '/artefacts/' + String(a.id))), '');
  out.push('## Events', '');
  if (!t.events.length) out.push('No events in this range.', '');
  for (const e of t.events) {
    const entry = describe(e), head = '#' + Number(e.seq) + ' · ' + time(e.at);
    if (typeof entry === 'string') out.push(`**${head}** · ${actorName(e.actorId)} · ${entry}`, '');
    else out.push(`### ${head} · ${entry.title}`, '', ...entry.body.flatMap((p) => [p, '']));
  }
  return out.join('\n').trimEnd() + '\n';
}

export interface RoomExport {
  schemaVersion: number;
  digest: string;
  records: { kind: string; id: string; value: ToolArgs }[];
  events: ToolArgs[];
}
export function exportTranscript(exported: RoomExport, at = Date.now()): string {
  const values = (kind: string) => exported.records.filter((r) => r.kind === kind).map((r) => r.value);
  const room = values('room')[0] ?? {}, events = exported.events;
  return transcriptMarkdown({ room, events, seats: values('seat'), interactions: values('interaction'), provenance: [
    `Room ${code('converoom://rooms/' + String(room.id))}, ${inline(room.status)}, policy version ${Number(room.policyVersion)}`,
    events.length ? `Events #${Number(events[0].seq)} to #${Number(events.at(-1)!.seq)}, the room's full history` : 'No events recorded',
    `Exported ${time(at)} as Converoom transcript format ${TRANSCRIPT_FORMAT}, from export schema ${Number(exported.schemaVersion)} with digest ${code(exported.digest)}`,
    'Message, agenda and decision text appears in fenced blocks as recorded after credential redaction. ' +
      'The JSON export holds every recorded field and is the one that can be restored',
  ] });
}
