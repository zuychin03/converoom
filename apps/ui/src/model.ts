import { isRecord, list, string, type RecordData, type Snapshot } from './api.js';
import { isManagedProduct } from '../../../packages/shared/src/products.js';

export type Kind = 'live' | 'needs' | 'ok' | 'warn' | 'fail' | 'idle' | 'paused' | 'closed';
export type Intent = 'question' | 'review' | 'challenge';
export const INTENTS: Intent[] = ['question', 'review', 'challenge'];

export const num = (record: RecordData, key: string) =>
  typeof record[key] === 'number' ? (record[key] as number) : undefined;
export const data = (record: RecordData): RecordData =>
  isRecord(record.data) ? record.data : {};
export const pad = (value: number) => String(value).padStart(3, '0');
export const shortId = (id: string, length = 4) =>
  id.replace(/-/g, '').slice(0, length).toUpperCase();

export function fmtDuration(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
export function fmtBytes(bytes: number) {
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes, unit = -1;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return unit < 0 ? `${bytes} bytes` : `${value.toFixed(1)} ${units[unit]}`;
}
export const fmtClock = (at: number) =>
  new Date(at).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit' });

// FNV-1a keeps a seat's code stable across sessions without storing it.
export function seatCode(id: string): number[] {
  let hash = 2166136261;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return [0, 1, 2, 3].map((i) => ((hash >>> (i * 5)) & 3) + 1);
}

export const ACTIVE_TURN = ['dispatching', 'running', 'cancelling'];
export const OPEN_TURN = ['queued', ...ACTIVE_TURN];

export const roomEvents = (state: Snapshot, roomId: string) =>
  state.events
    .filter((event) => event.roomId === roomId)
    .sort((a, b) => (num(a, 'seq') ?? 0) - (num(b, 'seq') ?? 0));

// The server sends one page of the selected room's events; pages loaded earlier go before it. Once new events move that
// page past them they would leave a gap, so they are dropped until loaded again.
export function withEarlier(state: Snapshot, earlier?: { roomId: string; events: RecordData[] }): Snapshot {
  const first = earlier ? num(roomEvents(state, earlier.roomId)[0] ?? {}, 'seq') : undefined;
  if (!earlier || first === undefined) return state;
  const kept = earlier.events.filter((event) => (num(event, 'seq') ?? 0) < first);
  if (!kept.length || Math.max(...kept.map((event) => num(event, 'seq') ?? 0)) < first - 1) return state;
  return { ...state, events: [...kept, ...state.events] };
}

export function liveRoomId(state: Snapshot) {
  return state.rooms
    .filter((room) => room.status !== 'closed')
    .map((room) => ({ id: string(room, 'id'), at: Math.max(num(room, 'lastEventAt') ?? 0, num(room, 'createdAt') ?? 0) }))
    .sort((a, b) => b.at - a.at)[0]?.id;
}

export const roomSeats = (state: Snapshot, roomId: string) =>
  state.seats.filter((seat) => seat.roomId === roomId && seat.status !== 'left');

export const pendingPermissions = (state: Snapshot, now: number, roomId?: string) =>
  state.permissions.filter(
    (p) =>
      p.status === 'pending' &&
      (num(p, 'expiresAt') ?? 0) > now &&
      (!roomId || p.roomId === roomId),
  );

export const agentWaitEnds = (permission: RecordData) => {
  const expires = num(permission, 'expiresAt');
  return permission.action === 'vendor_tool' ? expires : undefined;
};

const FAILURE_REASONS: Record<string, string> = {
  quota_exhausted: 'quota',
  authentication: 'sign-in',
  subscription_required: 'sign-in',
  turn_timeout: 'timed out',
  worker_binding: 'workspace',
  budget: 'budget',
  budget_exhausted: 'budget',
};
const withReason = (base: string, turn: RecordData) =>
  FAILURE_REASONS[string(turn, 'failure')] ? base + ' · ' + FAILURE_REASONS[string(turn, 'failure')] : base;
export const failureLabel = (turn: RecordData) => withReason('Failed', turn);
export const FINDINGS: Record<string, string> = { acted: 'agent acted', not_acted: 'agent did not act', unclear: 'still unclear' };

export interface SeatState {
  kind: Kind;
  label: string;
  since?: number;
  turn?: RecordData;
}

export function seatState(seat: RecordData, state: Snapshot, now: number): SeatState {
  if (seat.status === 'left') return { kind: 'closed', label: 'Left' };
  const turns = state.turns
    .filter((turn) => turn.seatId === seat.id)
    .sort((a, b) => (num(b, 'createdAt') ?? 0) - (num(a, 'createdAt') ?? 0));
  const active = turns.find((turn) => ACTIVE_TURN.includes(string(turn, 'status')));
  if (active) {
    if (active.status === 'cancelling') return { kind: 'warn', label: 'Cancelling', turn: active };
    if (active.status === 'dispatching') return { kind: 'live', label: 'Starting', turn: active };
    return {
      kind: 'live',
      label: 'Running',
      since: num(active, 'startedAt') ?? num(active, 'createdAt'),
      turn: active,
    };
  }
  if (seat.status === 'degraded') return { kind: 'warn', label: 'Stop not confirmed' };
  const queued = turns.find((turn) => turn.status === 'queued');
  if (queued) {
    if (seat.mode !== 'managed') return { kind: 'idle', label: 'Turn in inbox', turn: queued };
    const request = state.permissions.find((p) => p.id === queued.permissionRequestId);
    if (request?.status === 'pending' && (num(request, 'expiresAt') ?? 0) > now)
      return { kind: 'needs', label: 'Needs your approval', turn: queued };
    return { kind: 'idle', label: seat.consent ? 'Queued' : 'Queued · requests off', turn: queued };
  }
  const last = turns[0];
  if (last?.status === 'uncertain' && !isRecord(last.inspection)) return { kind: 'warn', label: withReason('Uncertain turn', last), turn: last };
  if (last?.status === 'failed') return { kind: 'fail', label: failureLabel(last), turn: last };
  if (seat.mode !== 'managed') return { kind: 'idle', label: 'Polling inbox' };
  if (!turnTarget(seat)) return { kind: 'idle', label: seat.role === 'observer' ? 'Observing' : 'Turns unavailable' };
  return { kind: 'idle', label: seat.consent ? 'Ready' : 'Requests off' };
}

export function visibleTurn(state: Snapshot, roomId: string, queued: RecordData): RecordData {
  const current = state.turns.find((t) => t.id === queued.id && t.roomId === roomId);
  if (current) return current;
  const lifecycle = roomEvents(state, roomId).filter((e) => data(e).turnId === queued.id &&
    ['turn.started', 'turn.completed', 'turn.failed', 'turn.cancelled', 'turn.uncertain'].includes(string(e, 'type'))).at(-1);
  return { ...queued, status: lifecycle ? string(lifecycle, 'type').replace('turn.', '').replace('started', 'running') : 'unavailable' };
}

export function turnKind(turn: RecordData, state: Snapshot, now: number): { kind: Kind; label: string } {
  const status = string(turn, 'status');
  if (status === 'unavailable') return { kind: 'idle', label: 'Current status unavailable' };
  if (status === 'running') return { kind: 'live', label: 'Running' };
  if (status === 'dispatching') return { kind: 'live', label: 'Starting' };
  if (status === 'cancelling') return { kind: 'warn', label: 'Cancelling' };
  if (status === 'completed') return { kind: 'ok', label: 'Completed' };
  if (status === 'failed') return { kind: 'fail', label: failureLabel(turn) };
  if (status === 'cancelled') return { kind: 'closed', label: 'Cancelled' };
  if (status === 'uncertain') {
    const finding = isRecord(turn.inspection) ? FINDINGS[string(turn.inspection, 'finding')] : undefined;
    return finding ? { kind: 'closed', label: 'Uncertain · inspected, ' + finding } : { kind: 'warn', label: withReason('Uncertain', turn) };
  }
  const seat = state.seats.find((s) => s.id === turn.seatId);
  if (seat && seat.mode !== 'managed') return { kind: 'idle', label: 'In seat inbox' };
  const request = state.permissions.find((p) => p.id === turn.permissionRequestId);
  if (request?.status === 'pending' && (num(request, 'expiresAt') ?? 0) > now)
    return { kind: 'needs', label: 'Needs your approval' };
  if (request?.status === 'denied') return { kind: 'closed', label: 'Denied' };
  return { kind: 'idle', label: 'Queued' };
}

const TURN_END = ['turn.completed', 'turn.failed', 'turn.cancelled', 'turn.uncertain'];

export function turnTiming(turn: RecordData, room: RecordData, state: Snapshot) {
  const started = num(turn, 'startedAt');
  const attempt = turn.attemptId
    ? state.attempts.find((a) => a.id === turn.attemptId)
    : undefined;
  const policy = isRecord(room.policy) ? room.policy : {};
  const budget =
    attempt && started
      ? Math.min(1800000, (num(attempt, 'wallDeadline') ?? started + 1800000) - started)
      : (num(policy, 'maxTurnMs') ?? 600000);
  const ending = state.events.find(
    (event) => TURN_END.includes(string(event, 'type')) && data(event).turnId === turn.id,
  );
  const ended = num(turn, 'completedAt') ?? (ending ? num(ending, 'at') : undefined);
  return { started, ended, budget, active: ACTIVE_TURN.includes(string(turn, 'status')) };
}

export function activity(
  state: Snapshot,
  room: RecordData,
  seats: RecordData[],
  bins: number,
  now: number,
) {
  const events = roomEvents(state, string(room, 'id'));
  const start = num(room, 'createdAt') ?? num(events[0] ?? {}, 'at') ?? now;
  const end = Math.max(now, start + 60000);
  const turnSeat = new Map(state.turns.map((turn) => [string(turn, 'id'), string(turn, 'seatId')]));
  const bySeat = new Map(seats.map((seat, i) => [string(seat, 'id'), i]));
  const byPrincipal = new Map(seats.map((seat, i) => [string(seat, 'principalId'), i]));
  const counts = seats.map(() => new Array<number>(bins).fill(0));
  for (const event of events) {
    const type = string(event, 'type');
    const d = data(event);
    const index =
      type === 'message'
        ? bySeat.get(string(d, 'senderId'))
        : type.startsWith('turn.')
          ? (bySeat.get(string(d, 'seatId')) ?? bySeat.get(turnSeat.get(string(d, 'turnId')) ?? ''))
          : byPrincipal.get(string(event, 'actorId'));
    if (index === undefined) continue;
    const at = num(event, 'at') ?? start;
    const bin = Math.min(bins - 1, Math.max(0, Math.floor(((at - start) / (end - start)) * bins)));
    counts[index][bin] += 1;
  }
  return { counts, start, end, total: events.length };
}

export const STAGES = [
  'Planned',
  'Claimed',
  'Coding',
  'Submitted',
  'Checked',
  'Accepted',
  'Candidate',
  'Applied',
] as const;

export function taskProgress(task: RecordData, state: Snapshot) {
  const attempt = state.attempts
    .filter((a) => a.taskId === task.id && a.roomId === task.roomId)
    .sort((a, b) => (num(b, 'generation') ?? 0) - (num(a, 'generation') ?? 0))[0];
  const manifest = task.manifestId
    ? state.manifests.find((m) => m.id === task.manifestId)
    : undefined;
  const verifications = manifest
    ? state.verifications.filter((v) => v.manifestId === manifest.id)
    : [];
  const passing = verifications.some((v) => v.status === 'passing');
  const candidate = manifest
    ? state.candidates.find(
        (c) => list(c, 'manifestIds').includes(string(manifest, 'id')) && c.status !== 'stale',
      )
    : undefined;
  const status = string(task, 'status');
  let stage = 0;
  if (status === 'provisioning' || status === 'claimed')
    stage = attempt && ['running', 'completed'].includes(string(attempt, 'status')) ? 2 : 1;
  if (status === 'submitted') stage = passing ? 4 : 3;
  if (status === 'accepted')
    stage = candidate ? (candidate.status === 'applied' ? 7 : 6) : 5;
  return { stage, attempt, manifest, verifications, passing, candidate };
}

export function acceptedOrder(state: Snapshot, roomId: string): string[] {
  const tasks = state.tasks.filter(
    (t) => t.roomId === roomId && t.status === 'accepted' && typeof t.manifestId === 'string',
  );
  const byId = new Map(tasks.map((t) => [string(t, 'id'), t]));
  const seen = new Set<string>();
  const order: string[] = [];
  const visit = (task: RecordData) => {
    const id = string(task, 'id');
    if (seen.has(id)) return;
    seen.add(id);
    for (const dep of list(task, 'dependsOn')) {
      const prerequisite = byId.get(dep);
      if (prerequisite) visit(prerequisite);
    }
    order.push(string(task, 'manifestId'));
  };
  tasks.forEach(visit);
  return order;
}

const COMMAND_LABELS: Record<string, string> = {
  repo_register: 'Register repository',
  task_claim: 'Claim task',
  task_submit: 'Submit work',
  verification_request: 'Run checks',
  integration_prepare: 'Prepare candidate',
  candidate_apply: 'Apply candidate',
  attempt_release: 'Release reservation',
};
export const commandLabel = (command: string) => COMMAND_LABELS[command] ?? command.replaceAll('_', ' ');
const requestRoom = (entry: RecordData) => (isRecord(entry.args) ? string(entry.args, 'roomId') : '');
// Commands without a room, such as repository registration, belong to every room's view.
export const interruptedFor = (state: Snapshot, roomId: string) =>
  state.interruptedCommands.filter((entry) => !roomId || !requestRoom(entry) || requestRoom(entry) === roomId);
export const requestDetails = (args: unknown, roomId: string) =>
  Object.entries(isRecord(args) ? args : {})
    .filter(([key, value]) => !(key === 'roomId' && value === roomId))
    .map(([key, value]) => key + ' ' + (Array.isArray(value) ? value.join(', ') : String(value)))
    .join(' · ');
// Mirrors turn_request and task_claim admission: observers never take turns, and a managed seat needs a managed adapter.
export const turnTarget = (seat: RecordData) =>
  seat.role !== 'observer' && seat.status !== 'left' && (seat.mode !== 'managed' || isManagedProduct(string(seat, 'product')));
export const workerSeat = (seat: RecordData) => seat.mode === 'managed' && turnTarget(seat);
export function capabilityLine(seat: RecordData) {
  const capabilities = isRecord(seat.capabilities) ? seat.capabilities : {};
  const named = (key: string, empty: string) => list(capabilities, key).join(', ') || empty;
  return `Declared ${named('declared', 'none')} · probed ${named('probed', 'not yet')} · tested ${named('tested', 'not yet')}`;
}
const clip = (id: string) => (id.length > 12 ? id.slice(0, 12) + '…' : id);
// Native tools can bypass room checks, so a managed session is labelled advisory rather than contained.
export function turnEvidence(turn: RecordData, state: Snapshot): [string, string][] {
  const seat = state.seats.find((s) => s.id === turn.seatId), status = string(turn, 'status');
  if (seat?.mode !== 'managed') return [['Native session', 'External conversation, outside runtime control']];
  const dispatched = num(turn, 'dispatchBoundaryAt'), stopped = num(turn, 'sessionStoppedAt'), cancel = num(turn, 'cancelRequestedAt');
  const rows: [string, string][] = [['Dispatch', dispatched ? 'Committed ' + fmtClock(dispatched) : OPEN_TURN.includes(status) ? 'Not yet' : 'Never committed, so known not sent']];
  if (typeof turn.sessionId === 'string')
    rows.push(['Native session', clip(turn.sessionId) + ' · ' + (stopped ? 'stop confirmed ' + fmtClock(stopped) : ACTIVE_TURN.includes(status) ? 'running' : 'stop not confirmed')]);
  if (typeof turn.failure === 'string') rows.push(['Outcome code', turn.failure]);
  if (cancel) rows.push(['Cancel requested', fmtClock(cancel)]);
  const answer = state.events.find((e) => e.id === turn.responseEventId);
  if (answer) rows.push(['Posted answer', 'Entry ' + pad(num(answer, 'seq') ?? 0)]);
  rows.push(['Containment', 'Trusted local and advisory, not a sandbox']);
  return rows;
}
