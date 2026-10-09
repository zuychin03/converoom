import { randomBytes, randomUUID } from 'node:crypto';
import {
  ConveroomError as E, requiredString as str,
  type Actor, type Core, type Store, type Room, type Seat, type Turn,
  type HumanMembership, type Invitation, type OwnerConsent, type ToolArgs, type Event,
  type SharedArtefact,
} from '../../shared/src/contracts.js';
import { artefactMetadata } from './shared-artefacts.js';
import { scopeDigest, redactPublic, redactTransport } from '../../store/src/index.js';

const lifetime = 600000;
type Interaction = ToolArgs & { id: string; roomId: string; recipientId: string; messageId: string; status: string };
export const membershipId = (roomId: string, ownerId: string) => scopeDigest([roomId, ownerId]);
export function activeMembership(store: Store, roomId: string, ownerId: string, principalId?: string) {
  const m = store.get<HumanMembership>('human_membership', membershipId(roomId, ownerId));
  return m?.status === 'active' && (!principalId || m.principalId === principalId) ? m : undefined;
}
export function currentSeat(store: Store, r: Room, s: Seat) {
  if (s.status === 'left') return false;
  if (s.ownerId === r.ownerId) return true;
  const m = activeMembership(store, r.id, s.ownerId);
  return !!m && m.generation === s.membershipGeneration;
}
export function currentTurnAuthority(store: Store, t: Turn) {
  const r = store.get<Room>('room', t.roomId), s = store.get<Seat>('seat', t.seatId);
  if (!r || !s || !currentSeat(store, r, s) || !t.requestedBy || store.get('revoked', t.requestedBy)) return false;
  if (!t.ownerConsentDigest) return !t.senderOwnerId;
  const consent = store.get<OwnerConsent>('owner_consent', s.id);
  const requester = t.senderOwnerId === r.ownerId ? undefined : activeMembership(store, r.id, t.senderOwnerId ?? '');
  const principal = requester?.principalId === t.requestedBy || store.list<Seat>('seat', { roomId: r.id })
    .some((v) => v.ownerId === t.senderOwnerId && v.principalId === t.requestedBy && currentSeat(store, r, v));
  return !!consent && consent.status === 'active' && scopeDigest(consent) === t.ownerConsentDigest &&
    consent.membershipGeneration === s.membershipGeneration && s.membershipGeneration === t.membershipGeneration &&
    consent.allowedSenderOwnerIds.includes(t.senderOwnerId ?? '') && t.policyVersion === r.policyVersion &&
    (t.senderOwnerId === r.ownerId || !!requester && requester.role === 'participant' && principal &&
      requester.generation === t.requesterMembershipGeneration);
}
export function requireHumanParticipant(c: Core, a: Actor, roomId: string) {
  const r = c.requireRoom(a, roomId);
  if (a.kind !== 'human') throw new E('human_required', 'Human authority required', 403);
  if (r.ownerId !== a.ownerId && activeMembership(c.store, roomId, a.ownerId, a.principalId)?.role !== 'participant')
    throw new E('observer', 'Participant authority required', 403);
  return r;
}
export function requireSeatOwner(c: Core, a: Actor, s: Seat) {
  requireHumanParticipant(c, a, s.roomId);
  if (s.ownerId !== a.ownerId || !currentSeat(c.store, c.requireRoom(a, s.roomId), s))
    throw new E('seat_owner', 'Current seat owner required', 403);
}
const select = (value: object, fields: string[]) => Object.fromEntries(fields
  .filter((key) => key in value).map((key) => [key, (value as ToolArgs)[key]]));
export const sharedSeat = (s: Seat) => select(s, ['id', 'roomId', 'ownerId', 'name', 'product', 'mode', 'role', 'status', 'membershipGeneration']);
export const sharedTurn = (t: Turn) => select(t, ['id', 'roomId', 'seatId', 'prompt', 'status', 'createdAt', 'startedAt', 'completedAt',
  'policyVersion', 'senderOwnerId', 'membershipGeneration', 'requesterMembershipGeneration', 'maxTurnMs', 'ownerConsentDigest', 'interactionId']);
const sharedInteraction = (i: Interaction) => select(i, ['id', 'roomId', 'senderId', 'recipientId', 'messageId', 'intent', 'status', 'hop', 'createdAt', 'turnId', 'responseId']);
const eventFields: Record<string, string[]> = {
  message: ['text', 'senderId', 'mentions', 'replyToId'], agenda: ['agenda', 'unresolved'],
  decision: ['decision', 'positions', 'dissent', 'evidence', 'unresolved'],
  'seat.joined': ['id', 'ownerId', 'name', 'product', 'mode', 'role', 'status'], 'seat.left': ['seatId'],
  'room.paused': ['status'], 'room.open': ['status'], 'room.closed': ['status'],
  'policy.changed': ['version'], 'host.transferred': ['seatId'],
  'membership.confirmed': ['memberId', 'ownerId', 'generation', 'role'],
  'membership.revoked': ['memberId', 'ownerId', 'generation'],
  'turn.queued': ['id', 'seatId', 'status', 'createdAt'],
  'turn.started': ['turnId', 'externalPolling'], 'turn.completed': ['turnId', 'externalPolling'],
  'turn.failed': ['turnId'], 'turn.cancelled': ['turnId'], 'turn.uncertain': ['turnId'],
  'interaction.responded': ['interactionId', 'responseId'], 'interaction.resolved': ['interactionId'],
  'interaction.read': ['interactionId'],
  'artefact.shared': ['id', 'ownerId', 'name', 'mimeType', 'digest', 'bytes', 'visibility', 'sharedAt', 'provenance'],
};
export const SHARED_BYTES = 524288;
const jsonBytes = (v: unknown) => Buffer.byteLength(JSON.stringify(v));
function bounded(v: ToolArgs, arrays: string[]): ToolArgs {
  const omitted = (v.omitted as Record<string, number> | undefined) ?? {};
  v.omitted = omitted;
  const sizes = Object.fromEntries(arrays.map((key) => [key, (v[key] as unknown[]).map(jsonBytes)]));
  const totals = Object.fromEntries(arrays.map((key) => [key, sizes[key].reduce((sum, n) => sum + n + 1, 0)]));
  let bytes = jsonBytes(v) + 512;
  while (bytes > SHARED_BYTES) {
    const key = arrays.filter((key) => Array.isArray(v[key]) && (v[key] as unknown[]).length)
      .sort((a, b) => totals[b] - totals[a])[0];
    if (!key) throw new E('shared_size', 'Shared projection exceeds its byte limit', 413);
    const removed = (key === 'events' ? sizes[key].shift() : sizes[key].pop())! + 1;
    if (key === 'events') (v[key] as unknown[]).shift(); else (v[key] as unknown[]).pop();
    bytes -= removed; totals[key] -= removed; omitted[key] = (omitted[key] ?? 0) + 1;
  }
  return v;
}
function publicEvent(event: Event): ToolArgs | undefined {
  const fields = eventFields[event.type];
  if (!fields) return undefined;
  const value = redactTransport({ ...select(event, ['id', 'roomId', 'seq', 'type', 'actorId', 'at']), data: select(event.data, fields) });
  const bytes = jsonBytes(value);
  return bytes <= 131072 ? value : { ...select(event, ['id', 'roomId', 'seq', 'type', 'actorId', 'at']), data: { omittedForSize: true, bytes } };
}
function sharedAccess(c: Core, a: Actor, id: string) {
  const r = c.requireRoom(a, id);
  if (r.workflow !== 'discussion') throw new E('shared_workflow', 'Coding stays on the local control server', 403);
  return r;
}
function sharedPage(c: Core, a: Actor, id: string, cursor: number, limit: number) {
  const room = sharedAccess(c, a, id);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > room.seq || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw new E('cursor', 'A bounded cursor page is required');
  const events: ToolArgs[] = [];
  let bytes = 1024, scanned = 0, after = cursor;
  while (scanned < 1000 && after < room.seq) {
    const raw = c.store.events(id, after, Math.min(32, 1000 - scanned));
    if (!raw.length) break;
    for (const event of raw) {
      const value = publicEvent(event), size = value ? jsonBytes(value) + 1 : 0;
      if (value && (events.length >= limit || bytes + size > SHARED_BYTES)) return { events, cursor: after, hasMore: true };
      if (value) { events.push(value); bytes += size; }
      after = event.seq; scanned++;
    }
  }
  return { events, cursor: after, hasMore: after < room.seq };
}
export function sharedProjection(c: Core, a: Actor, id: string): ToolArgs {
  const r = sharedAccess(c, a, id), seats = c.store.list<Seat>('seat', { roomId: id }).filter((s) => currentSeat(c.store, r, s));
  const own = new Set(seats.filter((s) => s.ownerId === a.ownerId && (a.kind === 'human' || s.principalId === a.principalId)).map((s) => s.id));
  const events: ToolArgs[] = [], sizes: number[] = [];
  let cursor = Math.max(0, r.seq - 1000), bytes = 0, omittedEvents = 0;
  while (cursor < r.seq) {
    const raw = c.store.events(id, cursor, 32); if (!raw.length) break;
    for (const event of raw) {
      cursor = event.seq; const value = publicEvent(event); if (!value) continue;
      const size = jsonBytes(value) + 1; events.push(value); sizes.push(size); bytes += size;
      while (events.length > 100 || bytes > SHARED_BYTES) { events.shift(); bytes -= sizes.shift()!; omittedEvents++; }
    }
  }
  return bounded(redactTransport({ room: { ...select(r, ['id', 'title', 'objective', 'ownerId', 'hostSeatId', 'status', 'workflow', 'createdAt', 'policyVersion', 'seq']),
      policy: select(r.policy, ['maxActiveTurns', 'maxRounds', 'maxMessages', 'maxDurationMs', 'maxMentionHops', 'maxPending', 'cooldownMs', 'maxTurnMs']) },
    members: c.store.list<HumanMembership>('human_membership', { roomId: id, status: ['active'] }).slice(0, 20)
      .map((m) => select(m, ['id', 'roomId', 'ownerId', 'displayName', 'role', 'status', 'generation'])),
    seats: seats.slice(0, 50).map(sharedSeat), events, cursor: r.seq, omitted: omittedEvents ? { events: omittedEvents } : {},
    interactions: c.store.list<Interaction>('interaction', { roomId: id }).slice(-100).map(sharedInteraction),
    turns: c.store.list<Turn>('turn', { roomId: id, status: ['queued', 'dispatching', 'running', 'cancelling', 'uncertain'] })
      .filter((t) => own.has(t.seatId)).slice(0, 100).map(sharedTurn),
    artefacts: c.store.list<SharedArtefact>('shared_artefact', { roomId: id }).slice(0, 100).map(artefactMetadata) }), ['events', 'turns', 'interactions', 'artefacts']);
}
export const SHARED_READS = new Set(['room_get', 'room_list', 'room_read', 'room_wait', 'room_inbox', 'room_usage', 'room_members', 'shared_artefact_get', 'shared_artefact_list']);
export const SHARED_WRITES = new Set(['room_post', 'room_leave', 'turn_request', 'turn_claim', 'turn_complete', 'turn_cancel',
  'room_set_agenda', 'room_propose_decision', 'interaction_resolve', 'host_transfer_request', 'room_pause', 'room_resume', 'room_close',
  'shared_artefact_publish', 'owner_consent_update']);
export async function sharedCommand(c: Core, a: Actor, roomId: string, generation: number, name: string, x: ToolArgs) {
  const r = sharedAccess(c, a, roomId), m = activeMembership(c.store, roomId, a.ownerId, a.kind === 'human' ? a.principalId : undefined);
  if (!m || m.generation !== generation || (x.roomId && x.roomId !== roomId)) throw new E('shared_scope', 'Current room credential scope required', 403);
  if (!SHARED_READS.has(name) && !SHARED_WRITES.has(name)) throw new E('shared_tool', 'This operation is local or unsupported', 403);
  if (SHARED_WRITES.has(name) && (x.expectedGeneration !== generation || x.expectedPolicyVersion !== r.policyVersion ||
    typeof x.clientKey !== 'string' || !x.clientKey || Buffer.byteLength(x.clientKey) > 256))
    throw new E('shared_version', 'Expected membership, policy and idempotency key required', 409);
  const args: ToolArgs = { ...x, roomId }; delete args.expectedGeneration; delete args.expectedPolicyVersion;
  if (name === 'room_get') return sharedProjection(c, a, roomId).room;
  if (name === 'room_list') return [sharedProjection(c, a, roomId).room];
  if (name === 'room_members') return sharedProjection(c, a, roomId).members;
  if (name === 'room_inbox') {
    const raw = await c.dispatch(a, name, args) as { interactions: ToolArgs[]; turns: Turn[] };
    const own = new Set(c.store.list<Seat>('seat', { roomId }).filter((s) => s.ownerId === a.ownerId &&
      (a.kind === 'human' || s.principalId === a.principalId) && currentSeat(c.store, r, s)).map((s) => s.id));
    return bounded(redactTransport({ interactions: raw.interactions.filter((i) => own.has(String(i.recipientId))).slice(0, 100)
      .map((i) => select(i, ['id', 'roomId', 'senderId', 'recipientId', 'messageId', 'intent', 'status', 'hop', 'createdAt', 'turnId'])),
      turns: raw.turns.filter((t) => own.has(t.seatId)).slice(0, 100).map(sharedTurn),
      room: sharedProjection(c, a, roomId).room, generation }), ['interactions', 'turns']);
  }
  if (name === 'room_read' || name === 'room_wait') {
    const until = Date.now() + (name === 'room_wait' ? Math.max(0, Math.min(30000, Number(x.timeoutMs ?? 20000))) : 0);
    let page = sharedPage(c, a, roomId, Number(x.cursor ?? 0), Number(x.limit ?? 100));
    while (!page.events.length && Date.now() < until) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(250, until - Date.now())));
      if (activeMembership(c.store, roomId, a.ownerId, a.kind === 'human' ? a.principalId : undefined)?.generation !== generation)
        throw new E('shared_scope', 'Membership changed while waiting', 403);
      page = sharedPage(c, a, roomId, page.cursor, Number(x.limit ?? 100));
    }
    if (a.kind === 'agent') {
      const seat = c.store.list<Seat>('seat', { roomId }).find((s) => s.ownerId === a.ownerId && s.principalId === a.principalId && currentSeat(c.store, r, s));
      const read = new Set(page.events.filter((e) => e.type === 'message' && !(e.data as ToolArgs).omittedForSize).map((e) => e.id));
      if (seat) for (const i of c.store.list<Interaction>('interaction', { roomId }))
        if (i.recipientId === seat.id && ['stored', 'delivered'].includes(i.status) && read.has(i.messageId)) {
          c.store.put('interaction', i.id, { ...i, status: 'read', readAt: Date.now(), deliveredAt: i.deliveredAt ?? Date.now() });
          c.store.append(roomId, 'interaction.read', a.principalId, { interactionId: i.id });
        }
    }
    return page;
  }
  const result = await c.dispatch(a, name, args);
  if (name === 'shared_artefact_get' || name === 'shared_artefact_list' || name === 'shared_artefact_publish') return result;
  if (name === 'owner_consent_update') return { seatId: x.seatId, consentUpdated: true };
  if (name === 'room_usage') {
    const usage = result as ToolArgs;
    return { messages: usage.messages, turns: usage.turns, quota: 'unknown', policy: (sharedProjection(c, a, roomId).room as ToolArgs).policy };
  }
  if (name.startsWith('turn_')) return redactTransport(sharedTurn(result as Turn));
  if (name === 'room_post') return publicEvent(result as Event);
  if (name.startsWith('room_')) return sharedProjection(c, a, roomId).room;
  if (name === 'host_transfer_request') return { pendingLocalHumanApproval: true };
  return redactTransport(select(result as object, ['id', 'roomId', 'status', 'type', 'seq', 'at']));
}
export async function sharedExport(c: Core, a: Actor, roomId: string, generation: number, cursor: number) {
  const projection = sharedProjection(c, a, roomId), page = await sharedCommand(c, a, roomId, generation, 'room_read', { roomId, cursor, limit: 20 }) as ToolArgs;
  const view = { room: projection.room, events: page.events, artefacts: projection.artefacts, omitted: page.omitted, cursor: page.cursor };
  const markdown = '# Converoom shared room\n\nBounded public history page. Request the next cursor for remaining history.\n\n```json\n' + JSON.stringify(view, null, 2) + '\n```\n';
  return { markdown, cursor: page.cursor, hasMore: Number(page.cursor) < Number((projection.room as ToolArgs).seq), digest: scopeDigest(markdown), view: 'bounded-page' };
}
export function mountMembership(c: Core) {
  const { store } = c;
  const audit = (a: Actor, r: Room, type: string, data: ToolArgs) => store.append(r.id, type, a.principalId,
    { ...data, actionDigest: scopeDigest(data), policyVersion: r.policyVersion });
  const admin = (a: Actor, x: ToolArgs) => {
    const id = str(x, 'roomId', 256); c.requireOwner(a, id);
    const r = c.requireRoom(a, id);
    if (r.workflow !== 'discussion' || r.status === 'closed') throw new E('sharing', 'An available discussion room is required', 409);
    return r;
  };
  const target = (r: Room, x: ToolArgs) => {
    const m = store.get<HumanMembership>('human_membership', str(x, 'memberId', 256));
    if (!m || m.roomId !== r.id || m.ownerId === r.ownerId || m.generation !== x.expectedGeneration)
      throw new E('membership_generation', 'Current participant generation required', 409);
    return m;
  };
  c.register('membership_invite', (a, x) => store.transaction(() => {
    const r = admin(a, x), displayName = redactPublic(str(x, 'displayName', 256));
    if (!['participant', 'observer'].includes(String(x.role))) throw new E('role', 'Invitation role required');
    const role = x.role as Invitation['role'], key = str(x, 'clientKey', 256);
    const recover = x.recoverMemberId ? target(r, { memberId: x.recoverMemberId, expectedGeneration: x.expectedGeneration }) : undefined;
    const intentId = scopeDigest([a.principalId, r.id, key]), digest = scopeDigest({ displayName, role,
      ...(recover ? { recoverMemberId: recover.id, expectedGeneration: recover.generation } : {}) });
    const intent = store.get<{ digest: string; invitationId: string }>('invitation_intent', intentId);
    if (intent) {
      if (intent.digest !== digest) throw new E('idempotency_conflict', 'Invitation key was used with different scope', 409);
      const previous = store.get<Invitation>('invitation', intent.invitationId)!;
      return { id: previous.id, expiresAt: previous.expiresAt, codeAvailable: false };
    }
    if (store.count('invitation', { roomId: r.id }) >= 100)
      throw new E('invitation_limit', 'Room invitation history limit reached', 409);
    if (!store.get('human_membership', membershipId(r.id, r.ownerId))) {
      const m: HumanMembership = { id: membershipId(r.id, r.ownerId), roomId: r.id, ownerId: r.ownerId,
        principalId: a.principalId, displayName: 'Room owner', role: 'participant', status: 'active',
        generation: 1, invitedBy: a.principalId, createdAt: Date.now(), updatedAt: Date.now() };
      store.put('human_membership', m.id, m);
    }
    const code = randomBytes(32).toString('base64url');
    const invitation: Invitation = { id: randomUUID(), roomId: r.id, invitedBy: a.principalId,
      displayName: recover?.displayName ?? displayName, role: recover?.role ?? role, codeHash: scopeDigest(code), status: 'available', createdAt: Date.now(), expiresAt: Date.now() + lifetime,
      ...(recover ? { recoverMemberId: recover.id, expectedGeneration: recover.generation } : {}) };
    store.put('invitation', invitation.id, invitation);
    store.put('invitation_intent', intentId, { digest, invitationId: invitation.id });
    audit(a, r, 'membership.invited', { invitationId: invitation.id, displayName, role, expiresAt: invitation.expiresAt });
    return { id: invitation.id, code, expiresAt: invitation.expiresAt, codeAvailable: true };
  }));
  c.register('membership_redeem', (a, x) => store.transaction(() => {
    if (a.kind !== 'human') throw new E('human_required', 'Human membership required', 403);
    const id = str(x, 'roomId', 256), r = store.get<Room>('room', id);
    const hash = scopeDigest(str(x, 'code', 256));
    const invitation = store.list<Invitation>('invitation', { roomId: id, status: ['available'] })
      .find((i) => i.codeHash === hash && i.expiresAt > Date.now());
    if (!r || r.workflow !== 'discussion' || r.status === 'closed' || !invitation || invitation.recoverMemberId || r.ownerId === a.ownerId)
      throw new E('invitation', 'Invitation unavailable', 403);
    const memberId = membershipId(id, a.ownerId), old = store.get<HumanMembership>('human_membership', memberId);
    if (old && (old.status === 'active' || (old.status === 'pending' && Number(old.pendingExpiresAt) > Date.now())))
      throw new E('membership', 'Membership already active or pending', 409);
    if (!old && store.count('human_membership', { roomId: id }) >= 20)
      throw new E('membership_limit', 'Room member limit reached', 409);
    const m: HumanMembership = { id: memberId, roomId: id, principalId: a.principalId, ownerId: a.ownerId,
      displayName: invitation.displayName, role: invitation.role, status: 'pending', generation: (old?.generation ?? 0) + 1,
      invitedBy: invitation.invitedBy, createdAt: old?.createdAt ?? Date.now(), updatedAt: Date.now(), pendingExpiresAt: Date.now() + lifetime };
    store.put('invitation', invitation.id, { ...invitation, status: 'redeemed', memberId });
    store.put('human_membership', m.id, m);
    audit(a, r, 'membership.pending', { memberId: m.id, ownerId: m.ownerId, generation: m.generation, displayName: m.displayName });
    return m;
  }));
  c.register('membership_confirm', (a, x) => store.transaction(() => {
    const r = admin(a, x), m = target(r, x);
    if (m.status !== 'pending' || m.invitedBy !== a.principalId || Number(m.pendingExpiresAt) <= Date.now())
      throw new E('membership', 'Pending invitation confirmation unavailable', 409);
    const next = { ...m, status: 'active' as const, updatedAt: Date.now(), pendingExpiresAt: undefined };
    store.put('human_membership', m.id, next);
    audit(a, r, 'membership.confirmed', { memberId: m.id, ownerId: m.ownerId, generation: m.generation, role: m.role });
    return next;
  }));
  c.register('invitation_revoke', (a, x) => store.transaction(() => {
    const r = admin(a, x), i = store.get<Invitation>('invitation', str(x, 'invitationId', 256));
    if (!i || i.roomId !== r.id || i.status !== 'available') throw new E('invitation', 'Available invitation required', 409);
    store.put('invitation', i.id, { ...i, status: 'revoked' });
    return audit(a, r, 'invitation.revoked', { invitationId: i.id });
  }));
  const withdraw = (a: Actor, r: Room, m: HumanMembership) => {
    const next = { ...m, status: 'revoked' as const, generation: m.generation + 1, updatedAt: Date.now() };
    store.put('human_membership', m.id, next);
    const seats = store.list<Seat>('seat', { roomId: r.id }).filter((s) => s.ownerId === m.ownerId);
    const ids = new Set(seats.map((s) => s.id));
    const principals = new Set([m.principalId, ...seats.map((s) => s.principalId)]);
    for (const s of seats) store.put('seat', s.id, { ...s, status: 'left', consent: false });
    for (const t of store.list<Turn>('turn', { roomId: r.id, status: ['queued', 'dispatching', 'running', 'cancelling'] })) {
      if (!ids.has(t.seatId) && !principals.has(String(t.requestedBy))) continue;
      const status = t.status === 'queued' ? 'cancelled' : 'uncertain';
      store.put('turn', t.id, { ...t, status, error: 'Membership removed; external execution stop is unconfirmed' });
      audit(a, r, 'turn.' + status, { turnId: t.id, membershipGeneration: next.generation });
    }
    for (const p of store.list<{ id: string; ownerId: string; status: string }>('permission', { roomId: r.id, status: ['pending'] }))
      if (p.ownerId === m.ownerId) {
        store.put('permission', p.id, { ...p, status: 'cancelled' });
        audit(a, r, 'permission.cancelled', { requestId: p.id, memberId: m.id });
      }
    for (const consent of store.list<OwnerConsent>('owner_consent', { roomId: r.id }))
      if (consent.ownerId === m.ownerId) store.put('owner_consent', consent.id, { ...consent, status: 'revoked', updatedAt: Date.now() });
    if (r.hostSeatId && ids.has(r.hostSeatId)) store.put('room', r.id, { ...r, hostSeatId: null });
    audit(a, r, 'membership.revoked', { memberId: m.id, ownerId: m.ownerId, generation: next.generation });
    return next;
  };
  c.register('membership_revoke', (a, x) => store.transaction(() => {
    const r = admin(a, x), m = target(r, x);
    if (m.status === 'revoked') throw new E('membership', 'Membership already revoked', 409);
    return withdraw(a, r, m);
  }));
  c.register('membership_recover', (a, x) => store.transaction(() => {
    if (a.kind !== 'human') throw new E('human_required', 'Human recovery required', 403);
    const roomId = str(x, 'roomId', 256), r = store.get<Room>('room', roomId), hash = scopeDigest(str(x, 'code', 256));
    const invitation = store.list<Invitation>('invitation', { roomId, status: ['available'] })
      .find((i) => i.codeHash === hash && i.expiresAt > Date.now() && i.recoverMemberId);
    const m = invitation?.recoverMemberId ? store.get<HumanMembership>('human_membership', invitation.recoverMemberId) : undefined;
    if (!r || r.status === 'closed' || !invitation || !m || m.roomId !== roomId || m.ownerId === r.ownerId || m.generation !== invitation.expectedGeneration)
      throw new E('recovery', 'Current owner-issued recovery invitation required', 403);
    const fenced = withdraw(a, r, m);
    const next: HumanMembership = { ...fenced, status: 'pending', invitedBy: invitation.invitedBy, pendingExpiresAt: Date.now() + lifetime };
    store.put('invitation', invitation.id, { ...invitation, status: 'redeemed', memberId: m.id });
    store.put('human_membership', m.id, next);
    audit(a, r, 'membership.recovery_pending', { memberId: m.id, ownerId: m.ownerId, generation: next.generation });
    return next;
  }));
  c.register('room_members', (a, x) => {
    const r = c.requireRoom(a, str(x, 'roomId', 256));
    return store.list<HumanMembership>('human_membership', { roomId: r.id })
      .filter((m) => a.kind === 'human' && r.ownerId === a.ownerId || m.status === 'active');
  });
  c.register('owner_consent_update', (a, x) => store.transaction(() => {
    const r = c.requireRoom(a, str(x, 'roomId', 256)), s = store.get<Seat>('seat', str(x, 'seatId', 256));
    if (!s || s.roomId !== r.id) throw new E('seat', 'Seat not found');
    requireSeatOwner(c, a, s);
    const allowed = x.allowedSenderOwnerIds;
    if (!Array.isArray(allowed) || allowed.length > 20 || allowed.some((v) => typeof v !== 'string' || !v || v.length > 256) || new Set(allowed).size !== allowed.length)
      throw new E('consent', 'Bounded sender owner IDs required');
    if (!Number.isSafeInteger(x.maxTurns) || Number(x.maxTurns) < 1 || Number(x.maxTurns) > 60 ||
      !Number.isSafeInteger(x.maxTurnMs) || Number(x.maxTurnMs) < 1000 || Number(x.maxTurnMs) > 600000)
      throw new E('budget', 'Bounded turn consent required');
    const consent: OwnerConsent = { id: s.id, roomId: r.id, seatId: s.id, ownerId: s.ownerId,
      membershipGeneration: s.membershipGeneration, allowedSenderOwnerIds: allowed as string[],
      maxTurns: Number(x.maxTurns), maxTurnMs: Number(x.maxTurnMs), status: 'active', updatedAt: Date.now() };
    store.put('owner_consent', consent.id, consent);
    audit(a, r, 'owner.consent_changed', { ...consent });
    return consent;
  }));
}
