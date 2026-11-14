import { randomUUID } from 'node:crypto';
import {
  ConveroomError as E,
  ENDED_ROOMS,
  requiredString as str,
  type Actor,
  type Core,
  type HumanMembership,
  type OwnerConsent,
  type Room,
  type Seat,
  type Store,
  type ToolArgs,
  type Turn,
} from '../../shared/src/contracts.js';
import { authority, installationAuthority } from './audit.js';
import { currentSeat, requireSeatOwner } from './membership.js';
import type { Directive } from './directives.js';
import type { Permission } from './index.js';

// FR-40: push bridges that can wake an attached session. Each stays off until the owner enables it.
export const PUSH_BRIDGES = { claude: 'Claude Code', opencode: 'OpenCode' } as const;
export type PushBridge = keyof typeof PUSH_BRIDGES;
// Gaps before each re-send of an unread wake, then how long the last one may stay unread before the seat falls back to polling.
// Claude Code folds a channel event that arrives mid-turn into that turn and does not act on it, so a re-send has to land when it is idle.
export const WAKE_RESENDS_MS: readonly number[] = [20000, 60000, 180000];
export const WAKE_GIVE_UP_MS = 180000;
// A daemon restart drops every wake stream, and live MCP processes reconnect with the same session ID.
export const SESSION_GRACE_MS = 60000;
// OpenCode holds a posted wake in the session's own inbox until its running turn ends, so it is posted once, never re-sent,
// and its inbox is polled until it leaves. A post with no answer by the timeout is presumed lost and posted again.
export const OPENCODE_POLL_MS = 5000;
export const OPENCODE_POST_TIMEOUT_MS = 30000;
export const OPENCODE_SESSION = /^ses_[A-Za-z0-9]{8,64}$/;

export interface Attachment {
  id: string;
  roomId: string;
  seatId: string;
  principalId: string;
  ownerId: string;
  bridge: PushBridge;
  sessionId: string;
  requestId: string;
  status: 'attached' | 'suspended';
  since: number;
  tested: boolean;
  check?: boolean;
  reason?: string;
  seenTurns?: string[];
  lastWakeAt?: number;
  wake?: {
    id: string; kind: WakeNotice['kind']; attempts: number; firstAt: number; lastAt: number;
    // OpenCode only: the inbox item the wake became, when it left the inbox, and when the inbox was last checked.
    inboxId?: string; deliveredAt?: number; polledAt?: number;
  };
}
export interface WakeNotice { sessionId: string; wakeId: string; roomId: string; seatId: string; kind: 'check' | 'room'; attempt: number }
export interface WakeSessions { connected(sessionId: string): boolean; lastSeen(sessionId: string): number | undefined; since: number }
export interface OpenCodeServerState { ready: boolean; failure?: string }
export type OpenCodeAction =
  | { type: 'post'; sessionId: string; wakeId: string; roomId: string; seatId: string; kind: WakeNotice['kind'] }
  | { type: 'poll'; sessionId: string; wakeId: string; seatId: string; inboxId: string }
  | { type: 'withdraw'; id: string; sessionId: string; inboxId: string };
export type Withdrawal = { id: string; sessionId: string; inboxId: string };
type Interaction = ToolArgs & { id: string; roomId: string; recipientId: string; senderId: string; status: string };

const RUNTIME = { principalId: 'runtime' };
const bridgeFor = (s: Seat): PushBridge | undefined => s.mode !== 'polling' ? undefined
  : s.product === 'claude' ? 'claude' : s.product === 'opencode' ? 'opencode' : undefined;
const enabled = (store: Store, bridge: string) => store.get<{ enabled?: boolean }>('push_bridge', bridge)?.enabled === true;

// A wake still waiting in an OpenCode inbox when it stops mattering is withdrawn on the next tick the server can take it.
function withdraw(store: Store, t: Attachment) {
  if (t.bridge === 'opencode' && t.wake?.inboxId && !t.wake.deliveredAt)
    store.put<Withdrawal>('opencode_withdrawal', t.wake.id, { id: t.wake.id, sessionId: t.sessionId, inboxId: t.wake.inboxId });
}
function end(store: Store, t: Attachment, reason: string, a: Pick<Actor, 'principalId'> = RUNTIME) {
  withdraw(store, t);
  store.remove('attachment', t.id);
  const r = store.get<Room>('room', t.roomId);
  if (r) authority(store, a, r, 'seat.attachment_ended', { seatId: t.seatId, bridge: t.bridge, reason });
}
function suspend(store: Store, t: Attachment, r: Room, reason: string) {
  withdraw(store, t);
  const next: Attachment = { ...t, status: 'suspended', reason };
  delete next.wake;
  store.put('attachment', t.id, next);
  authority(store, RUNTIME, r, 'seat.attachment_suspended', { seatId: t.seatId, bridge: t.bridge, reason });
}

// The seat's inbox read is the acknowledgement. Only the attached session's own read proves its wake works or brings push back.
// queuedTurns lists the queued turns an inbox read returned; a claim acknowledges without showing the agent any others.
export function noteInboxRead(store: Store, a: Actor, s: Seat, queuedTurns?: string[]) {
  const t = store.get<Attachment>('attachment', s.id);
  if (!t) return;
  const own = a.sessionId === t.sessionId, r = store.get<Room>('room', t.roomId)!;
  const next: Attachment = { ...t, ...(queuedTurns ? { seenTurns: queuedTurns } : {}) };
  withdraw(store, t);
  delete next.wake;
  if (own && t.wake?.kind === 'check') delete next.check;
  if (own && !t.tested && t.wake) {
    next.tested = true;
    authority(store, RUNTIME, r, 'seat.attachment_tested', { seatId: s.id, bridge: t.bridge });
  }
  if (own && t.status === 'suspended') {
    next.status = 'attached';
    delete next.reason;
    authority(store, RUNTIME, r, 'seat.attachment_resumed', { seatId: s.id, bridge: t.bridge });
  }
  store.put('attachment', t.id, next);
}

export function applyGrantedAttach(store: Store, a: Actor, p: Permission) {
  const r = store.get<Room>('room', p.roomId)!, s = store.get<Seat>('seat', String(p.scope.seatId));
  const bridge = String(p.scope.bridge);
  if (!s || s.roomId !== r.id || !currentSeat(store, r, s) || bridgeFor(s) !== bridge || ENDED_ROOMS.includes(r.lifecycle) ||
    store.get('revoked', s.principalId))
    throw new E('permission', 'The seat can no longer be attached', 409);
  if (!enabled(store, bridge)) throw new E('push_disabled', 'Turn on the push bridge with converoom bridge enable ' + bridge, 409);
  const previous = store.get<Attachment>('attachment', s.id);
  if (previous) end(store, previous, 'Another session of this seat was attached', a);
  store.put<Attachment>('attachment', s.id, { id: s.id, roomId: r.id, seatId: s.id, principalId: s.principalId, ownerId: s.ownerId,
    bridge, sessionId: String(p.scope.sessionId), requestId: p.id, status: 'attached', since: Date.now(), tested: false, check: true });
  authority(store, a, r, 'seat.attached', { seatId: s.id, bridge, requestId: p.id });
}

function senderOwner(store: Store, r: Room, senderId: string) {
  return store.get<Seat>('seat', senderId)?.ownerId ??
    store.list<HumanMembership>('human_membership', { roomId: r.id }).find((m) => m.principalId === senderId)?.ownerId ?? senderId;
}
// Mirrors peer wake for managed seats: agents wake a seat only under the room's peer-wake policy, and another owner needs consent.
function wakes(store: Store, r: Room, s: Seat, i: Interaction) {
  if (store.get<Seat>('seat', i.senderId) && r.policy.peerWake !== true) return false;
  const from = senderOwner(store, r, i.senderId);
  if (from === s.ownerId) return true;
  const consent = store.get<OwnerConsent>('owner_consent', s.id);
  return consent?.status === 'active' && consent.membershipGeneration === s.membershipGeneration && consent.allowedSenderOwnerIds.includes(from);
}
function due(store: Store, r: Room, s: Seat, t: Attachment) {
  return store.list<Interaction>('interaction', { roomId: r.id, status: ['stored'] }).some((i) => i.recipientId === s.id && wakes(store, r, s, i)) ||
    store.list<Turn>('turn', { seatId: s.id, status: ['queued'] }).some((v) => !t.seenTurns?.includes(v.id)) ||
    store.list<Directive>('directive', { roomId: r.id, status: ['active'] }).some((d) => d.delivery[s.id]?.state === 'queued');
}

function planOpenCode(store: Store, now: number, t: Attachment, r: Room, s: Seat, server: OpenCodeServerState, actions: OpenCodeAction[]) {
  if (!server.ready) {
    if (server.failure && t.status === 'attached') suspend(store, t, r, server.failure);
    return;
  }
  if (t.status !== 'attached' || !['draft', 'active'].includes(r.lifecycle)) return;
  const w = t.wake, clear = () => { const next: Attachment = { ...t }; delete next.wake; store.put('attachment', t.id, next); };
  if (w && !w.inboxId) {
    if (now - w.lastAt >= OPENCODE_POST_TIMEOUT_MS) clear();
    return;
  }
  if (w?.inboxId && !w.deliveredAt) {
    if (w.kind === 'room' && !due(store, r, s, t)) {
      actions.push({ type: 'withdraw', id: w.id, sessionId: t.sessionId, inboxId: w.inboxId });
      return clear();
    }
    if (now - (w.polledAt ?? w.lastAt) >= OPENCODE_POLL_MS) {
      store.put<Attachment>('attachment', t.id, { ...t, wake: { ...w, polledAt: now } });
      actions.push({ type: 'poll', sessionId: t.sessionId, wakeId: w.id, seatId: t.seatId, inboxId: w.inboxId });
    }
    return;
  }
  if (w?.deliveredAt) {
    if (now - w.deliveredAt >= WAKE_GIVE_UP_MS) suspend(store, t, r, 'OpenCode delivered the wake but the agent did not read its inbox');
    return;
  }
  const kind: WakeNotice['kind'] | undefined = t.check ? 'check' : due(store, r, s, t) ? 'room' : undefined;
  if (!kind || (t.lastWakeAt !== undefined && now - t.lastWakeAt < Number(r.policy.cooldownMs ?? 5000))) return;
  const wake = { id: randomUUID(), kind, attempts: 1, firstAt: now, lastAt: now };
  store.put<Attachment>('attachment', t.id, { ...t, wake, lastWakeAt: now });
  actions.push({ type: 'post', sessionId: t.sessionId, wakeId: wake.id, roomId: t.roomId, seatId: t.seatId, kind });
}

// The daemon posts outside the store transaction and reports back here; a wake cleared meanwhile is withdrawn instead.
export function recordOpenCodePost(store: Store, seatId: string, sessionId: string, wakeId: string,
  result: { inboxId: string } | { status: number; message: string }) {
  const t = store.get<Attachment>('attachment', seatId);
  if (t?.wake?.id !== wakeId || t.sessionId !== sessionId) {
    if ('inboxId' in result) store.put<Withdrawal>('opencode_withdrawal', wakeId, { id: wakeId, sessionId, inboxId: result.inboxId });
    return;
  }
  if ('inboxId' in result) return store.put<Attachment>('attachment', t.id, { ...t, wake: { ...t.wake, inboxId: result.inboxId } });
  if (result.status === 404) return end(store, t, 'The OpenCode session was deleted');
  suspend(store, t, store.get<Room>('room', t.roomId)!, `OpenCode refused the wake (${result.status}): ${result.message}`.slice(0, 300));
}
export function recordOpenCodeInbox(store: Store, seatId: string, wakeId: string, inbox: 'pending' | 'gone' | 'missing', now = Date.now()) {
  const t = store.get<Attachment>('attachment', seatId);
  if (t?.wake?.id !== wakeId || t.wake.deliveredAt) return;
  if (inbox === 'missing') {
    const gone: Attachment = { ...t };
    delete gone.wake;
    return end(store, gone, 'The OpenCode session was deleted');
  }
  if (inbox === 'gone') store.put<Attachment>('attachment', t.id, { ...t, wake: { ...t.wake, deliveredAt: now } });
}

export const planWakes = (store: Store, now: number, sessions: WakeSessions): WakeNotice[] => planPushes(store, now, sessions).notices;
export function planPushes(store: Store, now: number, sessions: WakeSessions, server: OpenCodeServerState = { ready: false }) {
  const notices: WakeNotice[] = [], actions: OpenCodeAction[] = [];
  if (server.ready)
    for (const w of store.list<Withdrawal>('opencode_withdrawal')) {
      actions.push({ type: 'withdraw', ...w });
      store.remove('opencode_withdrawal', w.id);
    }
  for (const t of store.list<Attachment>('attachment')) {
    const r = store.get<Room>('room', t.roomId), s = store.get<Seat>('seat', t.seatId);
    const gone = !r || ENDED_ROOMS.includes(r.lifecycle) ? 'The room closed'
      : !s || !currentSeat(store, r, s) ? 'The seat left the room'
        : store.get('revoked', t.principalId) ? 'The connection\'s credential was revoked'
          : !enabled(store, t.bridge) ? 'The owner turned off the ' + PUSH_BRIDGES[t.bridge] + ' push bridge' : undefined;
    if (gone) {
      end(store, t, gone);
      continue;
    }
    if (t.bridge === 'opencode') {
      planOpenCode(store, now, t, r!, s!, server, actions);
      continue;
    }
    if (!sessions.connected(t.sessionId)) {
      if (now - Math.max(sessions.lastSeen(t.sessionId) ?? 0, sessions.since, t.since) > SESSION_GRACE_MS)
        end(store, t, 'The ' + PUSH_BRIDGES[t.bridge] + ' session ended');
      continue;
    }
    if (t.status !== 'attached' || !['draft', 'active'].includes(r!.lifecycle)) continue;
    const send = (wake: NonNullable<Attachment['wake']>) => {
      store.put<Attachment>('attachment', t.id, { ...t, wake, lastWakeAt: now });
      notices.push({ sessionId: t.sessionId, wakeId: wake.id, roomId: t.roomId, seatId: t.seatId, kind: wake.kind, attempt: wake.attempts });
    };
    if (t.wake) {
      const gap = WAKE_RESENDS_MS[t.wake.attempts - 1];
      if (gap !== undefined && now - t.wake.lastAt >= gap) send({ ...t.wake, attempts: t.wake.attempts + 1, lastAt: now });
      else if (gap === undefined && now - t.wake.lastAt >= WAKE_GIVE_UP_MS)
        suspend(store, t, r!, `No inbox read after ${t.wake.attempts} wake notices, so the session may be busy or was started without the channel flag`);
      continue;
    }
    const kind = t.check ? 'check' : due(store, r!, s!, t) ? 'room' : undefined;
    if (!kind || (t.lastWakeAt !== undefined && now - t.lastWakeAt < Number(r!.policy.cooldownMs ?? 5000))) continue;
    send({ id: randomUUID(), kind, attempts: 1, firstAt: now, lastAt: now });
  }
  return { notices, actions };
}

export function mountAttachments(c: Core, ask: (a: Actor, r: Room, scope: ToolArgs, summary: string) => Permission) {
  const store = c.store;
  const setBridge = (a: Actor, x: ToolArgs, on: boolean) => store.transaction(() => {
    c.requireOwner(a);
    const bridge = str(x, 'bridge', 64);
    if (!(bridge in PUSH_BRIDGES)) throw new E('invalid_argument', 'Choose a push bridge: ' + Object.keys(PUSH_BRIDGES).join(', '));
    const record = { id: bridge, enabled: on, updatedAt: Date.now(), updatedBy: a.principalId };
    store.put('push_bridge', bridge, record);
    installationAuthority(store, a, on ? 'push_bridge.enabled' : 'push_bridge.disabled', { bridge });
    if (!on) for (const t of store.list<Attachment>('attachment').filter((v) => v.bridge === bridge))
      end(store, t, 'The owner turned off the ' + PUSH_BRIDGES[bridge as PushBridge] + ' push bridge', a);
    return record;
  });
  c.register('push_bridge_enable', (a, x) => setBridge(a, x, true));
  c.register('push_bridge_disable', (a, x) => setBridge(a, x, false));
  c.register('seat_attach', (a, x) => store.transaction(() => {
    if (a.kind !== 'agent') throw new E('agent_required', 'The agent asks to attach from inside its own session', 403);
    const r = c.requireRoom(a, str(x, 'roomId')), s = c.requireSeat(a, r.id), bridge = bridgeFor(s);
    if (!bridge) throw new E('push_unsupported', 'Only a polling Claude Code or OpenCode seat can be attached for push wakes', 409);
    if (ENDED_ROOMS.includes(r.lifecycle)) throw new E('room_ended', 'The room has ended', 409);
    if (!enabled(store, bridge))
      throw new E('push_disabled', 'The ' + PUSH_BRIDGES[bridge] + ' push bridge is off. Ask the owner to run converoom bridge enable ' + bridge, 409);
    // The transport supplies an OpenCode session ID only for a call that came through Converoom's own OpenCode server.
    if (typeof a.sessionId !== 'string' || (bridge === 'opencode') !== OPENCODE_SESSION.test(a.sessionId))
      throw new E('session_required', bridge === 'opencode'
        ? 'Converoom cannot wake this OpenCode session. Ask the owner to open it with converoom opencode, then ask again'
        : 'This connection has no wake session. Restart Claude Code so its Converoom MCP server reconnects', 409);
    const current = store.get<Attachment>('attachment', s.id);
    if (current?.sessionId === a.sessionId) return current;
    const pending = store.list<Permission>('permission', { roomId: r.id, status: ['pending'] })
      .filter((p) => p.action === 'seat_attach' && p.scope.seatId === s.id);
    const same = pending.find((p) => p.scope.sessionId === a.sessionId && p.expiresAt > Date.now());
    if (same) return same;
    // The newest session to ask is the one the owner is approving, so older requests for this seat lapse.
    for (const p of pending) {
      store.put('permission', p.id, { ...p, status: 'cancelled' });
      authority(store, a, r, 'permission.cancelled', { requestId: p.id, action: p.action, scopeDigest: p.scopeDigest });
    }
    return ask(a, r, { seatId: s.id, bridge, sessionId: a.sessionId },
      `Let Converoom wake the ${PUSH_BRIDGES[bridge]} session in seat ${s.name} when its inbox has something new`);
  }));
  c.register('seat_detach', (a, x) => store.transaction(() => {
    const r = c.requireRoom(a, str(x, 'roomId'));
    let s: Seat;
    if (a.kind === 'agent') {
      s = c.requireSeat(a, r.id);
      if (x.seatId !== undefined && x.seatId !== s.id) throw new E('forbidden', 'An agent detaches only its own seat', 403);
    } else {
      const target = store.get<Seat>('seat', str(x, 'seatId'));
      if (!target || target.roomId !== r.id) throw new E('seat', 'Seat not found');
      requireSeatOwner(c, a, target);
      s = target;
    }
    const t = store.get<Attachment>('attachment', s.id);
    if (!t) return { seatId: s.id, detached: false };
    end(store, t, a.kind === 'agent' ? 'The agent detached the session' : 'The owner detached the session', a);
    return { seatId: s.id, detached: true };
  }));
}
