import { randomUUID } from 'node:crypto';
import { mountSharedArtefacts } from './shared-artefacts.js';
import {
  ConveroomError as E,
  requiredString as str,
  type Actor,
  type Core,
  type Store,
  type ToolArgs,
  type Room,
  type Seat,
  type Turn,
  type CommandHandler,
  type OwnerConsent,
} from '../../shared/src/contracts.js';
import { scopeDigest, redactPublic } from '../../store/src/index.js';
import { activeMembership, currentSeat, currentTurnAuthority, mountMembership, requireHumanParticipant, requireSeatOwner } from './membership.js';
const limits = {
  maxActiveTurns: 2,
  maxRounds: 6,
  maxMessages: 60,
  maxDurationMs: 5400000,
  maxMentionHops: 4,
  maxPending: 100,
  cooldownMs: 5000,
  maxTurnMs: 600000,
};
export interface Permission {
  id: string;
  roomId: string;
  ownerId: string;
  action: string;
  scope: ToolArgs;
  scopeDigest: string;
  summary: string;
  status: string;
  expiresAt: number;
}
export interface Grant {
  id: string;
  requestId: string;
  roomId: string;
  ownerId: string;
  action: string;
  scopeDigest: string;
  expiresAt: number;
}
type I = ToolArgs & {
  id: string;
  roomId: string;
  recipientId: string;
  senderId: string;
  messageId: string;
  status: string;
  hop: number;
};
export function turnExecutionScope(t: Turn, store: Store): ToolArgs {
  const attempt = t.attemptId ? store.get<ToolArgs>('attempt', t.attemptId) : undefined;
  const profile = attempt ? store.get<ToolArgs>('profile', String(attempt.profileId)) : undefined;
  return {
    turnId: t.id,
    seatId: t.seatId,
    prompt: t.prompt,
    requestedBy: (t as Turn & { requestedBy: string }).requestedBy,
    policyVersion: t.policyVersion,
    interactionId: t.interactionId ?? null,
    ...(t.remoteProposalId ? { remoteProposalId: t.remoteProposalId,
      remoteProposalDigest: store.get<ToolArgs>('remote_proposal', t.remoteProposalId)?.digest, maxTurnMs: t.maxTurnMs } : {}),
    attempt: t.attemptId
      ? {
          id: t.attemptId,
          roomId: attempt?.roomId,
          seatId: attempt?.seatId,
          generation: attempt?.generation,
          effectiveBase: attempt?.effectiveBase,
          profileId: attempt?.profileId,
          profileDigest: profile ? scopeDigest({ ...profile, digest: undefined }) : null,
          path: attempt?.path,
        }
      : null,
  };
}
export function createCore(store: Store): Core {
  const handlers = new Map<string, CommandHandler>();
  const room = (id: string) => {
    const r = store.get<Room>('room', id);
    if (!r) throw new E('not_found', 'Room not found', 404);
    return r;
  };
  const seat = (a: Actor, id: string) =>
    store
      .list<Seat>('seat', { roomId: id })
      .find((s) => s.principalId === a.principalId && s.ownerId === a.ownerId && currentSeat(store, room(id), s));
  const owner = (a: Actor, id?: string) => {
    if (a.kind !== 'human') throw new E('human_required', 'Human approval required', 403);
    if (id && room(id).ownerId !== a.ownerId) throw new E('forbidden', 'Room owner required', 403);
  };
  const member = (a: Actor, id: string) => {
    const s = seat(a, id);
    if (!s) throw new E('membership', 'Current membership required', 403);
    return s;
  };
  const access = (a: Actor, id: string) => {
    const r = room(id);
    if (a.kind === 'human') {
      if (r.ownerId !== a.ownerId && (r.workflow !== 'discussion' || !activeMembership(store, id, a.ownerId, a.principalId)))
        throw new E('membership', 'Current human membership required', 403);
    }
    else member(a, id);
    return r;
  };
  const host = (a: Actor, id: string) => {
    const r = access(a, id);
    if (a.kind === 'human') owner(a, id);
    if (a.kind === 'agent' && r.hostSeatId !== member(a, id).id)
      throw new E('host', 'Host authority required', 403);
    return r;
  };
  const write = (a: Actor, id: string) => {
    const r = access(a, id);
    if (r.status !== 'open') throw new E('inactive', 'Room is ' + r.status, 409);
    if (a.kind === 'agent' && member(a, id).role === 'observer')
      throw new E('observer', 'Observer cannot publish', 403);
    if (a.kind === 'human') requireHumanParticipant(c, a, id);
    return r;
  };
  const ev = (a: Actor, id: string, n: string, x: ToolArgs) =>
    store.append(id, n, a.principalId, x);
  const permission = (
    a: Actor,
    id: string,
    action: string,
    scope: ToolArgs,
    summary: string,
  ): Permission => {
    let ownerId = a.ownerId;
    if (action === 'host_transfer') ownerId = room(id).ownerId;
    if (action === 'turn_execute' || action === 'vendor_tool') {
      const turn = store.get<Turn>('turn', String(scope.turnId));
      const target = store.get<Seat>('seat', String(turn?.seatId ?? scope.seatId));
      if (!target || target.roomId !== id || !currentSeat(store, room(id), target))
        throw new E('seat', 'Current permission target required', 403);
      ownerId = target.ownerId;
    }
    const p = {
      id: randomUUID(),
      roomId: id,
      ownerId,
      action,
      scope,
      scopeDigest: scopeDigest(scope),
      summary,
      status: 'pending',
      expiresAt: Date.now() + (action === 'vendor_tool' ? 120000 : 3600000),
    };
    store.put('permission', p.id, p);
    ev(a, id, 'permission.requested', p);
    return p;
  };
  const add = (a: Actor, r: Room, x: ToolArgs, principalId: string = randomUUID()): Seat => {
    const role = (
      ['host', 'member', 'observer'].includes(String(x.role)) ? x.role : 'member'
    ) as Seat['role'];
    if (
      role !== 'observer' &&
      store
        .list<Seat>('seat')
        .filter((s) => s.roomId === r.id && s.status !== 'left' && s.role !== 'observer').length >=
        5
    )
      throw new E('seat_limit', 'Seat limit reached', 409);
    const product = (x.product ?? 'codex') as Seat['product'];
    if (!['codex', 'claude', 'cursor', 'opencode'].includes(product))
      throw new E('product', 'Unsupported product');
    const mode = x.mode === 'managed' ? 'managed' : 'polling';
    const membership = activeMembership(store, r.id, a.ownerId);
    if (a.ownerId !== r.ownerId) {
      if (!membership || (membership.role === 'observer' && role !== 'observer'))
        throw new E('membership', 'Active participant required for a writing agent', 403);
      if (role === 'host' || mode === 'managed')
        throw new E('local_authority', 'Participant-local native approval is not connected', 403);
    }
    const s: Seat = {
      id: randomUUID(),
      roomId: r.id,
      principalId,
      ownerId: a.ownerId,
      name: String(x.name ?? product),
      role,
      product,
      mode,
      status: 'idle',
      consent: false,
      ...(a.ownerId !== r.ownerId ? { membershipGeneration: membership!.generation } : {}),
      capabilities: {
        declared: mode === 'managed' ? ['prompt', 'cancel'] : ['poll'],
        probed: [],
        tested: [],
      },
    };
    store.put('seat', s.id, s);
    if (role === 'host' && !r.hostSeatId)
      store.put('room', r.id, { ...room(r.id), hostSeatId: s.id });
    ev(a, r.id, 'seat.joined', { ...s });
    return s;
  };
  const c: Core = {
    store,
    requireOwner: owner,
    requireRoom: access,
    requireSeat: member,
    register: (n, h) => handlers.set(n, h),
    dispatch: async (a, n, x) => {
      if (['ownerId', 'principalId', 'actor', 'kind'].some((k) => k in x))
        throw new E('identity', 'Identity supplied by transport', 403);
      if (store.get('revoked', a.principalId)) throw new E('revoked', 'Credential revoked', 403);
      if (typeof x.roomId === 'string' && !['room_join', 'membership_redeem', 'membership_recover'].includes(n)) access(a, x.roomId);
      if (['permission_grant', 'permission_deny'].includes(n)) {
        const p = store.get<Permission>('permission', String(x.requestId));
        if (p) {
          requireHumanParticipant(c, a, p.roomId);
          if (p.ownerId !== a.ownerId) throw new E('permission_owner', 'Permission owner required', 403);
        }
      }
      const h = handlers.get(n);
      if (!h) throw new E('unknown_command', 'Unsupported command ' + n, 404);
      const external = [
        'task_claim',
        'task_submit',
        'verification_request',
        'integration_prepare',
        'candidate_apply',
        'workspace_cleanup',
        'attempt_release',
        'repo_register',
        'managed_stop',
        'backup_request',
        'membership_invite',
        'remote_connection_attach',
        'remote_turn_accept',
        'remote_refresh',
        'remote_connection_prepare',
        'remote_connection_finish',
        'remote_turn_decline',
        'remote_connection_disconnect',
        'remote_connection_enable',
      ];
      if (
        typeof x.clientKey === 'string' &&
        !external.includes(n) &&
        ![
          'room_get',
          'room_list',
          'room_read',
          'room_wait',
          'room_inbox',
          'runtime_capabilities',
          'room_usage',
          'task_get',
          'artefact_get',
          'repo_list',
          'resource_profile_list',
          'adapter_status',
          'room_members',
        ].includes(n)
      )
        return store.idempotent(a.principalId, n, x.clientKey, x, () => h(a, x));
      return h(a, x);
    },
  };
  c.register('room_create', (a, x) => {
    const r: Room = {
      id: randomUUID(),
      title: str(x, 'title', 256),
      objective: str(x, 'objective'),
      ownerId: a.ownerId,
      hostSeatId: null,
      status: 'open',
      workflow: x.workflow === 'coding' ? 'coding' : 'discussion',
      createdAt: Date.now(),
      policy: { ...limits },
      policyVersion: 1,
      seq: 0,
    };
    store.put('room', r.id, r);
    store.put('policy', r.id + ':1', { roomId: r.id, version: 1, policy: r.policy });
    ev(a, r.id, 'room.created', { title: r.title, objective: r.objective });
    if (a.kind === 'agent')
      add(
        a,
        room(r.id),
        { name: x.name ?? 'Host', product: x.product ?? 'codex', role: 'host' },
        a.principalId,
      );
    return room(r.id);
  });
  c.register('room_get', (a, x) => access(a, str(x, 'roomId')));
  c.register('room_list', (a) =>
    store
      .list<Room>('room')
      .filter((r) => (a.kind === 'human' ? r.ownerId === a.ownerId || !!activeMembership(store, r.id, a.ownerId, a.principalId) : !!seat(a, r.id))),
  );
  c.register('room_join', (a, x) => {
    const r = room(str(x, 'roomId'));
    if (a.kind === 'human') {
      access(a, r.id);
      return r;
    }
    const s = seat(a, r.id);
    if (s) return s;
    if (
      r.status !== 'open' ||
      (a.ownerId !== r.ownerId && !activeMembership(store, r.id, a.ownerId)) ||
      !store.list<Actor>('bridge').some((b) => b.principalId === a.principalId && b.ownerId === a.ownerId)
    )
      throw new E('membership', 'Owner-approved membership required', 403);
    return add(a, r, x, a.principalId);
  });
  c.register('seat_add', (a, x) => {
    const r = room(str(x, 'roomId'));
    access(a, r.id);
    if (a.kind !== 'human') throw new E('human_required', 'Human registration required', 403);
    return add(a, r, x);
  });
  c.register('seat_consent', (a, x) => {
    const id = str(x, 'roomId');
    const s = store.get<Seat>('seat', str(x, 'seatId'));
    if (!s || s.roomId !== id) throw new E('seat', 'Seat not found');
    requireSeatOwner(c, a, s);
    s.consent = x.consent === true;
    store.put('seat', s.id, s);
    ev(a, id, 'seat.consent', { seatId: s.id, consent: s.consent });
    return s;
  });
  c.register('room_leave', (a, x) => {
    const id = str(x, 'roomId');
    access(a, id);
    const s = member(a, id);
    store.put('seat', s.id, { ...s, status: 'left', consent: false });
    return ev(a, id, 'seat.left', { seatId: s.id });
  });
  c.register('policy_update', (a, x) => {
    const r = room(str(x, 'roomId'));
    owner(a, r.id);
    if (!x.policy || typeof x.policy !== 'object') throw new E('policy', 'Policy object required');
    const p = { ...r.policy };
    for (const [k, v] of Object.entries(x.policy)) {
      if (!(k in limits) || typeof v !== 'number' || v < 1 || !Number.isFinite(v))
        throw new E('policy', 'Invalid policy');
      p[k] = Math.min(v, k === 'maxActiveTurns' ? 5 : limits[k as keyof typeof limits]);
    }
    const next = { ...r, policy: p, policyVersion: r.policyVersion + 1 };
    store.put('room', r.id, next);
    store.put('policy', r.id + ':' + next.policyVersion, {
      roomId: r.id,
      version: next.policyVersion,
      policy: p,
    });
    ev(a, r.id, 'policy.changed', { version: next.policyVersion });
    return room(r.id);
  });
  const post = (a: Actor, x: ToolArgs) => {
    const r = write(a, str(x, 'roomId')),
      text = str(x, 'text'),
      sender = a.kind === 'human' ? a.principalId : member(a, r.id).id;
    if (
      store.eventCount(r.id, 'message') >=
        Number(r.policy.maxMessages) ||
      Date.now() - r.createdAt > Number(r.policy.maxDurationMs)
    )
      throw new E('budget', 'Message/time budget exhausted; prepare handoff', 409);
    const mentions = (x.mentions ?? []) as { seatId: string; intent: string }[];
    if (!Array.isArray(mentions) || mentions.length > 5)
      throw new E('mentions', 'Invalid mentions');
    let reply: I | undefined;
    if (x.replyToId) {
      reply = store.get<I>('interaction', String(x.replyToId));
      if (!reply || reply.roomId !== r.id || reply.recipientId !== sender)
        throw new E('recipient', 'Only recipient can reply', 403);
    }
    const hop = (reply?.hop ?? 0) + 1;
    if (mentions.length && hop > Number(r.policy.maxMentionHops))
      throw new E('hops', 'Mention hop limit exhausted', 409);
    if (
      store
        .list<I>('interaction')
        .filter((i) => i.roomId === r.id && !['resolved', 'responded'].includes(i.status)).length +
        mentions.length >
      Number(r.policy.maxPending)
    )
      throw new E('pending', 'Pending interaction limit reached', 409);
    const seen = new Set();
    for (const m of mentions) {
      const s = store.get<Seat>('seat', m.seatId);
      if (
        !s ||
        s.roomId !== r.id ||
        s.status === 'left' ||
        m.seatId === sender ||
        seen.has(m.seatId) ||
        !['question', 'review', 'challenge'].includes(m.intent)
      )
        throw new E('recipient', 'Invalid recipient');
      seen.add(m.seatId);
    }
    const e = ev(a, r.id, 'message', {
      text: redactPublic(text),
      senderId: sender,
      mentions,
      replyToId: x.replyToId ?? null,
    });
    for (const m of mentions) {
      const i: I = {
        id: randomUUID(),
        roomId: r.id,
        senderId: sender,
        recipientId: m.seatId,
        messageId: e.id,
        intent: m.intent,
        status: 'stored',
        hop,
        createdAt: Date.now(),
      };
      store.put('interaction', i.id, i);
    }
    if (reply) {
      store.put('interaction', reply.id, {
        ...reply,
        status: 'responded',
        respondedAt: Date.now(),
        responseId: e.id,
      });
      ev(a, r.id, 'interaction.responded', { interactionId: reply.id, responseId: e.id });
    }
    return e;
  };
  c.register('room_post', post);
  const read = (a: Actor, x: ToolArgs) => {
    const r = access(a, str(x, 'roomId')),
      cursor = Math.max(0, Number(x.cursor ?? 0)),
      events = store.events(r.id, cursor, Math.min(100, Number(x.limit ?? 100)));
    if (a.kind === 'agent') {
      const s = member(a, r.id);
      for (const i of store.list<I>('interaction'))
        if (
          i.roomId === r.id &&
          i.recipientId === s.id &&
          ['stored', 'delivered'].includes(i.status) &&
          events.some((e) => e.id === i.messageId)
        )
          store.put('interaction', i.id, {
            ...i,
            status: 'read',
            readAt: Date.now(),
            deliveredAt: i.deliveredAt ?? Date.now(),
          });
    }
    return { events, cursor: events.at(-1)?.seq ?? cursor };
  };
  c.register('room_read', read);
  c.register('room_wait', async (a, x) => {
    access(a, str(x, 'roomId'));
    const end = Date.now() + Math.max(0, Math.min(30000, Number(x.timeoutMs ?? 20000)));
    let r = read(a, x);
    while (!r.events.length && Date.now() < end) {
      await new Promise((r) => setTimeout(r, Math.min(250, end - Date.now())));
      r = read(a, x);
    }
    return r;
  });
  c.register('room_inbox', (a, x) => {
    const r = access(a, str(x, 'roomId')),
      s = a.kind === 'agent' ? member(a, r.id) : undefined;
    const interactions = store
      .list<I>('interaction')
      .filter(
        (i) => i.roomId === r.id && (!s || i.recipientId === s.id) && i.status !== 'resolved',
      );
    if (s)
      for (const i of interactions)
        if (i.status === 'stored') {
          i.status = 'delivered';
          i.deliveredAt = Date.now();
          store.put('interaction', i.id, i);
        }
    return {
      interactions,
      turns: store
        .list<Turn>('turn')
        .filter(
          (t) =>
            t.roomId === r.id &&
            (!s || t.seatId === s.id) &&
            !['completed', 'failed', 'cancelled'].includes(t.status),
        ),
    };
  });
  c.register('interaction_resolve', (a, x) => {
    const r = host(a, str(x, 'roomId')),
      i = store.get<I>('interaction', str(x, 'interactionId'));
    if (!i || i.roomId !== r.id) throw new E('interaction', 'Interaction not found');
    store.put('interaction', i.id, {
      ...i,
      status: 'resolved',
      resolvedReason: str(x, 'reason'),
      resolvedAt: Date.now(),
    });
    ev(a, r.id, 'interaction.resolved', { interactionId: i.id });
    return store.get('interaction', i.id);
  });
  for (const n of ['room_set_agenda', 'room_propose_decision'])
    c.register(n, (a, x) => {
      const r = host(a, str(x, 'roomId'));
      write(a, r.id);
      const rounds = Number(r.rounds ?? 0);
      if (n === 'room_set_agenda') {
        if (rounds >= Number(r.policy.maxRounds))
          throw new E('budget', 'Round budget exhausted; prepare handoff', 409);
        store.put('room', r.id, { ...r, rounds: rounds + 1 });
      }
      return ev(a, r.id, n === 'room_set_agenda' ? 'agenda' : 'decision', {
        ...redactPublic(x),
        unresolved: store
          .list<I>('interaction')
          .filter((i) => i.roomId === r.id && i.status !== 'resolved')
          .map((i) => i.id),
      });
    });
  c.register('host_transfer_request', (a, x) => {
    const r = host(a, str(x, 'roomId')),
      s = store.get<Seat>('seat', str(x, 'seatId'));
    if (!s || s.roomId !== r.id || s.role === 'observer' || s.status === 'left')
      throw new E('seat', 'Invalid host');
    return permission(a, r.id, 'host_transfer', { seatId: s.id }, 'Transfer orchestration');
  });
  c.register('host_transfer_confirm', (a, x) => {
    const p = store.get<Permission>('permission', str(x, 'requestId'));
    if (!p || p.action !== 'host_transfer' || p.status !== 'pending' || p.expiresAt < Date.now())
      throw new E('permission', 'Unavailable transfer');
    owner(a, p.roomId);
    const r = room(p.roomId),
      s = store.get<Seat>('seat', String(p.scope.seatId));
    if (!s || s.status === 'left') throw new E('seat', 'Target left');
    if (r.hostSeatId) {
      const old = store.get<Seat>('seat', r.hostSeatId)!;
      store.put('seat', old.id, { ...old, role: 'member' });
    }
    store.put('seat', s.id, { ...s, role: 'host' });
    store.put('room', r.id, { ...r, hostSeatId: s.id });
    store.put('permission', p.id, { ...p, status: 'granted' });
    ev(a, r.id, 'host.transferred', { seatId: s.id });
    return room(r.id);
  });
  for (const [n, status] of [
    ['room_pause', 'paused'],
    ['room_resume', 'open'],
    ['room_close', 'closed'],
  ] as const)
    c.register(n, (a, x) => {
      const r = host(a, str(x, 'roomId'));
      if (r.status === 'closed') throw new E('closed', 'Room is closed');
      store.put('room', r.id, { ...r, status });
      if (status !== 'open')
        for (const t of store.list<Turn>('turn'))
          if (t.roomId === r.id && (t.status === 'running' || t.status === 'dispatching' ||
            (status === 'closed' && t.status === 'queued')))
            store.put('turn', t.id, {
              ...t,
              status: t.status === 'queued' ? 'cancelled' : 'cancelling',
            });
      ev(a, r.id, 'room.' + status, { status });
      return room(r.id);
    });
  c.register('turn_request', (a, x) => {
    const r = a.kind === 'human' ? requireHumanParticipant(c, a, str(x, 'roomId')) : host(a, str(x, 'roomId'));
    write(a, r.id);
    const s = store.get<Seat>('seat', str(x, 'seatId'));
    if (!s || s.roomId !== r.id || s.status === 'left' || s.role === 'observer')
      throw new E('seat', 'Invalid target');
    if (!currentSeat(store, r, s)) throw new E('membership', 'Target membership is no longer active', 403);
    const consent = store.get<OwnerConsent>('owner_consent', s.id);
    if (s.ownerId !== a.ownerId) {
      if (!consent || consent.status !== 'active' || consent.membershipGeneration !== s.membershipGeneration ||
        !consent.allowedSenderOwnerIds.includes(a.ownerId))
        throw new E('consent', 'Target owner sender consent required', 403);
      const owned = new Set(store.list<Seat>('seat', { roomId: r.id }).filter((v) => v.ownerId === s.ownerId).map((v) => v.id));
      if (store.list<Turn>('turn', { roomId: r.id }).filter((v) => owned.has(v.seatId)).length >= consent.maxTurns)
        throw new E('budget', 'Target owner turn budget exhausted', 409);
    }
    if (s.mode === 'managed' && !s.consent)
      throw new E('consent', 'Target owner consent required', 403);
    if (
      store.count('turn', { roomId: r.id }) >=
        Number(r.policy.maxMessages) ||
      Date.now() - r.createdAt > Number(r.policy.maxDurationMs)
    )
      throw new E('budget', 'Turn/time budget exhausted', 409);
    const interaction = x.interactionId
      ? store.get<I>('interaction', str(x, 'interactionId'))
      : undefined;
    if (
      x.interactionId &&
      (!interaction ||
        interaction.roomId !== r.id ||
        interaction.recipientId !== s.id ||
        interaction.status === 'resolved' ||
        interaction.turnId)
    )
      throw new E('causal_wake', 'Interaction already scheduled or target mismatch', 409);
    if (x.attemptId) {
      const at = store.get<ToolArgs>('attempt', str(x, 'attemptId'));
      if (
        !at ||
        at.roomId !== r.id ||
        at.seatId !== s.id ||
        !['ready', 'completed'].includes(String(at.status)) ||
        Number(at.leaseExpiresAt) < Date.now()
      )
        throw new E('worker_binding', 'Current coding attempt required', 409);
    }
    const t: Turn = {
      id: randomUUID(),
      roomId: r.id,
      seatId: s.id,
      prompt: str(x, 'prompt'),
      requestedBy: a.principalId,
      status: 'queued',
      createdAt: Date.now(),
      policyVersion: r.policyVersion,
      ...(s.ownerId !== a.ownerId ? { senderOwnerId: a.ownerId, ownerConsentDigest: scopeDigest(consent),
        requesterMembershipGeneration: activeMembership(store, r.id, a.ownerId)?.generation,
        membershipGeneration: s.membershipGeneration, maxTurnMs: Math.min(consent!.maxTurnMs, Number(r.policy.maxTurnMs)) } : {}),
      ...(x.attemptId ? { attemptId: String(x.attemptId) } : {}),
      ...(interaction ? { interactionId: interaction.id } : {}),
      ...(x.remoteProposalId ? { remoteProposalId: String(x.remoteProposalId),
        maxTurnMs: Math.min(Number(r.policy.maxTurnMs), Number(store.get<ToolArgs>('remote_proposal', String(x.remoteProposalId))?.maxTurnMs)) } : {}),
    };
    if (s.mode === 'managed')
      t.permissionRequestId = permission(
        a,
        r.id,
        'turn_execute',
        turnExecutionScope(t, store),
        'Start managed ' + s.product + ' session. Vendor extra usage follows account settings.',
      ).id;
    store.put('turn', t.id, t);
    if (interaction) store.put('interaction', interaction.id, { ...interaction, turnId: t.id });
    ev(a, r.id, 'turn.queued', { ...t });
    return t;
  });
  c.register('turn_cancel', (a, x) => {
    const r = access(a, str(x, 'roomId')),
      t = store.get<Turn>('turn', str(x, 'turnId'));
    if (!t || t.roomId !== r.id) throw new E('turn', 'Turn not found');
    const target = store.get<Seat>('seat', t.seatId);
    if (a.kind === 'human' && target?.ownerId === a.ownerId) requireSeatOwner(c, a, target);
    else if (a.kind !== 'agent' || member(a, r.id).id !== t.seatId) host(a, r.id);
    if (['queued', 'running', 'dispatching'].includes(t.status))
      t.status = t.status === 'queued' ? 'cancelled' : 'cancelling';
    store.put('turn', t.id, t);
    ev(a, r.id, 'turn.cancel_requested', { turnId: t.id, status: t.status });
    return t;
  });
  const pollingTurn = (a: Actor, x: ToolArgs) => {
    const r = access(a, str(x, 'roomId'));
    if (a.kind !== 'agent') throw new E('agent_required', 'The target agent must acknowledge its turn', 403);
    const s = member(a, r.id), t = store.get<Turn>('turn', str(x, 'turnId'));
    if (!t || t.roomId !== r.id || t.seatId !== s.id || s.mode !== 'polling' || t.attemptId)
      throw new E('turn', 'Own polling turn required', 403);
    if (!currentTurnAuthority(store, t)) throw new E('consent', 'Current turn authority required', 403);
    if (t.ownerConsentDigest) {
      const consent = store.get<OwnerConsent>('owner_consent', s.id);
      if (!consent || consent.status !== 'active' || scopeDigest(consent) !== t.ownerConsentDigest ||
        s.membershipGeneration !== t.membershipGeneration || !consent.allowedSenderOwnerIds.includes(String(t.senderOwnerId)))
        throw new E('consent', 'Turn consent changed or expired', 403);
    }
    return { r, s, t };
  };
  c.register('turn_claim', (a, x) => store.transaction(() => {
    const { r, s, t } = pollingTurn(a, x);
    write(a, r.id);
    if (t.status !== 'queued') throw new E('turn', 'Turn is not queued', 409);
    if (!t.requestedBy || store.get('revoked', t.requestedBy))
      throw new E('revoked', 'Turn requester is unavailable', 403);
    const busy = store.list<Turn>('turn', { status: ['dispatching', 'running', 'cancelling'] });
    if (busy.length >= 2 || busy.filter((v) => v.roomId === r.id).length >= Number(r.policy.maxActiveTurns) ||
      busy.some((v) => v.seatId === s.id))
      throw new E('capacity', 'Active turn capacity reached', 409);
    const previous = store.list<Turn>('turn', { seatId: s.id })
      .reduce((last, v) => Math.max(last, v.completedAt ?? 0), 0);
    if (Date.now() - previous < Number(r.policy.cooldownMs)) throw new E('cooldown', 'Seat cooldown is active', 409);
    if (Date.now() - r.createdAt > Number(r.policy.maxDurationMs)) throw new E('budget', 'Room time budget exhausted', 409);
    const next = { ...t, status: 'running' as const, startedAt: Date.now() };
    store.put('turn', t.id, next);
    ev(a, r.id, 'turn.started', { turnId: t.id, externalPolling: true, newManagedSession: false });
    return next;
  }));
  c.register('turn_complete', (a, x) => store.transaction(() => {
    const { r, t } = pollingTurn(a, x), outcome = x.outcome ?? 'completed';
    if (outcome === 'cancelled') {
      if (t.status !== 'cancelling') throw new E('turn', 'No cancellation is awaiting acknowledgement', 409);
    } else {
      write(a, r.id);
      if (t.status !== 'running' || !['completed', 'failed'].includes(String(outcome)))
        throw new E('turn', 'Own active turn and valid outcome required', 409);
      if (outcome === 'completed' && t.maxTurnMs && Date.now() - Number(t.startedAt) >= t.maxTurnMs)
        throw new E('budget', 'Target owner turn time exhausted', 409);
    }
    const next: Turn = { ...t, status: outcome as Turn['status'], completedAt: Date.now(),
      ...(outcome === 'failed' ? { error: redactPublic(str(x, 'reason')) } : {}) };
    if (outcome === 'completed') post(a, { roomId: r.id, text: str(x, 'text'),
      ...(t.interactionId ? { replyToId: t.interactionId } : {}) });
    store.put('turn', t.id, next);
    ev(a, r.id, 'turn.' + outcome, { turnId: t.id, externalPolling: true,
      ...(next.error ? { error: next.error } : {}) });
    return next;
  }));
  c.register('permission_request', (a, x) => {
    const r = write(a, str(x, 'roomId'));
    if (!x.scope || typeof x.scope !== 'object' || Array.isArray(x.scope))
      throw new E('scope', 'Exact scope required');
    return permission(
      a,
      r.id,
      str(x, 'action', 128),
      x.scope as ToolArgs,
      String(x.summary ?? 'Review action'),
    );
  });
  c.register('permission_grant', (a, x) => {
    const p = store.get<Permission>('permission', str(x, 'requestId'));
    if (!p) throw new E('permission', 'Request not found');
    requireHumanParticipant(c, a, p.roomId);
    if (p.ownerId !== a.ownerId) throw new E('permission_owner', 'Permission owner required', 403);
    if (p.status !== 'pending' || p.expiresAt <= Date.now())
      throw new E('permission', 'Request expired or resolved', 409);
    if (p.action === 'vendor_tool') {
      const turn = store.get<Turn>('turn', String(p.scope.turnId));
      const target = turn ? store.get<Seat>('seat', turn.seatId) : undefined;
      if (!turn || turn.roomId !== p.roomId || turn.status !== 'running' ||
        !target?.consent || target.status === 'left' || target.product !== p.scope.product ||
        room(p.roomId).status !== 'open')
        throw new E('permission', 'Native approval is no longer active', 409);
    }
    if (
      (x.scopeDigest && x.scopeDigest !== p.scopeDigest) ||
      scopeDigest(p.scope) !== p.scopeDigest
    )
      throw new E('scope', 'Scope mismatch', 409);
    const g: Grant = {
      id: randomUUID(),
      requestId: p.id,
      roomId: p.roomId,
      ownerId: p.ownerId,
      action: p.action,
      scopeDigest: p.scopeDigest,
      expiresAt: p.expiresAt,
    };
    store.put('grant', g.id, g);
    store.put('permission', p.id, { ...p, status: 'granted' });
    ev(a, p.roomId, 'permission.granted', {
      requestId: p.id,
      scopeDigest: p.scopeDigest,
      expiresAt: p.expiresAt,
    });
    return g;
  });
  c.register('permission_deny', (a, x) => {
    const p = store.get<Permission>('permission', str(x, 'requestId'));
    if (!p) throw new E('permission', 'Request not found');
    requireHumanParticipant(c, a, p.roomId);
    if (p.ownerId !== a.ownerId) throw new E('permission_owner', 'Permission owner required', 403);
    store.put('permission', p.id, { ...p, status: 'denied' });
    return ev(a, p.roomId, 'permission.denied', { requestId: p.id });
  });
  c.register('runtime_capabilities', () => ({
    protocol: 1,
    polling: true,
    remote: false,
    previews: false,
    containment: 'trusted-local advisory',
    quota: 'unknown, shared allowance',
    apiFallback: false,
  }));
  c.register('room_usage', (a, x) => {
    const r = access(a, str(x, 'roomId'));
    return {
      messages: store.eventCount(r.id, 'message'),
      turns: store.count('turn', { roomId: r.id }),
      policy: r.policy,
      quota: 'unknown',
    };
  });
  for (const t of store.list<Turn>('turn', { status: ['dispatching', 'running', 'cancelling'] })) {
      store.put('turn', t.id, {
        ...t,
        status: 'uncertain',
        error: 'Restart across dispatch boundary. Inspect before replay.',
      });
      store.append(t.roomId, 'turn.uncertain', 'runtime', { turnId: t.id });
    }
  mountMembership(c);
  mountSharedArtefacts(c);
  return c;
}
