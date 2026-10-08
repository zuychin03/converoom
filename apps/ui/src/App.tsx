import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Monitor, Moon, RefreshCw, Search, Sun, Wifi, WifiOff } from 'lucide-react';
import { ApiError, createClient, isRecord, string, type Snapshot } from './api.js';
import { closeRoomAction, createRoomAction, joinRoomAction, requestTurnAction } from './actions.js';
import { ApprovalQueue } from './Approvals.js';
import { CommandIndex, type IndexItem } from './CommandIndex.js';
import { ActionDialog, ErrorNotice, Status, useNow, type Action } from './components.js';
import { ACTIVE_TURN, data, num, pad, pendingPermissions, roomEvents, shortId } from './model.js';
import { NoRoom, RoomIndex, RoomView } from './RoomView.js';
import { useTheme, type ThemeChoice } from './theme.js';
import { WorkspaceView } from './WorkspaceView.js';

const client = createClient();
type View = 'room' | 'work' | 'approvals';
const VIEWS: Array<[View, string]> = [
  ['room', 'Room'],
  ['work', 'Work'],
  ['approvals', 'Approvals'],
];
const INDEXED = new Set(['message', 'agenda', 'decision', 'turn.queued', 'permission.requested']);

function liveRoomId(state: Snapshot) {
  const lastActivity = (id: string) =>
    Math.max(0, ...state.events.filter((e) => e.roomId === id).map((e) => num(e, 'at') ?? 0));
  return state.rooms
    .filter((room) => room.status !== 'closed')
    .map((room) => ({ id: string(room, 'id'), at: Math.max(lastActivity(string(room, 'id')), num(room, 'createdAt') ?? 0) }))
    .sort((a, b) => b.at - a.at)[0]?.id;
}

export function App() {
  const [phase, setPhase] = useState<'checking' | 'pair' | 'ready'>('checking');
  const [humanId, setHumanId] = useState('');
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [roomId, setRoomId] = useState(() => new URL(window.location.href).searchParams.get('room') ?? '');
  const [view, setView] = useState<View>('room');
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'offline'>('connecting');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<Action>();
  const [indexOpen, setIndexOpen] = useState(false);
  const [focusSeq, setFocusSeq] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [pairing, setPairing] = useState(false);
  const inFlight = useRef(false);
  const autoPicked = useRef(false);
  const theme = useTheme();
  const now = useNow(5000);

  const selectRoom = useCallback((id: string) => {
    setRoomId(id);
    setFocusSeq(null);
    const url = new URL(window.location.href);
    if (id) url.searchParams.set('room', id);
    else url.searchParams.delete('room');
    window.history.replaceState(null, '', url);
  }, []);
  const resetSession = useCallback(() => {
    setSnapshot(undefined);
    setAction(undefined);
    setPhase('pair');
  }, []);
  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setSnapshot(await client.state());
      setError('');
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) resetSession();
      setError(cause instanceof Error ? cause.message : 'Cannot reach Converoom. Check that the local server is running.');
      setConnection('offline');
    } finally {
      inFlight.current = false;
    }
  }, [resetSession]);
  const adoptSession = (value: unknown) => {
    const actor = isRecord(value) && isRecord(value.actor) ? value.actor : {};
    setHumanId(string(actor, 'principalId'));
    setPhase('ready');
  };
  useEffect(() => {
    let active = true;
    client
      .session()
      .then((value) => {
        if (active) adoptSession(value);
      })
      .catch((cause) => {
        if (!active) return;
        setPhase('pair');
        if (!(cause instanceof ApiError && cause.status === 401))
          setError(cause instanceof Error ? cause.message : 'Cannot reach the local server.');
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (phase !== 'ready') return;
    void refresh();
    const events = new EventSource('/api/events');
    events.onopen = () => {
      setConnection('live');
      void refresh();
    };
    events.onerror = () => setConnection('reconnecting');
    events.addEventListener('room', () => void refresh());
    const poll = setInterval(() => void refresh(), 12000);
    const online = () => void refresh();
    const offline = () => setConnection('offline');
    window.addEventListener('online', online);
    window.addEventListener('offline', offline);
    return () => {
      events.close();
      clearInterval(poll);
      window.removeEventListener('online', online);
      window.removeEventListener('offline', offline);
    };
  }, [phase, refresh]);
  useEffect(() => {
    if (!snapshot || autoPicked.current) return;
    autoPicked.current = true;
    if (roomId && snapshot.rooms.some((room) => room.id === roomId)) return;
    const live = liveRoomId(snapshot);
    if (live) selectRoom(live);
  }, [snapshot, roomId, selectRoom]);
  useEffect(() => {
    if (phase !== 'ready') return;
    const key = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setIndexOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [phase]);

  const run = async (name: string, args: Record<string, unknown>) => {
    try {
      const result = await client.command(name, { ...args, clientKey: crypto.randomUUID() });
      await refresh();
      setNotice('Change saved.');
      return result;
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) resetSession();
      throw cause;
    }
  };
  const createRoom = () =>
    setAction(
      createRoomAction((id) => {
        selectRoom(id);
        setView('room');
      }),
    );
  const joinRoom = () =>
    setAction(
      joinRoomAction((id) => {
        selectRoom(id);
        setView('room');
      }),
    );
  async function pair(event: React.FormEvent) {
    event.preventDefault();
    setPairing(true);
    setError('');
    try {
      await client.pair(code.trim());
      setCode('');
      adoptSession(await client.session());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Pairing failed. Generate another code and try again.');
    } finally {
      setPairing(false);
    }
  }

  const room = snapshot?.rooms.find((item) => item.id === roomId);
  const pending = snapshot ? pendingPermissions(snapshot, now) : [];
  const running = snapshot ? snapshot.turns.filter((t) => ACTIVE_TURN.includes(string(t, 'status'))).length : 0;
  const items = useMemo<IndexItem[]>(() => {
    if (!snapshot) return [];
    const go = (next: View) => () => setView(next);
    const list: IndexItem[] = snapshot.rooms.map((r) => ({
      id: `room-${string(r, 'id')}`,
      group: 'Rooms',
      label: string(r, 'title', 'Untitled room'),
      hint: `${shortId(string(r, 'id'))} · ${string(r, 'status')}`,
      keywords: `${string(r, 'objective')} ${string(r, 'id')}`,
      run: () => {
        selectRoom(string(r, 'id'));
        setView('room');
      },
    }));
    list.push(
      { id: 'go-room', group: 'Actions', label: 'Go to Room', run: go('room') },
      { id: 'go-work', group: 'Actions', label: 'Go to Work', run: go('work') },
      { id: 'go-approvals', group: 'Actions', label: 'Go to Approvals', hint: `${pending.length} waiting`, run: go('approvals') },
      { id: 'create-room', group: 'Actions', label: 'Create room…', run: createRoom },
    );
    for (const [choice, label] of [['dark', 'Dark'], ['light', 'Light'], ['system', 'System']] as const)
      list.push({ id: `theme-${choice}`, group: 'Actions', label: `Theme: ${label}`, run: () => theme.setChoice(choice) });
    if (room) {
      const id = string(room, 'id');
      if (room.status === 'open')
        list.push({ id: 'pause', group: 'Actions', label: 'Pause room', hint: string(room, 'title'), run: () => void run('room_pause', { roomId: id }).catch(() => undefined) });
      if (room.status === 'paused')
        list.push({ id: 'resume', group: 'Actions', label: 'Resume room', hint: string(room, 'title'), run: () => void run('room_resume', { roomId: id }).catch(() => undefined) });
      if (room.status !== 'closed')
        list.push({ id: 'close', group: 'Actions', label: 'Close room…', hint: string(room, 'title'), run: () => setAction(closeRoomAction(id)) });
      for (const seat of snapshot.seats.filter((s) => s.roomId === id && s.mode === 'managed' && s.consent === true && s.status !== 'left'))
        list.push({
          id: `turn-${string(seat, 'id')}`,
          group: 'Actions',
          label: `Request turn · ${string(seat, 'name')}…`,
          run: () => setAction(requestTurnAction(id, seat.id)),
        });
      for (const event of roomEvents(snapshot, id).filter((e) => INDEXED.has(string(e, 'type')))) {
        const seq = num(event, 'seq') ?? 0;
        const d = data(event);
        const text = string(d, 'text', string(d, 'agenda', string(d, 'decision', string(d, 'prompt', string(d, 'summary')))));
        list.push({
          id: `entry-${seq}`,
          group: 'Entries',
          label: `${pad(seq)} · ${text.slice(0, 72) || string(event, 'type')}`,
          keywords: `${seq} ${string(event, 'type')}`,
          run: () => {
            setView('room');
            setFocusSeq(seq);
          },
        });
      }
    }
    return list;
  }, [snapshot, room, pending.length]);

  if (phase === 'checking')
    return (
      <div className="boot">
        <Brand />
        <p role="status">Checking this browser’s local session…</p>
      </div>
    );
  if (phase === 'pair')
    return (
      <div className="pair">
        <header className="pair-head">
          <Brand />
          <span>Local agent collaboration</span>
        </header>
        <main className="pair-body">
          <div className="pair-copy">
            <h1>Your agents. One numbered room.</h1>
            <p>
              Connect this browser to the Converoom server running on this computer. Rooms, approvals
              and evidence stay local.
            </p>
            <ol className="pair-steps">
              <li>
                <span>Start the server in a terminal</span>
                <code>converoom start</code>
              </li>
              <li>
                <span>Generate a one-use browser code</span>
                <code>converoom pair</code>
              </li>
              <li>
                <span>Type that code here</span>
              </li>
            </ol>
            <p className="rail-note">
              Need the CLI? Install the local package described in the README, then run{' '}
              <code>converoom doctor</code> to check the setup.
            </p>
          </div>
          <form className="pair-form" onSubmit={(event) => void pair(event)}>
            <h2>Pair this browser</h2>
            <p>The code is single use and expires after five minutes.</p>
            <label className="field">
              <span className="field-label">Pairing code</span>
              <input
                autoFocus
                autoComplete="off"
                spellCheck={false}
                className="num"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                disabled={pairing}
              />
            </label>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <button className="button primary wide" disabled={pairing || !code.trim()} aria-busy={pairing || undefined}>
              {pairing ? 'Pairing…' : 'Connect to Converoom'}
            </button>
            <p className="rail-note">The code goes straight to this local server and is never stored in the browser.</p>
          </form>
        </main>
      </div>
    );

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="topbar">
        <Brand />
        <nav className="nav" aria-label="Application">
          {VIEWS.map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={view === key ? 'active' : ''}
              aria-current={view === key ? 'page' : undefined}
              onClick={() => setView(key)}
            >
              {label}
              {key === 'approvals' && pending.length > 0 && (
                <span className="count" aria-label={`, ${pending.length} pending`}>
                  {pending.length}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div className="topbar-end">
          {running > 0 && view !== 'room' && (
            <span className="topbar-live">
              <Status kind="live">{running} running</Status>
            </span>
          )}
          <span
            className={`connection connection-${connection}`}
            title={connection === 'live' ? 'Receiving local server events' : 'Reconnecting automatically; snapshots refresh every 12 seconds'}
          >
            {connection === 'live' ? <Wifi size={14} aria-hidden="true" /> : <WifiOff size={14} aria-hidden="true" />}
            <span className="connection-text">
              {connection === 'live' ? 'Connected' : connection === 'reconnecting' ? 'Reconnecting' : connection === 'offline' ? 'Offline' : 'Connecting'}
            </span>
          </span>
          <button
            type="button"
            className="index-button"
            aria-label="Open index"
            aria-keyshortcuts="Control+K Meta+K"
            onClick={() => setIndexOpen(true)}
          >
            <Search size={14} aria-hidden="true" />
            <span className="index-label">Index</span>
            <kbd>Ctrl K</kbd>
          </button>
          <ThemeSwitch choice={theme.choice} setChoice={theme.setChoice} />
          <button type="button" className="icon-button" aria-label="Refresh state" onClick={() => void refresh()}>
            <RefreshCw size={16} aria-hidden="true" />
          </button>
        </div>
      </header>
      {error && (
        <div className="global-error">
          <ErrorNotice dismiss={() => setError('')}>
            {error} Content may be out of date until the server answers.
          </ErrorNotice>
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {notice}
      </div>
      <main id="main-content" tabIndex={-1} className={`main main-${view}`}>
        {!snapshot ? (
          <div className="boot" role="status">
            <p>Reading the local workspace…</p>
          </div>
        ) : view === 'room' ? (
          <div className={`room-layout${room ? ' has-room' : ''}`}>
            <RoomIndex state={snapshot} roomId={roomId} setRoomId={selectRoom} createRoom={createRoom} joinRoom={joinRoom} />
            {room ? (
              <RoomView
                key={roomId}
                room={room}
                state={snapshot}
                humanId={humanId}
                run={run}
                openAction={setAction}
                focusSeq={focusSeq}
                setFocusSeq={setFocusSeq}
                onAllRooms={() => selectRoom('')}
              />
            ) : (
              <NoRoom hasRooms={snapshot.rooms.length > 0} createRoom={createRoom} />
            )}
          </div>
        ) : view === 'work' ? (
          <WorkspaceView
            state={snapshot}
            room={room}
            run={run}
            openAction={setAction}
            onPickRoom={selectRoom}
          />
        ) : (
          <ApprovalQueue permissions={pending} rooms={snapshot.rooms} openAction={setAction} />
        )}
      </main>
      <CommandIndex open={indexOpen} onClose={() => setIndexOpen(false)} items={items} />
      {action && (
        <ActionDialog
          key={`${action.command}-${string(action.args ?? {}, 'requestId')}`}
          action={action}
          close={() => setAction(undefined)}
          run={run}
        />
      )}
    </div>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="mark" aria-hidden="true">
        <i />
      </span>
      <span className="wordmark">Converoom</span>
    </div>
  );
}

const THEMES: Array<[ThemeChoice, string, React.ReactNode]> = [
  ['dark', 'Dark', <Moon key="d" size={14} aria-hidden="true" />],
  ['light', 'Light', <Sun key="l" size={14} aria-hidden="true" />],
  ['system', 'System', <Monitor key="s" size={14} aria-hidden="true" />],
];

function ThemeSwitch({ choice, setChoice }: { choice: ThemeChoice; setChoice: (c: ThemeChoice) => void }) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const index = THEMES.findIndex(([value]) => value === choice);
  function key(event: React.KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
    const next = (index + step + THEMES.length) % THEMES.length;
    setChoice(THEMES[next][0]);
    refs.current[next]?.focus();
  }
  return (
    <div className="theme-switch" role="radiogroup" aria-label="Theme" onKeyDown={key}>
      {THEMES.map(([value, label, icon], i) => (
        <button
          key={value}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={choice === value}
          aria-label={`${label} theme`}
          tabIndex={choice === value ? 0 : -1}
          className={choice === value ? 'on' : ''}
          onClick={() => setChoice(value)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}
