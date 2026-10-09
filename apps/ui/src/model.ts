import { isRecord, list, string, type RecordData, type Snapshot } from './api.js';

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

export function failureLabel(turn: RecordData) {
  const failure = string(turn, 'failure');
  if (failure === 'quota_exhausted') return 'Failed · quota';
  if (failure === 'authentication' || failure === 'subscription_required')
    return 'Failed · sign-in';
  if (failure === 'turn_timeout') return 'Failed · timed out';
  if (failure === 'worker_binding') return 'Failed · workspace';
  return 'Failed';
}

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
  if (last?.status === 'uncertain') return { kind: 'warn', label: 'Uncertain turn', turn: last };
  if (last?.status === 'failed') return { kind: 'fail', label: failureLabel(last), turn: last };
  if (seat.mode !== 'managed') return { kind: 'idle', label: 'Polling inbox' };
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
  if (status === 'uncertain') return { kind: 'warn', label: 'Uncertain' };
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
