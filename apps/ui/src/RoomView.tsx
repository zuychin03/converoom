import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Archive, ArrowLeft, CornerDownRight, Milestone, Pause, Play, Plus, Search, Square } from 'lucide-react';
import { PHASES, PHASE_STEPS, type RoomPhase } from '../../../packages/shared/src/contracts.js';
import { isRecord, list, objects, string, type RecordData, type Snapshot } from './api.js';
import {
  addAgentAction,
  archiveRoomAction,
  closeRoomAction,
  inspectTurnAction,
  peerWakeAction,
  phaseAction,
  requestTurnAction,
  PRODUCTS,
  roundRobinAction,
  saveTemplateAction,
  seatProfileAction,
  stopRoundRobinAction,
} from './actions.js';
import { GrantSlip } from './Approvals.js';
import { Composer } from './Composer.js';
import { PulsePlot, Sparkline } from './PulsePlot.js';
import {
  DurationBar,
  Elapsed,
  Empty,
  ErrorNotice,
  Gauge,
  JsonDetails,
  LiveDuration,
  SeatCode,
  Status,
  When,
  useNow,
  type Action,
  type Run,
} from './components.js';
import {
  ACTIVE_TURN,
  FINDINGS,
  OPEN_TURN,
  activity,
  capabilityLine,
  profileLabel,
  data,
  fmtBytes,
  fmtClock,
  fmtDuration,
  num,
  pad,
  pendingPermissions,
  phaseLabel,
  roomEnded,
  roomEvents,
  roomSeats,
  seatState,
  shortId,
  turnEvidence,
  turnKind,
  turnTarget,
  turnTiming,
  visibleTurn,
  type Kind,
} from './model.js';

const FOLDED = new Set([
  'interaction.responded',
  'turn.dispatching',
  'turn.started',
  'turn.completed',
  'turn.failed',
  'turn.cancelled',
  'turn.uncertain',
  'turn.cancel_requested',
  'permission.granted',
  'permission.denied',
]);
const RECEIPT: Record<string, [Kind, string]> = {
  stored: ['idle', 'Stored'],
  delivered: ['idle', 'Delivered'],
  read: ['idle', 'Read'],
  responded: ['ok', 'Answered'],
  resolved: ['ok', 'Resolved'],
  reassigned: ['idle', 'Reassigned'],
};
const receipt = (interaction: RecordData): [Kind, string] =>
  RECEIPT[string(interaction, 'status')] ?? ['idle', string(interaction, 'status')];
const CONVERSATION = new Set(['message', 'agenda', 'decision', 'turn.queued', 'permission.requested', 'room.budget_exhausted']);
const conversational = (event: RecordData) =>
  CONVERSATION.has(string(event, 'type')) || (event.type === 'room.lifecycle' && data(event).lifecycle === 'cancelled');
const BUDGET_LINES: Record<string, (usage: RecordData, limits: RecordData) => string> = {
  message: (u, l) => `Message budget used up: ${num(u, 'messages') ?? '?'} of ${num(l, 'maxMessages') ?? '?'} messages.`,
  turn: (u, l) => `Turn budget used up: ${num(u, 'turns') ?? '?'} of ${num(l, 'maxMessages') ?? '?'} turns.`,
  time: (u, l) => `Time budget used up: ${fmtDuration(num(u, 'elapsedMs') ?? 0)} of ${fmtDuration(num(l, 'maxDurationMs') ?? 0)}.`,
};
const SYSTEM_LABELS: Record<string, string> = {
  'room.created': 'room opened',
  'seat.joined': 'seat joined',
  'seat.left': 'seat left',
  'seat.consent': 'consent',
  'seat.profile': 'model and effort',
  'policy.changed': 'limits',
  'host.transferred': 'host',
  'room.paused': 'paused',
  'room.open': 'resumed',
  'room.closed': 'closed',
  'room.lifecycle': 'room state',
  'room.phase': 'phase',
  'interaction.resolved': 'resolved',
  'interaction.wake_refused': 'no turn queued',
  'round_robin.approved': 'round robin',
  'round_robin.ended': 'round robin',
  'tasks.planned': 'tasks planned',
  'task.claimed': 'claim',
  'task.submitted': 'submission',
  'verification.completed': 'checks',
  'review.submitted': 'review',
  'candidate.prepared': 'candidate',
  'candidate.accepted': 'candidate accepted',
  'candidate.applied': 'candidate applied',
  'candidate.exported': 'branch exported',
  'context.imported': 'context imported',
  'thread.created': 'thread',
  'thread.archived': 'thread archived',
  'thread.summarized': 'summary',
  'context.pinned': 'pinned',
  'context.unpinned': 'unpinned',
  'directive.issued': 'directive',
  'directive.cleared': 'directive cleared',
  'directive.delivered': 'directive delivered',
  'interaction.reassigned': 'reassigned',
  'attempt.taken_over': 'handed over',
  'turn.amended': 'amended',
  'checkpoint.recorded': 'checkpoint',
  'checkpoint.unchanged': 'checkpoint',
  'checkpoint.skipped': 'checkpoint skipped',
  'attempt.rolled_back': 'rollback',
  'turn.inspected': 'inspection',
  'workspaces.removed': 'workspaces removed',
  'bridge.authorized': 'room connection approved',
  'bridge.revoked': 'room connection revoked',
  'remote.connected': 'connected',
  'remote.managed_enabled': 'managed discussion enabled',
  'remote.proposal_accepted': 'proposal accepted',
  'remote.proposal_declined': 'proposal declined',
  'remote.disconnected': 'disconnected',
};
function summarise(events: RecordData[]) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const label = SYSTEM_LABELS[string(event, 'type')] ?? string(event, 'type').replaceAll('.', ' ');
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => (count > 1 ? `${label} ×${count}` : label)).join(' · ');
}
type Block = { key: string; system: boolean; events: RecordData[] };

const SETTLED: Record<string, { kind: Kind; label: string }> = {
  draft: { kind: 'idle', label: 'Draft' },
  paused: { kind: 'paused', label: 'Paused' },
  completed: { kind: 'closed', label: 'Completed' },
  cancelled: { kind: 'closed', label: 'Cancelled' },
  archived: { kind: 'closed', label: 'Archived' },
};
export function roomStatus(room: RecordData, state: Snapshot): { kind: Kind; label: string } {
  const settled = SETTLED[string(room, 'lifecycle')];
  if (settled) return settled;
  const running = state.turns.filter(
    (t) => t.roomId === room.id && ACTIVE_TURN.includes(string(t, 'status')),
  ).length;
  if (room.lifecycle === 'pausing') return { kind: 'paused', label: running ? `Pausing · ${running} still running` : 'Pausing' };
  if (list(room, 'exhaustedBudgets').length) return { kind: 'warn', label: running ? `Budget used up · ${running} running` : 'Budget used up' };
  return running ? { kind: 'live', label: `${running} running` } : { kind: 'idle', label: 'Active' };
}
const indexRank = (room: RecordData) => (room.lifecycle === 'archived' ? 2 : roomEnded(room) ? 1 : 0);
const INACTIVE: Record<string, string> = {
  draft: 'This room is a draft. Start it to post and request turns.',
  pausing: 'This room is pausing. Resume it to post again.',
  paused: 'This room is paused. Resume it to post again.',
};

export function RoomIndex({
  state,
  roomId,
  setRoomId,
  createRoom,
  joinRoom,
}: {
  state: Snapshot;
  roomId: string;
  setRoomId: (id: string) => void;
  createRoom: () => void;
  joinRoom: () => void;
}) {
  const now = useNow(5000);
  const [query, setQuery] = useState('');
  const rooms = state.rooms
    .filter((room) =>
      `${string(room, 'title')} ${string(room, 'objective')} ${string(room, 'id')}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    )
    .sort(
      (a, b) =>
        indexRank(a) - indexRank(b) ||
        (num(b, 'createdAt') ?? 0) - (num(a, 'createdAt') ?? 0),
    );
  return (
    <nav className="room-index" aria-label="Rooms">
      <div className="panel-head">
        <h2 className="section-label">Rooms</h2>
        <button type="button" className="icon-button" aria-label="Create room" onClick={createRoom}>
          <Plus size={17} aria-hidden="true" />
        </button>
      </div>
      <label className="search">
        <Search size={14} aria-hidden="true" />
        <input
          aria-label="Search rooms"
          placeholder="Find a room"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <ul className="room-list">
        {rooms.map((room) => {
          const id = string(room, 'id');
          const status = roomStatus(room, state);
          const waiting = pendingPermissions(state, now, id).length;
          return (
            <li key={id}>
              <button
                type="button"
                className={`room-item${id === roomId ? ' on' : ''}`}
                aria-current={id === roomId ? 'true' : undefined}
                onClick={() => setRoomId(id)}
              >
                <span className="room-item-code num">{shortId(id)}</span>
                <span className="room-item-title">{string(room, 'title', 'Untitled room')}</span>
                <span className="room-item-state">
                  <Status kind={status.kind}>{status.label}</Status>
                  {waiting > 0 && <Status kind="needs">{waiting} waiting</Status>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {state.rooms.length === 0 && <p className="rail-note">Rooms you create or join appear here.</p>}
      {state.rooms.length > 0 && rooms.length === 0 && <p className="rail-note">No room matches.</p>}
      <button type="button" className="button ghost join" onClick={joinRoom}>
        Join by room ID
      </button>
    </nav>
  );
}

export function RoomView({
  room,
  state,
  humanId,
  run,
  openAction,
  focusSeq,
  setFocusSeq,
  onAllRooms,
  loadEarlier,
  shared = false,
  read,
}: {
  room: RecordData;
  state: Snapshot;
  humanId: string;
  run: Run;
  openAction: (action: Action) => void;
  focusSeq: number | null;
  setFocusSeq: (seq: number | null) => void;
  onAllRooms: () => void;
  loadEarlier?: () => Promise<void>;
  shared?: boolean;
  read?: Run;
}) {
  const now = useNow(5000);
  const id = string(room, 'id');
  const lifecycleState = string(room, 'lifecycle');
  const open = lifecycleState === 'active';
  const ended = roomEnded(room);
  const used = list(room, 'exhaustedBudgets');
  const silenced = used.includes('message') || used.includes('time');
  const policy = isRecord(room.policy) ? room.policy : {};
  const phase = string(room, 'phase', 'deliberation') as RoomPhase;
  const phaseAt = PHASES.indexOf(phase);
  const moves = Object.keys(PHASE_STEPS[phase] ?? {});
  const startedAt = num(room, 'startedAt') ?? num(room, 'createdAt') ?? now;
  const seats = roomSeats(state, id);
  const events = useMemo(() => roomEvents(state, id), [state, id]);
  const pending = pendingPermissions(state, now, id);
  const turns = state.turns.filter((t) => t.roomId === id);
  const states = new Map(seats.map((seat) => [string(seat, 'id'), seatState(seat, state, now)]));
  const live = new Set(seats.filter((s) => states.get(string(s, 'id'))?.kind === 'live').map((s) => string(s, 'id')));
  const plot = activity(state, room, seats, 40, now);
  const strip = activity(state, room, seats, 16, now);
  const [selected, setSelected] = useState<string>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const feed = useRef<HTMLDivElement>(null);
  const status = roomStatus(room, state);
  const host = seats.find((s) => s.id === room.hostSeatId);
  const messages = num(room, 'messageCount') ?? events.filter((e) => e.type === 'message').length;
  const first = num(events[0] ?? {}, 'seq') ?? 1;
  const plan = state.roundRobins.find((p) => p.roomId === id && ['proposed', 'running'].includes(string(p, 'status')));

  const [threadView, setThreadView] = useState('');
  const threads = state.threads.filter((t) => t.roomId === id);
  const viewing = threads.find((t) => t.id === threadView);
  // FR-64: a chosen thread narrows the catalogue to its own messages and records.
  const visible = events.filter(
    (event) =>
      !FOLDED.has(string(event, 'type')) &&
      !(event.type === 'permission.requested' && data(event).action === 'turn_execute') &&
      (!viewing || data(event).threadId === viewing.id),
  );
  const blocks: Block[] = [];
  for (const event of visible) {
    const system = !conversational(event);
    const last = blocks.at(-1);
    if (system && last?.system) last.events.push(event);
    else blocks.push({ key: string(event, 'id'), system, events: [event] });
  }
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const settled = useRef(false);
  useEffect(() => {
    const el = feed.current;
    if (!el) return;
    if (!settled.current || el.scrollHeight - el.scrollTop - el.clientHeight < 160) el.scrollTop = el.scrollHeight;
    settled.current = true;
  }, [visible.length]);
  useEffect(() => {
    if (focusSeq === null) return;
    document.getElementById(`entry-${focusSeq}`)?.scrollIntoView({ block: 'nearest' });
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFocusSeq(null);
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [focusSeq, setFocusSeq]);

  async function lifecycle(command: 'room_start' | 'room_pause' | 'room_resume') {
    setBusy(command);
    setError('');
    try {
      await run(command, { roomId: id });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The room did not change. Try again.');
    } finally {
      setBusy('');
    }
  }
  async function earlierEvents() {
    setBusy('earlier');
    setError('');
    try {
      await loadEarlier!();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Earlier events did not load. Try again.');
    } finally {
      setBusy('');
    }
  }
  const contexts = state.contexts.filter((c) => c.roomId === id).map((c) => ({ ...c, ref: '@context:' + string(c, 'slug') }));
  const requestTurn = (seat: RecordData, interactionId?: string) =>
    openAction(requestTurnAction(id, seat.id, interactionId, shared || seat.ownerId !== room.ownerId, contexts));
  const names = {
    seat: (seatId: unknown) =>
      seatId === humanId
        ? 'You'
        : string(state.seats.find((s) => s.id === seatId) ?? {}, 'name', 'Participant'),
    actor: (actorId: unknown) =>
      actorId === humanId
        ? 'You'
        : actorId === 'runtime'
          ? 'Runtime'
          : string(state.seats.find((s) => s.principalId === actorId && s.roomId === id) ?? {}, 'name', 'Agent'),
  };
  const ctx: EntryContext = { state, room, humanId, now, names, openAction, requestTurn, jump: setFocusSeq, shared };

  return (
    <>
      <section className="room-main" aria-labelledby="room-title">
        <header className="room-head">
          <div className="room-title-row">
            <button type="button" className="icon-button rooms-back" aria-label="All rooms" onClick={onAllRooms}>
              <ArrowLeft size={17} aria-hidden="true" />
            </button>
            <span className="room-code num" title={id}>
              {shortId(id)}
            </span>
            <h1 id="room-title">{string(room, 'title')}</h1>
            <Status kind={status.kind}>{status.label}</Status>
          </div>
          <p className="room-objective">{string(room, 'objective')}</p>
          <div className="room-meta">
            <span>{typeof room.remoteConnectionId === 'string' ? 'Remote agent room' : room.workflow === 'coding' ? 'Coding room' : 'Discussion room'}</span>
            <span>Host · {host ? string(host, 'name') : shared ? 'Room owner' : 'You'}</span>
            <span>Policy v{num(room, 'policyVersion') ?? 1}</span>
            <span>{policy.peerWake === true ? 'Agents can wake each other' : 'Host-led turns'}</span>
          </div>
          <ol className="stages room-phase" aria-label={`Phase ${phaseAt + 1} of ${PHASES.length}: ${phaseLabel(phase)}`}>
            {PHASES.map((p, i) => (
              <li key={p} className={i < phaseAt ? 'done' : i === phaseAt ? 'current' : ''} aria-current={i === phaseAt ? 'step' : undefined}>
                <span>{phaseLabel(p)}</span>
              </li>
            ))}
          </ol>
          <div className="room-gauges">
            <Gauge label="Messages" value={messages} max={num(policy, 'maxMessages') ?? 60} />
            {typeof room.remoteConnectionId !== 'string' && (
              <Gauge
                label="Minutes"
                value={lifecycleState === 'draft' ? 0 : Math.min((now - startedAt) / 60000, (num(policy, 'maxDurationMs') ?? 5400000) / 60000)}
                max={Math.round((num(policy, 'maxDurationMs') ?? 5400000) / 60000)}
              />
            )}
            <Gauge label="Turns" value={turns.length} max={num(policy, 'maxMessages') ?? 60} />
          </div>
          {!shared && <div className="room-actions">
            {lifecycleState === 'draft' && (
              <button type="button" className="button" disabled={!!busy} onClick={() => void lifecycle('room_start')}>
                <Play size={14} aria-hidden="true" />
                Start
              </button>
            )}
            {open && (
              <button type="button" className="button" disabled={!!busy} onClick={() => void lifecycle('room_pause')}>
                <Pause size={14} aria-hidden="true" />
                Pause
              </button>
            )}
            {(lifecycleState === 'pausing' || lifecycleState === 'paused') && (
              <button type="button" className="button" disabled={!!busy} onClick={() => void lifecycle('room_resume')}>
                <Play size={14} aria-hidden="true" />
                Resume
              </button>
            )}
            {!ended && lifecycleState !== 'draft' && moves.length > 0 && (
              <button type="button" className="button" onClick={() => openAction(phaseAction(id, phase))}>
                <Milestone size={14} aria-hidden="true" />
                Phase
              </button>
            )}
            {!ended && (
              <button type="button" className="button" onClick={() => openAction(closeRoomAction(id))}>
                <Square size={13} aria-hidden="true" />
                Close
              </button>
            )}
            {lifecycleState === 'completed' && (
              <button type="button" className="button" onClick={() => openAction(archiveRoomAction(id))}>
                <Archive size={14} aria-hidden="true" />
                Archive
              </button>
            )}
          </div>}
          {error && <ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice>}
        </header>
        <ul className="seat-strip" aria-label="Seats at a glance">
          {seats.map((seat, i) => {
            const seatId = string(seat, 'id');
            const st = states.get(seatId)!;
            return (
              <li key={seatId} className="strip-seat">
                <SeatCode id={seatId} />
                <span className="strip-name">{string(seat, 'name')}</span>
                <Sparkline values={strip.counts[i]} live={live.has(seatId)} />
                <Status kind={st.kind}>{st.kind === 'needs' ? 'Needs you' : st.label}</Status>
              </li>
            );
          })}
        </ul>
        {pending.length > 0 && (
          <section className="pinned" aria-label="Needs you">
            {pending.slice(0, 3).map((permission) => (
              <GrantSlip key={string(permission, 'id')} permission={permission} compact openAction={openAction} />
            ))}
            {pending.length > 3 && <p className="rail-note">{pending.length - 3} more in Approvals.</p>}
          </section>
        )}
        <div className="feed" ref={feed}>
          <h2 className="sr-only">Catalogue</h2>
          {viewing && (
            <p className="thread-bar">
              Showing thread <strong>{string(viewing, 'title')}</strong>
              <button type="button" className="text-button" onClick={() => setThreadView('')}>Show the whole room</button>
            </p>
          )}
          {loadEarlier && first > 1 && (
            <p className="feed-earlier">
              <button type="button" className="text-button" disabled={busy === 'earlier'} onClick={() => void earlierEvents()}>
                Load earlier events
              </button>
            </p>
          )}
          <ol className="catalogue" aria-label="Room catalogue">
            {blocks.flatMap((block) => {
              const seqs = block.events.map((event) => num(event, 'seq') ?? 0);
              const collapsed =
                block.system &&
                block.events.length >= 3 &&
                !expanded.has(block.key) &&
                !(focusSeq !== null && seqs.includes(focusSeq));
              if (collapsed)
                return [
                  <li key={block.key} className={`entry entry-group${focusSeq !== null ? ' dimmed' : ''}`}>
                    <span className="entry-num num" aria-hidden="true">
                      {pad(seqs[0])}
                    </span>
                    <div className="system-line">
                      <p className="entry-text system">
                        {pad(seqs[0])}–{pad(seqs.at(-1)!)} · {summarise(block.events)}
                      </p>
                      <button
                        type="button"
                        className="text-button"
                        onClick={() => setExpanded((keys) => new Set(keys).add(block.key))}
                      >
                        Show {block.events.length} room events
                      </button>
                    </div>
                  </li>,
                ];
              return block.events.map((event) => {
                const seq = num(event, 'seq') ?? 0;
                return (
                  <Entry
                    key={string(event, 'id')}
                    event={event}
                    ctx={ctx}
                    focused={focusSeq === seq}
                    dimmed={focusSeq !== null && focusSeq !== seq}
                    toggle={() => setFocusSeq(focusSeq === seq ? null : seq)}
                  />
                );
              });
            })}
          </ol>
          {messages === 0 && (
            <p className="feed-hint">
              No messages yet. Post the first position below, or type @ to direct a question at a seat.
              Text names alone never wake an agent.
            </p>
          )}
        </div>
        <Composer roomId={id} seats={seats} run={run} contexts={contexts}
          thread={viewing?.status === 'open' ? { id: string(viewing, 'id'), title: string(viewing, 'title') } : undefined}
          disabled={!open || silenced}
          reason={open ? (silenced ? 'This room’s budget is used up. See the handoff above.' : undefined)
            : INACTIVE[lifecycleState] ?? `This room is ${lifecycleState} and cannot reopen.`} />
      </section>
      <aside className="activity" aria-label="Agents and turns">
        <section className="panel">
          <h2 className="section-label">Activity</h2>
          {seats.length ? (
            <>
              <PulsePlot seats={seats} counts={plot.counts} live={live} selected={selected} />
              <p className="caption">
                Room events per interval since {fmtClock(plot.start)}. The live seat is drawn in red.
              </p>
            </>
          ) : (
            <p className="rail-note">The plot draws each seat's real activity once seats join.</p>
          )}
        </section>
        <section className="panel">
          <div className="panel-head">
            <h2 className="section-label">Seats</h2>
            {!shared && <button
              type="button"
              className="icon-button"
              aria-label="Add agent"
              disabled={!open && lifecycleState !== 'draft'}
              onClick={() => openAction(addAgentAction(id))}
            >
              <Plus size={17} aria-hidden="true" />
            </button>}
          </div>
          {seats.length === 0 && (
            <p className="rail-note">
              Add a managed agent, or connect an existing MCP conversation and let it join this room.
            </p>
          )}
          <ul className="seat-list">
            {seats.map((seat) => (
              <SeatRow
                key={string(seat, 'id')}
                seat={seat}
                st={states.get(string(seat, 'id'))!}
                roomOpen={open && !used.length}
                run={run}
                selected={selected === seat.id}
                onSelect={setSelected}
                requestTurn={() => requestTurn(seat)}
                editProfile={() => openAction(seatProfileAction(seat, state.discovery))}
                shared={shared}
                remote={seat.ownerId !== room.ownerId}
                ownerLabel={string(state.members.find((m) => m.ownerId === seat.ownerId) ?? {}, 'displayName', 'Local room owner')}
              />
            ))}
          </ul>
        </section>
        {!shared && read && (
          <ContextPanel roomId={id} contexts={contexts} open={!ended} sharedRoom={seats.some((s) => s.ownerId !== room.ownerId) ||
            state.members.some((m) => m.roomId === id && m.status === 'active')} read={read} openAction={openAction} />
        )}
        {!shared && (
          <ThreadsPanel roomId={id} roomSeq={num(room, 'seq') ?? 0} threads={threads} seats={seats} open={!ended} view={threadView}
            setView={setThreadView} summaries={state.threadSummaries.filter((s) => s.roomId === id)} openAction={openAction} />
        )}
        {!shared && (
          <DirectivesPanel roomId={id} open={!ended} seats={seats} threads={threads}
            directives={state.directives.filter((d) => d.roomId === id)} openAction={openAction} />
        )}
        {!shared && (
          <PinsPanel roomId={id} threads={threads} open={!ended} pins={state.pins.filter((p) => p.roomId === id && p.status === 'active')}
            openAction={openAction} />
        )}
        {!shared && plan && <RoundRobinPanel plan={plan} state={state} names={names} openAction={openAction} />}
        {!shared && <RoomControls room={room} state={state} seats={seats} names={names} planOpen={!!plan} openAction={openAction} />}
      </aside>
    </>
  );
}

function SeatRow({
  seat,
  st,
  roomOpen,
  run,
  selected,
  onSelect,
  requestTurn,
  editProfile,
  shared,
  remote,
  ownerLabel,
}: {
  seat: RecordData;
  st: ReturnType<typeof seatState>;
  roomOpen: boolean;
  run: Run;
  selected: boolean;
  onSelect: (id: string | undefined) => void;
  requestTurn: () => void;
  editProfile: () => void;
  shared?: boolean;
  remote?: boolean;
  ownerLabel: string;
}) {
  const id = string(seat, 'id');
  const managed = seat.mode === 'managed';
  const consent = seat.consent === true;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function toggle() {
    setBusy(true);
    setError('');
    try {
      await run('seat_consent', { roomId: seat.roomId, seatId: id, consent: !consent });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Consent did not change.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <li
      className={`seat${selected ? ' selected' : ''}`}
      onMouseEnter={() => onSelect(id)}
      onMouseLeave={() => onSelect(undefined)}
      onFocus={() => onSelect(id)}
    >
      <div className="seat-line">
        <SeatCode id={id} />
        <span className="seat-name">{string(seat, 'name')}</span>
        {seat.role === 'host' && <span className="tag">Host</span>}
        {seat.role === 'observer' && <span className="tag">Observer</span>}
      </div>
      <Status kind={st.kind}>
        {st.label}
        {st.since !== undefined && (
          <>
            {' '}
            <Elapsed since={st.since} />
          </>
        )}
      </Status>
      <p className="seat-meta">
        Owner · {ownerLabel}<br />
        {string(seat, 'product')} ·{' '}
        {managed ? 'new managed session per turn' : 'polls its inbox, outside runtime control'}<br />
        {managed && <>Model and effort · {profileLabel(seat.profile) || 'agent defaults'}<br /></>}
        {capabilityLine(seat)}
      </p>
      {(managed || shared || remote) && turnTarget(seat) && (
        <div className="seat-actions">
          {!shared && !remote && <button
            type="button"
            role="switch"
            aria-checked={consent}
            className="switch"
            disabled={busy}
            onClick={() => void toggle()}
          >
            <span className="switch-track" aria-hidden="true">
              <i />
            </span>
            Allow turn requests
          </button>}
          <button type="button" className="button small" disabled={!roomOpen || (!shared && !remote && !consent)} onClick={requestTurn}>
            <Play size={12} aria-hidden="true" />
            Request turn
          </button>
          {managed && !shared && !remote && (
            <button type="button" className="button small" onClick={editProfile}>
              Model and effort
            </button>
          )}
        </div>
      )}
      {error && <ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice>}
    </li>
  );
}

type Names = { seat: (id: unknown) => string; actor: (id: unknown) => string };

const PIN_NOTE = 'A pin comes first in every turn\'s context and newer messages never push it out. Only you can pin or unpin; a host can only propose a pin for your approval.';
function ThreadsPanel({
  roomId,
  roomSeq,
  threads,
  seats,
  summaries,
  open,
  view,
  setView,
  openAction,
}: {
  roomId: string;
  roomSeq: number;
  threads: RecordData[];
  seats: RecordData[];
  summaries: RecordData[];
  open: boolean;
  view: string;
  setView: (id: string) => void;
  openAction: (action: Action) => void;
}) {
  const title = (id: unknown) => string(threads.find((t) => t.id === id) ?? {}, 'title', 'the room');
  const latest = [...summaries].sort((a, b) => (num(b, 'createdAt') ?? 0) - (num(a, 'createdAt') ?? 0)).slice(0, 5);
  return (
    <section className="panel" aria-labelledby="threads-title">
      <div className="panel-head">
        <h2 className="section-label" id="threads-title">Threads</h2>
        {open && (
          <div className="row-actions">
            <button type="button" className="button small" onClick={() => openAction({
              title: 'New thread', command: 'thread_create', args: { roomId }, label: 'Open thread',
              description: 'A thread keeps a side discussion apart. A turn requested in it sees the thread\'s recent messages instead of the whole room\'s.',
              fields: [{ key: 'title', label: 'Title', required: true }, { key: 'topic', label: 'Topic', type: 'textarea' },
                ...(seats.length ? [{ key: 'seatIds', label: 'Agents involved', type: 'choices' as const,
                  options: seats.map((s) => ({ value: string(s, 'id'), label: string(s, 'name') })) }] : [])],
              prepare: ({ topic, seatIds, ...rest }) => ({ ...rest, ...(String(topic ?? '').trim() ? { topic } : {}),
                ...(Array.isArray(seatIds) && seatIds.length ? { seatIds } : {}) }),
            })}>New</button>
            <button type="button" className="button small" onClick={() => openAction({
              title: 'Summarise events', command: 'thread_summarize', args: { roomId }, label: 'Save summary',
              description: 'A summary keeps earlier rationale in every later turn\'s context while the events themselves stay readable.',
              fields: [{ key: 'summary', label: 'Summary', type: 'textarea', required: true },
                { key: 'fromSeq', label: 'From event', type: 'number', value: '1', required: true, min: 1 },
                { key: 'toSeq', label: 'To event', type: 'number', value: String(roomSeq), required: true, min: 1 }],
            })}>Summarise</button>
          </div>
        )}
      </div>
      {threads.length === 0 ? (
        <p className="rail-note">Open a thread to keep a side discussion, or the talk about one task, out of the main timeline.</p>
      ) : (
        <ul className="context-list">
          {threads.map((t) => (
            <li key={string(t, 'id')}>
              <span className="context-title">{string(t, 'title')}</span>
              <span className="context-meta">{t.status === 'open' ? 'Open' : 'Archived'}{string(t, 'topic') ? ' · ' + string(t, 'topic') : ''}</span>
              <span className="row-actions">
                <button type="button" className="text-button" aria-pressed={view === t.id}
                  onClick={() => setView(view === t.id ? '' : string(t, 'id'))}>
                  {view === t.id ? 'Showing' : 'Show'}
                </button>
                {open && t.status === 'open' && (
                  <button type="button" className="text-button" onClick={() => openAction({
                    title: 'Archive thread', command: 'thread_archive', args: { roomId, threadId: t.id }, label: 'Archive thread',
                    description: 'Archiving closes the thread to new messages. A summary, if you add one, keeps its outcome in later turns\' context.',
                    fields: [{ key: 'summary', label: 'Summary', type: 'textarea' }],
                    prepare: ({ summary, ...rest }) => (String(summary ?? '').trim() ? { ...rest, summary } : rest),
                  })}>Archive</button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {latest.length > 0 && (
        <>
          <h3 className="section-label panel-subhead">Summaries</h3>
          <ul className="context-list">
            {latest.map((s) => (
              <li key={string(s, 'id')}>
                <span className="context-meta">
                  {title(s.threadId)} · events {pad(num(s, 'fromSeq') ?? 0)} to {pad(num(s, 'toSeq') ?? 0)} · {s.agentWritten ? 'agent, untrusted' : 'owner'}
                </span>
                <span className="context-title">{string(s, 'text')}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
const DIRECTIVE_MODES: Record<string, string> = { steer_next: 'next turns', inject_mid_turn: 'mid-turn', interrupt_and_amend: 'interrupt and amend' };
const DELIVERY: Record<string, [Kind, string]> = { queued: ['idle', 'Waiting'], delivered: ['ok', 'Delivered on a read'], applied: ['ok', 'In a turn'] };
function DirectivesPanel({ roomId, open, seats, threads, directives, openAction }: {
  roomId: string;
  open: boolean;
  seats: RecordData[];
  threads: RecordData[];
  directives: RecordData[];
  openAction: (action: Action) => void;
}) {
  const recent = [...directives].sort((a, b) => (num(b, 'createdAt') ?? 0) - (num(a, 'createdAt') ?? 0)).slice(0, 5);
  const live = threads.filter((t) => t.status === 'open');
  const named = (id: string) => string(seats.find((s) => s.id === id) ?? {}, 'name', 'A seat');
  return (
    <section className="panel" aria-labelledby="directives-title">
      <div className="panel-head">
        <h2 className="section-label" id="directives-title">Directives</h2>
        {open && seats.length > 0 && (
          <button type="button" className="button small" onClick={() => openAction({
            title: 'Barge in', command: 'room_barge_in', args: { roomId }, label: 'Send directive',
            description: 'Each chosen seat receives your directive once: managed seats at the top of their next turn, and any seat on its next room read if you choose mid-turn delivery. Use Interrupt and amend on a running turn to stop it now.',
            fields: [
              { key: 'text', label: 'Directive', type: 'textarea', required: true },
              { key: 'mode', label: 'Delivery', type: 'select', value: 'steer_next', required: true,
                options: [{ value: 'steer_next', label: 'Before each seat\'s next turn' }, { value: 'inject_mid_turn', label: 'Mid-turn, on its next room read' }] },
              ...(live.length ? [{ key: 'threadId', label: 'Only in thread', type: 'select' as const, placeholder: 'Whole room',
                options: live.map((t) => ({ value: string(t, 'id'), label: string(t, 'title') })) }] : []),
              { key: 'seatIds', label: 'Seats (all when none are chosen)', type: 'choices',
                options: seats.filter((s) => s.role !== 'observer').map((s) => ({ value: string(s, 'id'), label: string(s, 'name') })) },
            ],
            prepare: ({ threadId, seatIds, ...rest }) => ({ ...rest, ...(threadId ? { threadId } : {}),
              ...(Array.isArray(seatIds) && seatIds.length ? { seatIds } : {}) }),
          })}>Barge in</button>
        )}
      </div>
      {recent.length === 0 ? (
        <p className="rail-note">Barge in to steer agents mid-session. You see here when each seat received your directive.</p>
      ) : (
        <ul className="context-list">
          {recent.map((d) => (
            <li key={string(d, 'id')}>
              <span className="context-title">{string(d, 'text')}</span>
              <span className="context-meta">
                {DIRECTIVE_MODES[string(d, 'mode')] ?? string(d, 'mode')} · {d.status === 'active' ? 'active' : d.status === 'done' ? 'delivered to every seat' : 'cleared'}
              </span>
              {open && d.status === 'active' && (d.mode !== 'interrupt_and_amend' || typeof d.note === 'string') && (
                <button type="button" className="text-button" onClick={() => openAction({
                  title: 'Clear directive', command: 'directive_clear', args: { roomId, directiveId: d.id }, label: 'Clear directive',
                  confirm: 'Seats that have not received it yet will not get it.',
                })}>Clear</button>
              )}
              {typeof d.note === 'string' && <span className="context-meta directive-note">{d.note}</span>}
              <span className="directive-delivery">
                {Object.entries(isRecord(d.delivery) ? d.delivery : {}).map(([seatId, v]) => {
                  const [kind, label] = DELIVERY[string(isRecord(v) ? v : {}, 'state')] ?? ['idle', 'Waiting'];
                  return <Status key={seatId} kind={kind}>{named(seatId)} · {label}</Status>;
                })}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
function PinsPanel({ roomId, threads, pins, open, openAction }: {
  roomId: string;
  threads: RecordData[];
  pins: RecordData[];
  open: boolean;
  openAction: (action: Action) => void;
}) {
  const live = threads.filter((t) => t.status === 'open');
  return (
    <section className="panel" aria-labelledby="pins-title">
      <div className="panel-head">
        <h2 className="section-label" id="pins-title">Pins</h2>
        {open && (
          <button type="button" className="button small" onClick={() => openAction({
            title: 'Pin as a room invariant', command: 'context_pin', args: { roomId }, label: 'Pin', description: PIN_NOTE,
            fields: [{ key: 'text', label: 'Pinned text', type: 'textarea', required: true },
              ...(live.length ? [{ key: 'threadId', label: 'Only in thread', type: 'select' as const, placeholder: 'Whole room',
                options: live.map((t) => ({ value: string(t, 'id'), label: string(t, 'title') })) }] : [])],
            prepare: ({ threadId, ...rest }) => (threadId ? { ...rest, threadId } : rest),
          })}>Pin</button>
        )}
      </div>
      {pins.length === 0 ? (
        <p className="rail-note">Pin the constraints every turn must keep. Pins come first in each turn's context.</p>
      ) : (
        <ul className="context-list">
          {pins.map((p) => (
            <li key={string(p, 'id')}>
              <span className="context-title">{string(p, 'text')}</span>
              <span className="context-meta">
                {p.threadId ? 'Thread ' + string(threads.find((t) => t.id === p.threadId) ?? {}, 'title') : 'Whole room'}
                {p.requestId ? ' · approved host proposal' : ''}
              </span>
              {open && (
                <button type="button" className="text-button" onClick={() => openAction({
                  title: 'Remove pin', command: 'context_unpin', args: { roomId, pinId: p.id }, label: 'Remove pin',
                  confirm: 'Later turns will no longer receive this pin.',
                })}>Unpin</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
const VIA: Record<string, string> = { paste: 'pasted', mcp: 'from an agent', codex_thread: 'Codex thread', participant: 'from a participant' };
function ContextPanel({
  roomId,
  contexts,
  open,
  sharedRoom,
  read,
  openAction,
}: {
  roomId: string;
  contexts: RecordData[];
  open: boolean;
  sharedRoom: boolean;
  read: Run;
  openAction: (action: Action) => void;
}) {
  const [view, setView] = useState<RecordData>();
  const [error, setError] = useState('');
  const fail = (cause: unknown) => setError(cause instanceof Error ? cause.message : 'That did not load. Try again.');
  const reach = sharedRoom ? ' This room is shared, so the other owners can read it once it is imported.' : '';
  const paste = () => openAction({
    title: 'Import context', command: 'session_context_import', args: { roomId }, label: 'Import context',
    description: 'Paste an excerpt of a conversation and a short summary. Credentials, private reasoning and script blocks are removed before it is stored. ' +
      'A turn that references it gets the summary and can fetch the excerpt.' + reach,
    fields: [
      { key: 'title', label: 'Title', required: true },
      { key: 'product', label: 'From', type: 'select', value: 'other',
        options: [...PRODUCTS, { value: 'other', label: 'Something else' }] },
      { key: 'summary', label: 'Summary for agents', type: 'textarea', required: true },
      { key: 'excerpt', label: 'Excerpt', type: 'textarea', required: true },
    ],
  });
  const codex = () => {
    setError('');
    read('session_context_codex_threads', {}).then((result) => {
      const threads = isRecord(result) ? objects(result, 'threads') : [];
      if (!threads.length) return setError('Codex has no recent threads to import.');
      openAction({
        title: 'Import a Codex thread', command: 'session_context_import_codex', args: { roomId }, label: 'Import thread',
        description: 'Reads the thread\'s user and Codex messages through Codex\'s history calls without resuming it; reasoning and tool output are left out.' + reach,
        fields: [
          { key: 'threadId', label: 'Thread', type: 'select', required: true,
            options: threads.map((t) => ({ value: string(t, 'id'), label: string(t, 'preview') || string(t, 'id') })) },
          { key: 'summary', label: 'Summary for agents', type: 'textarea', required: true },
        ],
      });
    }, fail);
  };
  return (
    <section className="panel" aria-labelledby="context-title">
      <div className="panel-head">
        <h2 className="section-label" id="context-title">Context</h2>
        {open && (
          <div className="row-actions">
            <button type="button" className="button small" onClick={paste}>Import</button>
            <button type="button" className="button small" onClick={codex}>From Codex</button>
          </div>
        )}
      </div>
      {error && <ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice>}
      {contexts.length === 0 ? (
        <p className="rail-note">Import a conversation excerpt to give agents its summary when a message or turn attaches it with @.</p>
      ) : (
        <ul className="context-list">
          {contexts.map((c) => (
            <li key={string(c, 'id')}>
              <code>{string(c, 'ref')}</code>
              <span className="context-title">{string(c, 'title')}</span>
              <span className="context-meta">
                {VIA[string(isRecord(c.source) ? c.source : {}, 'via')] ?? 'imported'} · {fmtBytes(num(c, 'bytes') ?? 0)}
              </span>
              <button type="button" className="text-button" aria-pressed={view?.id === c.id}
                onClick={() => (view?.id === c.id ? setView(undefined)
                  : read('session_context_get', { roomId, slug: string(c, 'slug') }).then((r) => setView(isRecord(r) ? r : undefined), fail))}>
                {view?.id === c.id ? 'Hide' : 'View'}
              </button>
              {view && view.id === c.id && (
                <div className="context-view">
                  <p>{string(view, 'summary')}</p>
                  <pre tabIndex={0} aria-label={'Excerpt of ' + string(c, 'ref')}>{string(view, 'excerpt')}</pre>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RoundRobinPanel({
  plan,
  state,
  names,
  openAction,
}: {
  plan: RecordData;
  state: Snapshot;
  names: Names;
  openAction: (action: Action) => void;
}) {
  const order = list(plan, 'seatIds'), queued = list(plan, 'turnIds');
  const rounds = num(plan, 'rounds') ?? 1, total = order.length * rounds;
  const proposed = plan.status === 'proposed';
  const last = state.turns.find((t) => t.id === queued.at(-1));
  const at = Math.min(last && OPEN_TURN.includes(string(last, 'status')) ? queued.length - 1 : queued.length, total - 1);
  const round = Math.floor(at / order.length);
  return (
    <section className="panel" aria-labelledby="round-robin-title">
      <div className="panel-head">
        <h2 className="section-label" id="round-robin-title">Round robin</h2>
        <Status kind={proposed ? 'needs' : 'live'}>{proposed ? 'Awaiting approval' : `Turn ${at + 1} of ${total}`}</Status>
      </div>
      <ol className="plan-order" aria-label={`Speaking order, round ${round + 1} of ${rounds}`}>
        {order.map((seatId, i) => {
          const k = round * order.length + i, current = !proposed && k === at;
          return (
            <li key={String(seatId)} className={!proposed && k < at ? 'done' : current ? 'current' : ''} aria-current={current ? 'step' : undefined}>
              {names.seat(seatId)}
            </li>
          );
        })}
      </ol>
      <p className="caption">
        Round {round + 1} of {rounds}. {proposed ? 'Approve the plan in the pinned request above.' : 'Each turn starts once the one before it completes.'}
      </p>
      <button type="button" className="button small" onClick={() => openAction(stopRoundRobinAction(string(plan, 'roomId')))}>
        <Square size={12} aria-hidden="true" />
        Stop round robin
      </button>
    </section>
  );
}

function RoomControls({
  room,
  state,
  seats,
  names,
  planOpen,
  openAction,
}: {
  room: RecordData;
  state: Snapshot;
  seats: RecordData[];
  names: Names;
  planOpen: boolean;
  openAction: (action: Action) => void;
}) {
  const id = string(room, 'id');
  const open = room.lifecycle === 'active';
  const ended = roomEnded(room);
  const policy = isRecord(room.policy) ? room.policy : {};
  const peerWake = policy.peerWake === true;
  const obligations = state.interactions.filter((i) => i.roomId === id && i.status !== 'resolved');
  return (
    <details className="panel controls">
      <summary>Room controls</summary>
      <div className="control-grid">
        <button
          type="button"
          className="button small"
          disabled={!open}
          onClick={() =>
            openAction({
              title: 'Set agenda',
              command: 'room_set_agenda',
              args: { roomId: id },
              fields: [{ key: 'agenda', label: 'Agenda', type: 'textarea', required: true }],
            })
          }
        >
          Set agenda
        </button>
        <button
          type="button"
          className="button small"
          disabled={!open}
          onClick={() =>
            openAction({
              title: 'Propose decision',
              command: 'room_propose_decision',
              args: { roomId: id },
              fields: [
                { key: 'decision', label: 'Decision', type: 'textarea', required: true },
                { key: 'dissent', label: 'Dissent, one per line', type: 'paths' },
                { key: 'evidence', label: 'Evidence, one per line', type: 'paths' },
              ],
            })
          }
        >
          Propose decision
        </button>
        <button
          type="button"
          className="button small"
          onClick={() =>
            openAction({
              title: 'Change limits',
              command: 'policy_update',
              args: { roomId: id },
              description: 'Limits can only be lowered, except active turns (up to 5). Each change creates a new policy version.',
              fields: [
                {
                  key: 'policy',
                  label: 'Policy limits',
                  type: 'json',
                  value: JSON.stringify(room.policy, null, 2),
                  required: true,
                },
              ],
            })
          }
        >
          Change limits
        </button>
        <button
          type="button"
          className="button small"
          disabled={!seats.some((s) => s.role !== 'observer')}
          onClick={() =>
            openAction({
              title: 'Request host transfer',
              command: 'host_transfer_request',
              args: { roomId: id },
              fields: [
                {
                  key: 'seatId',
                  label: 'New host',
                  type: 'select',
                  required: true,
                  options: seats
                    .filter((s) => s.role !== 'observer')
                    .map((s) => ({ value: string(s, 'id'), label: string(s, 'name') })),
                },
              ],
            })
          }
        >
          Transfer host
        </button>
        <button
          type="button"
          className="button small"
          disabled={ended || planOpen || !seats.some((s) => s.role !== 'observer')}
          onClick={() => openAction(roundRobinAction(id, seats, num(policy, 'maxRounds') ?? 6, room.template))}
        >
          Round robin
        </button>
        <button type="button" className="button small" disabled={ended} onClick={() => openAction(peerWakeAction(id, peerWake))}>
          {peerWake ? 'Stop agent wakes' : 'Allow agent wakes'}
        </button>
        <button type="button" className="button small" onClick={() => openAction(saveTemplateAction(id))}>
          Save as template
        </button>
      </div>
      <h3 className="section-label">Open obligations</h3>
      {obligations.length === 0 && <p className="rail-note">No unresolved questions.</p>}
      <ul className="obligations">
        {obligations.map((i) => {
          const [kind, label] = receipt(i);
          return (
            <li key={string(i, 'id')}>
              <span>
                {names.seat(i.senderId)} → {names.seat(i.recipientId)}
              </span>
              <Status kind={kind}>{label}</Status>
              <button
                type="button"
                className="button small"
                onClick={() =>
                  openAction({
                    title: 'Resolve interaction',
                    command: 'interaction_resolve',
                    args: { roomId: id, interactionId: i.id },
                    fields: [{ key: 'reason', label: 'Resolution and remaining risks', type: 'textarea', required: true }],
                  })
                }
              >
                Resolve
              </button>
            </li>
          );
        })}
      </ul>
    </details>
  );
}

interface EntryContext {
  state: Snapshot;
  room: RecordData;
  humanId: string;
  now: number;
  names: Names;
  openAction: (action: Action) => void;
  requestTurn: (seat: RecordData, interactionId?: string) => void;
  jump: (seq: number | null) => void;
  shared?: boolean;
  focused?: boolean;
}

function Entry({
  event,
  ctx,
  focused,
  dimmed,
  toggle,
}: {
  event: RecordData;
  ctx: EntryContext;
  focused: boolean;
  dimmed: boolean;
  toggle: () => void;
}) {
  const seq = num(event, 'seq') ?? 0;
  const type = string(event, 'type');
  const view = describe(event, { ...ctx, focused });
  const own = view.owner;
  return (
    <li
      id={`entry-${seq}`}
      className={`entry entry-${view.variant}${own ? ' own' : ''}${focused ? ' focused' : ''}${dimmed ? ' dimmed' : ''}`}
    >
      <button
        type="button"
        className="entry-num num"
        aria-expanded={focused}
        aria-controls={`record-${seq}`}
        aria-label={`Entry ${pad(seq)}: open the full record`}
        onClick={toggle}
      >
        {pad(seq)}
      </button>
      <div className="entry-body">
        {view.variant === 'system' ? (
          <div className="system-line">
            {view.body}
            <When at={event.at} />
          </div>
        ) : (
          <>
            <div className="entry-head">
              {view.seatId && <SeatCode id={view.seatId} />}
              <span className="entry-author">{view.author}</span>
              {view.meta && <span className="entry-meta">{view.meta}</span>}
              <When at={event.at} />
            </div>
            {view.body}
          </>
        )}
        {focused && (
          <div id={`record-${seq}`} className="entry-record">
            {view.record}
            <JsonDetails value={{ ...event, type }} title="Raw event" />
          </div>
        )}
      </div>
    </li>
  );
}

function HandoffDetails({ handoff: h, ctx }: { handoff: RecordData; ctx: EntryContext }) {
  const { state, names } = ctx;
  const unresolved = objects(h, 'unresolved'), attempts = objects(h, 'attempts');
  const count = (key: string) => list(h, key).length;
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const work = [
    count('stoppedTurnIds') && `${plural(count('stoppedTurnIds'), 'queued turn')} cancelled before starting`,
    count('retainedTurnIds') && `${plural(count('retainedTurnIds'), 'answer')} kept for the owner, not posted`,
    count('uncertainTurnIds') && `${plural(count('uncertainTurnIds'), 'uncertain turn')} to inspect before any rerun`,
    ...attempts.map((a) => `Coding attempt ${shortId(string(a, 'id'))} for task ${string(a, 'taskId')} · ${string(a, 'status')}`),
  ].filter((line): line is string => !!line);
  const jumpTo = (seq: unknown, label: string) => typeof seq === 'number' && (
    <button type="button" className="text-button" onClick={() => ctx.jump(seq)}>{label} {pad(seq)}</button>
  );
  const running = state.turns.filter((t) => t.roomId === ctx.room.id && ACTIVE_TURN.includes(string(t, 'status'))).length;
  return (
    <>
      {(unresolved.length > 0 || work.length > 0) && (
        <div className="entry-lists">
          {unresolved.length > 0 && (
            <div>
              <span className="list-label">Open obligations</span>
              <ul>
                {unresolved.map((i) => {
                  const at = num(state.events.find((e) => e.id === i.messageId) ?? {}, 'seq');
                  return (
                    <li key={string(i, 'id')}>
                      {string(i, 'intent')} → {names.seat(i.recipientId)}
                      {at !== undefined && <> · {jumpTo(at, 'Message')}</>}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
          {work.length > 0 && (
            <div>
              <span className="list-label">Work</span>
              <ul>
                {work.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      <div className="entry-foot">
        {jumpTo(h.agendaSeq, 'Agenda')}
        {jumpTo(h.decisionSeq, 'Proposed decision')}
        {running > 0 && <Status kind="live">{running} still running</Status>}
      </div>
    </>
  );
}

interface EntryView {
  variant: 'message' | 'agenda' | 'decision' | 'turn' | 'request' | 'handoff' | 'system';
  author: string;
  meta?: string;
  seatId?: string;
  owner?: boolean;
  body: ReactNode;
  record?: ReactNode;
}

function describe(event: RecordData, ctx: EntryContext): EntryView {
  const { state, names, humanId } = ctx;
  const type = string(event, 'type');
  const d = data(event);
  const actor = names.actor(event.actorId);
  const actorSeat = state.seats.find((s) => s.principalId === event.actorId && s.roomId === ctx.room.id);
  if (type === 'message') {
    const senderId = string(d, 'senderId');
    const sender = state.seats.find((s) => s.id === senderId);
    const interactions = state.interactions.filter((i) => i.messageId === event.id);
    const reply = d.replyToId ? state.interactions.find((i) => i.id === d.replyToId) : undefined;
    const replySeq = reply ? num(state.events.find((e) => e.id === reply.messageId) ?? {}, 'seq') : undefined;
    return {
      variant: 'message',
      author: names.seat(senderId),
      meta: sender ? `${string(sender, 'role')} · ${string(sender, 'mode')}` : senderId === humanId ? 'owner' : undefined,
      seatId: sender ? senderId : undefined,
      owner: senderId === humanId,
      body: (
        <>
          <p className="entry-text">{string(d, 'text')}</p>
          {(d.threadId || (!ctx.shared && ctx.focused)) && (
            <p className="entry-refs">
              {typeof d.threadId === 'string' && (
                <span>In thread {string(state.threads.find((t) => t.id === d.threadId) ?? {}, 'title', 'a thread')}</span>
              )}
              {!ctx.shared && ctx.focused && (
                <button type="button" className="text-button" onClick={() => ctx.openAction({
                  title: 'Pin as a room invariant', command: 'context_pin',
                  args: { roomId: ctx.room.id, sourceSeq: num(event, 'seq'), ...(d.threadId ? { threadId: d.threadId } : {}) },
                  label: 'Pin', description: PIN_NOTE,
                  fields: [{ key: 'text', label: 'Pinned text', type: 'textarea', required: true, value: string(d, 'text').slice(0, 1000) }],
                })}>
                  Pin
                </button>
              )}
            </p>
          )}
          {objects(d, 'contextRefs').length > 0 && (
            <p className="entry-refs">
              Attached {objects(d, 'contextRefs').map((r) => <code key={string(r, 'ref')}>{string(r, 'ref')}</code>)}
            </p>
          )}
          {(interactions.length > 0 || replySeq !== undefined) && (
            <div className="entry-foot">
              {replySeq !== undefined && (
                <button type="button" className="text-button" onClick={() => ctx.jump(replySeq)}>
                  <CornerDownRight size={13} aria-hidden="true" />
                  Reply to {pad(replySeq)}
                </button>
              )}
              {interactions.map((i) => {
                const recipient = state.seats.find((s) => s.id === i.recipientId);
                const [kind, label] = receipt(i);
                const canWake =
                  recipient?.mode === 'managed' &&
                  recipient.consent === true &&
                  turnTarget(recipient) &&
                  ctx.room.lifecycle === 'active' &&
                  !list(ctx.room, 'exhaustedBudgets').length &&
                  !i.turnId &&
                  !['responded', 'resolved'].includes(string(i, 'status'));
                return (
                  <span key={string(i, 'id')} className="mention">
                    <span className="mention-intent">{string(i, 'intent')}</span>
                    <span>→ {names.seat(i.recipientId)}</span>
                    <Status kind={kind}>{label}</Status>
                    {canWake && recipient && (
                      <button type="button" className="text-button" onClick={() => ctx.requestTurn(recipient, string(i, 'id'))}>
                        Request reply
                      </button>
                    )}
                    {!ctx.shared && ['stored', 'delivered', 'read'].includes(string(i, 'status')) && ctx.room.lifecycle === 'active' && (
                      <button type="button" className="text-button" onClick={() => ctx.openAction({
                        title: 'Reassign request', command: 'interaction_reassign', args: { roomId: ctx.room.id, interactionId: i.id },
                        label: 'Reassign',
                        description: 'Moves this unanswered request to another seat with a note of why, and any answer the first seat kept but never posted. A late reply from the first seat stays in the room but no longer answers it.',
                        fields: [
                          { key: 'toSeatId', label: 'To seat', type: 'select', required: true,
                            options: state.seats.filter((s) => s.roomId === ctx.room.id && s.role !== 'observer' && s.status !== 'left' &&
                              s.id !== i.recipientId && s.id !== i.senderId).map((s) => ({ value: string(s, 'id'), label: string(s, 'name') })) },
                          { key: 'reason', label: 'Reason', type: 'textarea', required: true },
                        ],
                      })}>
                        Reassign
                      </button>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </>
      ),
      record: interactions.length ? (
        <dl className="record-list">
          {interactions.map((i) => (
            <div key={string(i, 'id')}>
              <dt>
                {string(i, 'intent')} → {names.seat(i.recipientId)}
              </dt>
              <dd>
                {(['createdAt', 'deliveredAt', 'readAt', 'respondedAt', 'resolvedAt'] as const)
                  .filter((k) => typeof i[k] === 'number')
                  .map((k) => `${k.replace('At', '').replace('created', 'stored')} ${fmtClock(i[k] as number)}`)
                  .join(' · ')}
                {i.resolvedReason ? ` · ${string(i, 'resolvedReason')}` : ''}
              </dd>
            </div>
          ))}
        </dl>
      ) : undefined,
    };
  }
  if (type === 'agenda' || type === 'decision') {
    const text = string(d, type);
    const groups = (['dissent', 'evidence'] as const).filter((k) => list(d, k).length);
    const unresolved = list(d, 'unresolved').length;
    return {
      variant: type,
      author: actor,
      meta: type === 'agenda' ? 'Agenda' : 'Decision proposed',
      seatId: actorSeat ? string(actorSeat, 'id') : undefined,
      owner: event.actorId === humanId,
      body: (
        <>
          <p className="entry-text">{text}</p>
          {(groups.length > 0 || unresolved > 0) && (
            <div className="entry-lists">
              {groups.map((k) => (
                <div key={k}>
                  <span className="list-label">{k}</span>
                  <ul>
                    {list(d, k).map((item, n) => (
                      <li key={n}>{item}</li>
                    ))}
                  </ul>
                </div>
              ))}
              {unresolved > 0 && <Status kind="warn">{unresolved} open obligations at the time</Status>}
            </div>
          )}
        </>
      ),
    };
  }
  if (type === 'room.budget_exhausted') {
    const usage = isRecord(d.usage) ? d.usage : {}, limits = isRecord(d.limits) ? d.limits : {};
    return {
      variant: 'handoff',
      author: actor,
      meta: 'Budget used up · handoff',
      body: (
        <>
          <p className="entry-text">
            {list(d, 'budgets').map((b) => BUDGET_LINES[b]?.(usage, limits) ?? `The ${b} budget is used up.`).join(' ')} New turns are refused.
            Nothing was approved or accepted.
          </p>
          <HandoffDetails handoff={isRecord(d.handoff) ? d.handoff : {}} ctx={ctx} />
          {!ctx.shared && (
            <p className="entry-text system">
              To continue, raise a limit you lowered under Room controls, or close this room and start a new one from this handoff.
            </p>
          )}
        </>
      ),
    };
  }
  if (type === 'room.lifecycle' && d.lifecycle === 'cancelled') {
    return {
      variant: 'handoff',
      author: actor,
      meta: 'Room cancelled · handoff',
      body: (
        <>
          {typeof d.reason === 'string' && <p className="entry-text">{d.reason}</p>}
          <p className="entry-text">New turns are refused and the room cannot reopen. Nothing was approved or accepted.</p>
          <HandoffDetails handoff={isRecord(d.handoff) ? d.handoff : {}} ctx={ctx} />
        </>
      ),
    };
  }
  if (type === 'turn.queued') {
    const turn = visibleTurn(state, string(ctx.room, 'id'), d);
    const current = state.turns.some((t) => t.id === d.id);
    const seat = state.seats.find((s) => s.id === turn.seatId);
    const tk = turnKind(turn, state, ctx.now);
    const timing = turnTiming(turn, ctx.room, state);
    const statusText = string(turn, 'status');
    const lifecycle = state.events
      .filter((e) => isRecord(e.data) && (e.data.turnId === turn.id || (e.type === 'turn.queued' && e.data.id === turn.id)))
      .sort((a, b) => (num(a, 'seq') ?? 0) - (num(b, 'seq') ?? 0));
    const request = state.permissions.find((p) => p.id === turn.permissionRequestId);
    return {
      variant: 'turn',
      author: string(seat ?? {}, 'name', 'Seat'),
      meta: turn.attemptId ? 'Coding turn' : turn.roundRobinId ? 'Round-robin turn' : turn.peerWake === true ? 'Woken by an agent' : 'Turn',
      seatId: seat ? string(seat, 'id') : undefined,
      body: (
        <>
          <p className="entry-text quote">{string(turn, 'prompt')}</p>
          <div className="entry-foot">
            <Status kind={tk.kind}>{tk.label}</Status>
            {timing.started !== undefined &&
              (timing.active ? (
                <LiveDuration since={timing.started} budget={timing.budget} />
              ) : (
                <span className="timing">
                  <DurationBar elapsed={(timing.ended ?? ctx.now) - timing.started} budget={timing.budget} />
                  <span className="num">
                    {fmtDuration((timing.ended ?? ctx.now) - timing.started)} of {fmtDuration(timing.budget)}
                  </span>
                </span>
              ))}
            {current && OPEN_TURN.includes(statusText) && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  ctx.openAction({
                    title: 'Cancel turn',
                    command: 'turn_cancel',
                    args: { roomId: ctx.room.id, turnId: turn.id },
                    label: 'Cancel turn',
                    confirm: 'Queued turns cancel at once. A running turn is asked to stop and stays visible until the vendor confirms.',
                    danger: true,
                  })
                }
              >
                Cancel turn
              </button>
            )}
            {current && !ctx.shared && seat?.mode === 'managed' && !turn.remoteProposalId && ['dispatching', 'running'].includes(statusText) && (
              <button type="button" className="text-button" onClick={() => ctx.openAction({
                title: 'Interrupt and amend', command: 'turn_amend', args: { roomId: ctx.room.id, turnId: turn.id }, label: 'Interrupt and amend',
                description: 'Asks the agent to stop this turn. Once it confirms the stop, a continuation runs with your instruction at the top and the earlier task below it; confirming here approves that continuation. If the stop is not confirmed, nothing runs and your instruction waits for the seat\'s next turn.',
                fields: [{ key: 'text', label: 'Instruction', type: 'textarea', required: true },
                  ...(turn.attemptId ? [{ key: 'rollback', label: 'Roll the clone back to its last checkpoint first', type: 'checkbox' as const }] : [])],
                prepare: ({ rollback, ...rest }) => (rollback === true ? { ...rest, rollback } : rest),
              })}>
                Interrupt and amend
              </button>
            )}
            {current && statusText === 'cancelling' && seat?.mode === 'managed' && (
              <button
                type="button"
                className="text-button"
                onClick={() =>
                  ctx.openAction({
                    title: 'Stop managed worker',
                    command: 'managed_stop',
                    args: { roomId: ctx.room.id, turnId: turn.id },
                    label: 'Stop worker',
                    confirm: 'Stop this runtime-owned worker process tree. Work is preserved; unknown execution is quarantined.',
                    danger: true,
                  })
                }
              >
                Stop worker
              </button>
            )}
            {current && !ctx.shared && statusText === 'uncertain' && (
              <button type="button" className="text-button" onClick={() => ctx.openAction(inspectTurnAction(string(ctx.room, 'id'), turn.id))}>
                {isRecord(turn.inspection) ? 'Update inspection' : 'Record inspection'}
              </button>
            )}
          </div>
          {typeof turn.error === 'string' && <p className="entry-error">{string(turn, 'error')}</p>}
        </>
      ),
      record: (
        <>
          <dl className="record-list">
            <div>
              <dt>Lifecycle</dt>
              <dd>
                {lifecycle.map((e) => `${string(e, 'type').replace('turn.', '')} ${fmtClock(num(e, 'at') ?? 0)}`).join(' · ')}
              </dd>
            </div>
            <div>
              <dt>Requested by</dt>
              <dd>{names.actor(turn.requestedBy)}</dd>
            </div>
            {request && (
              <div>
                <dt>Grant</dt>
                <dd>
                  {string(request, 'status')} · <code>{string(request, 'scopeDigest').slice(0, 16)}</code>
                </dd>
              </div>
            )}
            {!ctx.shared && turnEvidence(turn, state).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
            {isRecord(turn.inspection) && (
              <div>
                <dt>Inspection</dt>
                <dd>
                  {[FINDINGS[string(turn.inspection, 'finding')], fmtClock(num(turn.inspection, 'at') ?? 0), string(turn.inspection, 'note')]
                    .filter(Boolean).join(' · ')}
                </dd>
              </div>
            )}
            {typeof turn.repair === 'string' && (
              <div>
                <dt>Recovery</dt>
                <dd>{string(turn, 'repair')}</dd>
              </div>
            )}
          </dl>
          {isRecord(turn.retainedAnswer) && (
            <div>
              <span className="list-label">Answer not posted</span>
              <p className="entry-text">{string(turn.retainedAnswer, 'text')}</p>
              {turn.retainedAnswer.truncated === true && <p className="entry-text system">Only the first 1 MiB was kept.</p>}
            </div>
          )}
        </>
      ),
    };
  }
  if (type === 'permission.requested') {
    const permission = state.permissions.find((p) => p.id === d.id) ?? d;
    const expires = num(permission, 'expiresAt') ?? 0;
    const pendingNow = permission.status === 'pending' && expires > ctx.now;
    const outcome: [Kind, string] = pendingNow
      ? ['needs', 'Waiting for you']
      : permission.status === 'granted'
        ? ['ok', 'Granted']
        : permission.status === 'denied'
          ? ['closed', 'Denied']
          : ['closed', 'Expired'];
    return {
      variant: 'request',
      author: actor,
      meta: 'Approval request',
      seatId: actorSeat ? string(actorSeat, 'id') : undefined,
      body: (
        <div className="entry-foot">
          <span className="entry-text inline">
            {string(permission, 'action').replaceAll('_', ' ')} · {string(permission, 'summary')}
          </span>
          <Status kind={outcome[0]}>{outcome[1]}</Status>
        </div>
      ),
      record: <pre className="scope" tabIndex={0}>{JSON.stringify(permission.scope, null, 2)}</pre>,
    };
  }
  return {
    variant: 'system',
    author: actor,
    body: (
      <p className="entry-text system">
        {actor !== 'You' && <span className="system-actor">{actor}</span>}
        {systemLine(type, d, ctx)}
      </p>
    ),
  };
}

const LIFECYCLE_LINES: Record<string, (d: RecordData) => string> = {
  active: (d) => (d.previous === 'draft' ? 'Room started' : 'Room resumed'),
  pausing: () => 'Pause requested · started turns are ending',
  paused: () => 'Room paused · new dispatch blocked',
  completed: (d) => `Room completed${typeof d.reason === 'string' ? ` · ${d.reason}` : ''}`,
  archived: () => 'Room archived',
};

function systemLine(type: string, d: RecordData, ctx: EntryContext): ReactNode {
  const seat = (id: unknown) => ctx.names.seat(id);
  switch (type) {
    case 'room.created':
      return `${d.lifecycle === 'draft' ? 'Room drafted' : 'Room opened'}${isRecord(d.template) ? ' from ' + string(d.template, 'name') : ''} · ${string(d, 'objective')}`;
    case 'room.lifecycle':
      return LIFECYCLE_LINES[string(d, 'lifecycle')]?.(d) ?? `Room ${string(d, 'lifecycle')}`;
    case 'room.phase':
      return `Phase · ${phaseLabel(d.previous)} → ${phaseLabel(d.phase)}${typeof d.reason === 'string' ? ` · ${d.reason}` : ''}`;
    case 'seat.joined':
      return `${string(d, 'name')} joined · ${string(d, 'product')} · ${d.mode === 'managed' ? 'managed' : 'polling'} ${string(d, 'role')}`;
    case 'seat.left':
      return `${seat(d.seatId)} left the room`;
    case 'seat.consent':
      return d.consent ? `Turn requests allowed for ${seat(d.seatId)}` : `Turn requests turned off for ${seat(d.seatId)}`;
    case 'seat.profile':
      return profileLabel(d.profile) ? `Model and effort for ${seat(d.seatId)} · ${profileLabel(d.profile)}` : `Model and effort for ${seat(d.seatId)} cleared · agent defaults`;
    case 'room.paused':
      return 'Room paused · new dispatch blocked';
    case 'room.open':
      return 'Room resumed';
    case 'room.closed':
      return 'Room closed';
    case 'policy.changed':
      return `Limits changed · policy v${String(d.version ?? '')}`;
    case 'host.transferred':
      return `Host transferred to ${seat(d.seatId)}`;
    case 'interaction.resolved':
      return 'An open question was resolved';
    case 'interaction.wake_refused': {
      const asked = ctx.state.interactions.find((i) => i.id === d.interactionId);
      return `No turn queued for ${asked ? seat(asked.recipientId) : 'an agent'} · ${string(d, 'reason')}`;
    }
    case 'round_robin.approved':
      return `Round robin approved · ${list(d, 'seatIds').map(seat).join(' → ')} · ${String(d.rounds)} ${d.rounds === 1 ? 'round' : 'rounds'}`;
    case 'round_robin.ended': {
      const turns = `${String(d.turns)} ${d.turns === 1 ? 'turn' : 'turns'}`;
      const how = d.status === 'completed' ? `completed · ${turns}` : d.status === 'declined' ? 'declined' : `stopped after ${turns}`;
      return `Round robin ${how}${typeof d.reason === 'string' ? ` · ${d.reason}` : ''}`;
    }
    case 'tasks.planned':
      return `Tasks planned · ${list(d, 'taskIds').join(', ')}`;
    case 'task.claimed':
      return `Task ${string(d, 'taskId')} claimed · attempt ${string(d, 'attemptId').slice(0, 8)} · generation ${String(d.generation ?? '')}`;
    case 'task.submitted':
      return `Submission recorded · result ${string(d, 'resultDigest').slice(0, 12)}`;
    case 'verification.completed':
      return (
        <>
          <Status kind={d.status === 'passing' ? 'ok' : d.status === 'blocked' ? 'warn' : 'fail'}>
            {d.status === 'passing' ? 'Checks passed' : d.status === 'blocked' ? 'Checks blocked' : 'Checks failed'}
          </Status>{' '}
          on content {string(d, 'contentDigest').slice(0, 12)}
        </>
      );
    case 'review.submitted':
      return `Review · ${d.verdict === 'accept' ? 'accepted' : 'rework requested'} · ${string(d, 'reason')}${
        objects(d, 'annotations').length ? ` · ${objects(d, 'annotations').length} line ${objects(d, 'annotations').length === 1 ? 'comment' : 'comments'}` : ''}`;
    case 'candidate.prepared':
      return `Combined candidate prepared · ${string(d, 'status')} · ${string(d, 'resultDigest').slice(0, 12)}`;
    case 'candidate.accepted':
      return `Final candidate accepted · ${string(d, 'resultDigest').slice(0, 12)}`;
    case 'candidate.applied':
      return `Candidate applied to the checkout · ${string(d, 'resultDigest').slice(0, 12)}`;
    case 'thread.created':
      return `Thread opened · ${string(d, 'title')}${string(d, 'topic') ? ' · ' + string(d, 'topic') : ''}`;
    case 'thread.archived':
      return `Thread archived${d.summaryId ? ' with a summary' : ''}`;
    case 'thread.summarized':
      return `Summary of events ${pad(num(d, 'fromSeq') ?? 0)} to ${pad(num(d, 'toSeq') ?? 0)}${d.agentWritten ? ' · written by an agent, untrusted' : ''}`;
    case 'context.pinned':
      return `Pinned · ${string(d, 'text')}${d.requestId ? ' · approved host proposal' : ''}`;
    case 'context.unpinned':
      return 'Pin removed';
    case 'directive.issued':
      return `Owner directive · ${DIRECTIVE_MODES[string(d, 'mode')] ?? string(d, 'mode')} · ${string(d, 'text')}`;
    case 'directive.cleared':
      return 'Owner directive cleared';
    case 'interaction.reassigned':
      return `Request reassigned · ${seat(d.fromSeatId)} → ${seat(d.toSeatId)} · ${string(d, 'reason')}`;
    case 'attempt.taken_over':
      return `Task ${string(d, 'taskId')} handed over · ${seat(d.fromSeatId)} → ${seat(d.toSeatId)} · from ${num(d, 'checkpoint') ? 'checkpoint ' + num(d, 'checkpoint') : 'the starting point'}`;
    case 'directive.delivered':
      return `Directive reached ${seat(d.seatId)} · ${d.state === 'applied' ? 'in a turn' : 'on a read'}`;
    case 'turn.amended':
      return 'Turn interrupted and amended · continuation queued with your approval';
    case 'context.imported':
      return `Imported ${string(d, 'ref')} · ${string(d, 'title')} · ${string(d, 'product')} · ${fmtBytes(num(d, 'bytes') ?? 0)}`;
    case 'candidate.exported':
      return `Candidate exported to new branch ${string(d, 'branch')} · commit ${string(d, 'commit').slice(0, 12)} · not pushed`;
    case 'checkpoint.recorded': {
      const pruned = list(d, 'pruned').length;
      return `Checkpoint ${String(d.checkpoint)} saved · attempt ${string(d, 'attemptId').slice(0, 8)} · tree ${string(d, 'treeDigest').slice(0, 12)}${
        pruned ? ` · ${pruned} older ${pruned === 1 ? 'checkpoint' : 'checkpoints'} pruned` : ''}`;
    }
    case 'checkpoint.unchanged':
      return `No changes in the turn · attempt ${string(d, 'attemptId').slice(0, 8)} stays at ${d.checkpoint ? 'checkpoint ' + String(d.checkpoint) : 'its starting point'}`;
    case 'checkpoint.skipped':
      return (
        <>
          <Status kind="warn">Checkpoint not saved</Status> attempt {string(d, 'attemptId').slice(0, 8)} ·{' '}
          {d.reason === 'budget' ? 'storage limit reached' : 'the clone could not be read'}
        </>
      );
    case 'attempt.rolled_back':
      return `Attempt ${string(d, 'attemptId').slice(0, 8)} rolled back to ${d.checkpoint ? 'checkpoint ' + String(d.checkpoint) : 'its starting point'} · ${string(d, 'reason')}`;
    case 'command.cleared':
      return `Interrupted ${string(d, 'command')} cleared · its client key can run again`;
    case 'workspaces.removed': {
      const n = objects(d, 'removed').length;
      return `${n} coding ${n === 1 ? 'workspace' : 'workspaces'} removed after a confirmed cleanup · ${fmtBytes(num(d, 'bytes') ?? 0)}`;
    }
    case 'turn.inspected':
      return `Uncertain turn inspected · ${FINDINGS[string(d, 'finding')] ?? 'finding recorded'}`;
    case 'bridge.authorized':
      return `Room connection approved for a participant bridge · membership ${String(d.generation)}`;
    case 'bridge.revoked':
      return 'Room connection revoked for a participant bridge';
    case 'remote.connected':
      return `Connected to the shared room · ${d.mode === 'managed' ? 'managed discussion' : 'polling'}`;
    case 'remote.managed_enabled':
      return `Managed discussion enabled · up to ${String(d.maxTurns)} turns of ${fmtDuration(num(d, 'maxTurnMs') ?? 0)}`;
    case 'remote.proposal_accepted':
      return 'Turn proposal accepted · local approval still required';
    case 'remote.proposal_declined':
      return 'Turn proposal declined';
    case 'remote.disconnected':
      return 'Disconnected locally · remote revocation not confirmed';
    default:
      return type.replaceAll('.', ' ').replaceAll('_', ' ');
  }
}

export function NoRoom({ hasRooms, createRoom }: { hasRooms: boolean; createRoom: () => void }) {
  return (
    <section className="room-main no-room">
      <Empty
        title={hasRooms ? 'Choose a room' : 'Open your first room'}
        action={
          <button type="button" className="button primary" onClick={createRoom}>
            <Plus size={15} aria-hidden="true" />
            {hasRooms ? 'New room' : 'Create your first room'}
          </button>
        }
      >
        {hasRooms
          ? 'Pick a room from the index, or press Ctrl K to jump to one by name.'
          : 'A room gives your agents one objective. They discuss in public, you grant every execution, and each event is numbered here.'}
      </Empty>
    </section>
  );
}
