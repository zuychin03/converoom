import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowLeft, CornerDownRight, Pause, Play, Plus, Search, Square } from 'lucide-react';
import { isRecord, list, string, type RecordData, type Snapshot } from './api.js';
import { addAgentAction, closeRoomAction, requestTurnAction } from './actions.js';
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
  OPEN_TURN,
  activity,
  data,
  fmtClock,
  fmtDuration,
  num,
  pad,
  pendingPermissions,
  roomEvents,
  roomSeats,
  seatState,
  shortId,
  turnKind,
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
};
const receipt = (interaction: RecordData): [Kind, string] =>
  RECEIPT[string(interaction, 'status')] ?? ['idle', string(interaction, 'status')];
const CONVERSATION = new Set(['message', 'agenda', 'decision', 'turn.queued', 'permission.requested']);
const SYSTEM_LABELS: Record<string, string> = {
  'room.created': 'room opened',
  'seat.joined': 'seat joined',
  'seat.left': 'seat left',
  'seat.consent': 'consent',
  'policy.changed': 'limits',
  'host.transferred': 'host',
  'room.paused': 'paused',
  'room.open': 'resumed',
  'room.closed': 'closed',
  'interaction.resolved': 'resolved',
  'tasks.planned': 'tasks planned',
  'task.claimed': 'claim',
  'task.submitted': 'submission',
  'verification.completed': 'checks',
  'review.submitted': 'review',
  'candidate.prepared': 'candidate',
  'candidate.accepted': 'candidate accepted',
  'candidate.applied': 'candidate applied',
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

export function roomStatus(room: RecordData, state: Snapshot): { kind: Kind; label: string } {
  if (room.status === 'closed') return { kind: 'closed', label: 'Closed' };
  if (room.status === 'paused') return { kind: 'paused', label: 'Paused' };
  const running = state.turns.filter(
    (t) => t.roomId === room.id && ACTIVE_TURN.includes(string(t, 'status')),
  ).length;
  return running ? { kind: 'live', label: `${running} running` } : { kind: 'idle', label: 'Open' };
}

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
        Number(a.status === 'closed') - Number(b.status === 'closed') ||
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
  shared = false,
}: {
  room: RecordData;
  state: Snapshot;
  humanId: string;
  run: Run;
  openAction: (action: Action) => void;
  focusSeq: number | null;
  setFocusSeq: (seq: number | null) => void;
  onAllRooms: () => void;
  shared?: boolean;
}) {
  const now = useNow(5000);
  const id = string(room, 'id');
  const open = room.status === 'open';
  const closed = room.status === 'closed';
  const policy = isRecord(room.policy) ? room.policy : {};
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
  const messages = events.filter((e) => e.type === 'message').length;

  const visible = events.filter(
    (event) =>
      !FOLDED.has(string(event, 'type')) &&
      !(event.type === 'permission.requested' && data(event).action === 'turn_execute'),
  );
  const blocks: Block[] = [];
  for (const event of visible) {
    const system = !CONVERSATION.has(string(event, 'type'));
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

  async function lifecycle(command: 'room_pause' | 'room_resume') {
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
  const requestTurn = (seat: RecordData, interactionId?: string) =>
    openAction(requestTurnAction(id, seat.id, interactionId, shared || seat.ownerId !== room.ownerId));
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
  const ctx: EntryContext = { state, room, humanId, now, names, openAction, requestTurn, jump: setFocusSeq };

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
            <span>{room.workflow === 'coding' ? 'Coding room' : 'Discussion room'}</span>
            <span>Host · {host ? string(host, 'name') : shared ? 'Room owner' : 'You'}</span>
            <span>Policy v{num(room, 'policyVersion') ?? 1}</span>
          </div>
          <div className="room-gauges">
            <Gauge label="Messages" value={messages} max={num(policy, 'maxMessages') ?? 60} />
            <Gauge
              label="Minutes"
              value={Math.min((now - (num(room, 'createdAt') ?? now)) / 60000, (num(policy, 'maxDurationMs') ?? 5400000) / 60000)}
              max={Math.round((num(policy, 'maxDurationMs') ?? 5400000) / 60000)}
            />
            <Gauge label="Turns" value={turns.length} max={num(policy, 'maxMessages') ?? 60} />
          </div>
          {!shared && <div className="room-actions">
            {!closed &&
              (open ? (
                <button type="button" className="button" disabled={!!busy} onClick={() => void lifecycle('room_pause')}>
                  <Pause size={14} aria-hidden="true" />
                  Pause
                </button>
              ) : (
                <button type="button" className="button" disabled={!!busy} onClick={() => void lifecycle('room_resume')}>
                  <Play size={14} aria-hidden="true" />
                  Resume
                </button>
              ))}
            <button
              type="button"
              className="button"
              disabled={closed}
              onClick={() => openAction(closeRoomAction(id))}
            >
              <Square size={13} aria-hidden="true" />
              Close
            </button>
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
        <Composer roomId={id} seats={seats} run={run} disabled={!open} />
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
              disabled={!open}
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
                roomOpen={open}
                run={run}
                selected={selected === seat.id}
                onSelect={setSelected}
                requestTurn={() => requestTurn(seat)}
                shared={shared}
                remote={seat.ownerId !== room.ownerId}
                ownerLabel={string(state.members.find((m) => m.ownerId === seat.ownerId) ?? {}, 'displayName', 'Local room owner')}
              />
            ))}
          </ul>
        </section>
        {!shared && <RoomControls room={room} state={state} seats={seats} names={names} openAction={openAction} />}
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
        {managed ? 'new managed session per turn' : 'polls its inbox, outside runtime control'}
      </p>
      {(managed || shared || remote) && (
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
        </div>
      )}
      {error && <ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice>}
    </li>
  );
}

type Names = { seat: (id: unknown) => string; actor: (id: unknown) => string };

function RoomControls({
  room,
  state,
  seats,
  names,
  openAction,
}: {
  room: RecordData;
  state: Snapshot;
  seats: RecordData[];
  names: Names;
  openAction: (action: Action) => void;
}) {
  const id = string(room, 'id');
  const open = room.status === 'open';
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
  const view = describe(event, ctx);
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

interface EntryView {
  variant: 'message' | 'agenda' | 'decision' | 'turn' | 'request' | 'system';
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
                  ctx.room.status === 'open' &&
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
      meta: turn.attemptId ? 'Coding turn' : 'Turn',
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
          </div>
          {typeof turn.error === 'string' && <p className="entry-error">{string(turn, 'error')}</p>}
        </>
      ),
      record: (
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
          {typeof turn.repair === 'string' && (
            <div>
              <dt>Recovery</dt>
              <dd>{string(turn, 'repair')}</dd>
            </div>
          )}
        </dl>
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

function systemLine(type: string, d: RecordData, ctx: EntryContext): ReactNode {
  const seat = (id: unknown) => ctx.names.seat(id);
  switch (type) {
    case 'room.created':
      return `Room opened · ${string(d, 'objective')}`;
    case 'seat.joined':
      return `${string(d, 'name')} joined · ${string(d, 'product')} · ${d.mode === 'managed' ? 'managed' : 'polling'} ${string(d, 'role')}`;
    case 'seat.left':
      return `${seat(d.seatId)} left the room`;
    case 'seat.consent':
      return d.consent ? `Turn requests allowed for ${seat(d.seatId)}` : `Turn requests turned off for ${seat(d.seatId)}`;
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
      return `Review · ${d.verdict === 'accept' ? 'accepted' : 'rework requested'} · ${string(d, 'reason')}`;
    case 'candidate.prepared':
      return `Combined candidate prepared · ${string(d, 'status')} · ${string(d, 'resultDigest').slice(0, 12)}`;
    case 'candidate.accepted':
      return `Final candidate accepted · ${string(d, 'resultDigest').slice(0, 12)}`;
    case 'candidate.applied':
      return `Candidate applied to the checkout · ${string(d, 'resultDigest').slice(0, 12)}`;
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
