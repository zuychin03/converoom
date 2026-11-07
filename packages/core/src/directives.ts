import { randomUUID } from 'node:crypto';
import {
  ConveroomError as E,
  ENDED_ROOMS,
  requiredString as str,
  type Actor,
  type Core,
  type Room,
  type Seat,
  type Store,
  type ToolArgs,
  type Turn,
} from '../../shared/src/contracts.js';
import { redactPublic } from '../../store/src/index.js';
import { authority } from './audit.js';
import { currentSeat } from './membership.js';
import type { Permission } from './index.js';

const DIRECTIVE_BYTES = 2000, ACTIVE_LIMIT = 20;
// Converoom tools whose results can carry directives to a seat in the middle of its turn.
export const DIRECTIVE_TOOLS = new Set(['room_read', 'room_wait', 'room_inbox', 'task_heartbeat']);
type Delivery = { state: 'queued' | 'delivered' | 'applied'; at?: number; turnId?: string; via?: string };
export interface Directive {
  id: string;
  roomId: string;
  text: string;
  mode: 'steer_next' | 'inject_mid_turn' | 'interrupt_and_amend';
  threadId: string | null;
  seatIds: string[];
  createdBy: string;
  ownerId: string;
  createdAt: number;
  status: 'active' | 'done' | 'cleared';
  delivery: Record<string, Delivery>;
  turnId?: string;
  rollback?: number;
  continuationTurnId?: string;
  note?: string;
}
const pendingFor = (store: Store, roomId: string, seatId: string) =>
  store.list<Directive>('directive', { roomId, status: ['active'] })
    .filter((d) => d.delivery[seatId]?.state === 'queued').sort((p, q) => p.createdAt - q.createdAt);
// FR-65: each targeted seat receives a directive once; when every seat has it, it is done.
function deliver(store: Store, d: Directive, seatId: string, update: Delivery) {
  const delivery = { ...d.delivery, [seatId]: update };
  store.put('directive', d.id, { ...d, delivery,
    status: Object.values(delivery).some((v) => v.state === 'queued') ? d.status : 'done' });
  store.append(d.roomId, 'directive.delivered', 'runtime', { directiveId: d.id, seatId, state: update.state,
    ...(update.via ? { via: update.via } : {}), ...(update.turnId ? { turnId: update.turnId } : {}) });
}
const view = (d: Directive) => ({ id: d.id, text: d.text, mode: d.mode, issuedAt: d.createdAt, from: 'room owner' });
// Only the runtime fills ownerDirectives, from records an authenticated person created; room text never reaches this field.
export function withDirectives(store: Store, a: Actor, roomId: string, tool: string, result: ToolArgs): ToolArgs {
  const seat = store.list<Seat>('seat', { roomId }).find((s) => s.principalId === a.principalId && s.status !== 'left');
  if (!seat) return result;
  // A managed seat receives steer-next directives at its next dispatch; on tool results it gets only mid-turn ones.
  const due = pendingFor(store, roomId, seat.id).filter((d) => d.mode === 'inject_mid_turn' || seat.mode !== 'managed');
  if (!due.length) return result;
  for (const d of due) deliver(store, d, seat.id, { state: 'delivered', at: Date.now(), via: tool });
  return { ...result, ownerDirectives: due.map(view) };
}
// Directives a dispatched turn carries in its pinned layer; the runtime marks them applied once the prompt is built.
export function turnDirectives(store: Store, t: Turn) {
  return pendingFor(store, t.roomId, t.seatId).filter((d) => d.mode !== 'interrupt_and_amend' && (d.threadId === null || d.threadId === t.threadId));
}
export function applyDirectives(store: Store, t: Turn, directives: Directive[]) {
  for (const d of directives) {
    const current = store.get<Directive>('directive', d.id);
    if (current?.delivery[t.seatId]?.state === 'queued') deliver(store, current, t.seatId, { state: 'applied', at: Date.now(), turnId: t.id });
  }
}
export function mountDirectives(c: Core, turns: {
  queue: (a: Actor, r: Room, s: Seat, x: ToolArgs) => Turn;
  grant: (a: Actor, p: Permission) => void;
}) {
  const { store } = c;
  const authorise = (a: Actor, r: Room) => {
    if (a.kind !== 'human') throw new E('human_required', 'Only a person can barge in', 403);
    c.requireOwner(a, r.id);
    if (ENDED_ROOMS.includes(r.lifecycle)) throw new E('inactive', 'The room has ended', 409);
    if (store.count('directive', { roomId: r.id, status: ['active'] }) >= ACTIVE_LIMIT)
      throw new E('directive_limit', 'Too many directives are still waiting to be delivered', 409);
  };
  const issue = (a: Actor, r: Room, text: string, mode: Directive['mode'], threadId: string | null, seatIds: string[], extra: Partial<Directive> = {}) => {
    const d: Directive = { id: randomUUID(), roomId: r.id, text, mode, threadId, seatIds, createdBy: a.principalId, ownerId: a.ownerId,
      createdAt: Date.now(), status: 'active', delivery: Object.fromEntries(seatIds.map((id) => [id, { state: 'queued' }])), ...extra };
    store.put('directive', d.id, d);
    authority(store, a, r, 'directive.issued', { directiveId: d.id, text, mode, threadId, seatIds, ...(d.turnId ? { turnId: d.turnId } : {}) });
    return d;
  };
  c.register('room_barge_in', (a, x) => store.transaction(() => {
    const r = c.requireRoom(a, str(x, 'roomId'));
    const mode = x.mode === undefined ? 'steer_next' : x.mode;
    if (mode !== 'steer_next' && mode !== 'inject_mid_turn')
      throw new E('invalid_argument', 'Choose steer_next or inject_mid_turn; use turn_amend to interrupt a turn');
    const thread = x.threadId === undefined ? undefined : store.get<ToolArgs>('thread', str(x, 'threadId'));
    if (x.threadId !== undefined && thread?.roomId !== r.id) throw new E('not_found', 'Thread not found', 404);
    const eligible = store.list<Seat>('seat', { roomId: r.id }).filter((s) => s.role !== 'observer' && currentSeat(store, r, s));
    const requested = x.seatIds === undefined ? undefined : x.seatIds;
    if (requested !== undefined && (!Array.isArray(requested) || !requested.length || requested.length > 10 ||
      requested.some((id) => !eligible.some((s) => s.id === id))))
      throw new E('invalid_argument', 'Choose up to ten active seats in this room');
    const scoped = Array.isArray(thread?.seatIds) && thread.seatIds.length ? thread.seatIds as string[] : undefined;
    const seatIds = (requested as string[] | undefined) ?? eligible.filter((s) => !scoped || scoped.includes(s.id)).map((s) => s.id);
    if (!seatIds.length) throw new E('invalid_argument', 'No seat to direct');
    authorise(a, r);
    return issue(a, r, redactPublic(str(x, 'text', DIRECTIVE_BYTES)).trim(), mode, (thread?.id as string | undefined) ?? null, seatIds);
  }));
  c.register('turn_amend', (a, x) => store.transaction(() => {
    const r = c.requireRoom(a, str(x, 'roomId')), t = store.get<Turn>('turn', str(x, 'turnId'));
    if (!t || t.roomId !== r.id) throw new E('turn', 'Turn not found', 404);
    const seat = store.get<Seat>('seat', t.seatId)!;
    authorise(a, r);
    if (seat.mode !== 'managed' || t.remoteProposalId)
      throw new E('capability_unavailable', 'Converoom cannot interrupt this seat; send a directive instead', 409);
    if (!['dispatching', 'running'].includes(t.status)) throw new E('turn_state', 'Only a running managed turn can be interrupted', 409);
    if (store.list<Directive>('directive', { roomId: r.id, status: ['active'] }).some((d) => d.turnId === t.id))
      throw new E('turn_state', 'This turn is already being amended', 409);
    let rollback: number | undefined;
    if (x.rollback === true) {
      if (!t.attemptId) throw new E('invalid_argument', 'Only a coding turn can be rolled back');
      rollback = Number(store.get<ToolArgs>('attempt', t.attemptId)?.checkpointSeq ?? 0);
    } else if (x.rollback !== undefined && x.rollback !== false) throw new E('invalid_argument', 'rollback is true or false');
    const d = issue(a, r, redactPublic(str(x, 'text', DIRECTIVE_BYTES)).trim(), 'interrupt_and_amend', t.threadId ?? null, [seat.id],
      { turnId: t.id, ...(rollback !== undefined ? { rollback } : {}) });
    store.put('turn', t.id, { ...t, status: 'cancelling', cancelRequestedAt: Date.now(), amendDirectiveId: d.id });
    authority(store, a, r, 'turn.cancel_requested', { turnId: t.id, status: 'cancelling', directiveId: d.id });
    return d;
  }));
  c.register('directive_clear', (a, x) => store.transaction(() => {
    const r = c.requireRoom(a, str(x, 'roomId')), d = store.get<Directive>('directive', str(x, 'directiveId'));
    if (!d || d.roomId !== r.id || d.status !== 'active') throw new E('not_found', 'Active directive not found', 404);
    if (a.kind !== 'human' || (d.ownerId !== a.ownerId && r.ownerId !== a.ownerId)) throw new E('forbidden', 'Only its author or the room owner can clear it', 403);
    if (d.mode === 'interrupt_and_amend' && !d.note) throw new E('turn_state', 'The interrupted turn is still stopping', 409);
    store.put('directive', d.id, { ...d, status: 'cleared' });
    return authority(store, a, r, 'directive.cleared', { directiveId: d.id });
  }));
  // Called by the runtime, as the person who amended, once the interrupted turn's cancel and stop are confirmed.
  c.register('turn_amend_continue', (a, x) => store.transaction(() => {
    const d = store.get<Directive>('directive', str(x, 'directiveId'));
    if (!d || d.mode !== 'interrupt_and_amend' || d.status !== 'active' || d.note || a.kind !== 'human' || a.principalId !== d.createdBy)
      throw new E('not_found', 'Pending amendment not found', 404);
    const r = c.requireRoom(a, d.roomId), t = store.get<Turn>('turn', d.turnId!)!, seat = store.get<Seat>('seat', t.seatId)!;
    if (t.status !== 'cancelled') throw new E('turn_state', 'The interrupted turn has not stopped', 409);
    const prompt = 'Owner amendment (from the room owner; it takes precedence over the earlier task):\n' + d.text +
      '\n\nEarlier task, interrupted before it finished:\n' + t.prompt;
    const next = turns.queue(a, r, seat, { prompt, ...(t.attemptId ? { attemptId: t.attemptId } : {}),
      ...(t.threadId ? { threadId: t.threadId } : {}), ...(t.contextRefs ? { contextRefs: t.contextRefs.map((v) => v.ref) } : {}) });
    // The amendment the owner confirmed is the exact-scope approval for its continuation.
    turns.grant(a, store.get<Permission>('permission', next.permissionRequestId!)!);
    deliver(store, d, seat.id, { state: 'applied', at: Date.now(), turnId: next.id });
    store.put('directive', d.id, { ...store.get<Directive>('directive', d.id)!, continuationTurnId: next.id });
    authority(store, a, r, 'turn.amended', { directiveId: d.id, turnId: t.id, continuationTurnId: next.id });
    return store.get<Turn>('turn', next.id);
  }));
}
// An unconfirmed cancel leaves the amendment waiting as a steer-next directive until the owner inspects the turn.
export function holdAmendment(store: Store, directiveId: string, note: string) {
  const d = store.get<Directive>('directive', directiveId);
  if (d?.status === 'active' && d.mode === 'interrupt_and_amend') store.put('directive', d.id, { ...d, mode: 'steer_next', note });
}
