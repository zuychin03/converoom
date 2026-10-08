import { useCallback, useEffect, useRef, useState } from 'react';
import {
  MessageSquare,
  Plus,
  RefreshCw,
  ShieldCheck,
  ArrowLeft,
  Search,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { ApiError, createClient, isRecord, string, type RecordData, type Snapshot } from './api.js';
import { ActionDialog, Empty, ErrorNotice, Status, type Action, type Run } from './components.js';
import { RoomView } from './RoomView.js';
import { WorkspaceView } from './WorkspaceView.js';

const client = createClient();
export function App() {
  const [phase, setPhase] = useState<'checking' | 'pair' | 'ready'>('checking');
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [roomId, setRoomId] = useState(
    () => new URL(window.location.href).searchParams.get('room') ?? '',
  );
  const [view, setView] = useState<'rooms' | 'workspace' | 'approvals'>('rooms');
  const [connection, setConnection] = useState<'connecting' | 'live' | 'reconnecting' | 'offline'>(
    'connecting',
  );
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<Action>();
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [code, setCode] = useState('');
  const inFlight = useRef(false);
  const resetSession = useCallback(() => {
    setSnapshot(undefined);
    setRoomId('');
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
      setError(
        cause instanceof Error
          ? cause.message
          : 'Cannot reach Converoom. Check that the local server is running.',
      );
      setConnection('offline');
    } finally {
      inFlight.current = false;
    }
  }, [resetSession]);
  useEffect(() => {
    let active = true;
    void client
      .session()
      .then(() => {
        if (active) setPhase('ready');
      })
      .catch((cause) => {
        if (active) {
          setPhase('pair');
          if (!(cause instanceof ApiError && cause.status === 401))
            setError(cause instanceof Error ? cause.message : 'Cannot reach the local server.');
        }
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
    events.onerror = () => {
      setConnection('reconnecting');
    };
    events.onmessage = () => {
      void refresh();
    };
    for (const name of ['room', 'event', 'state', 'update', 'ready'])
      events.addEventListener(name, () => {
        void refresh();
      });
    const poll = setInterval(() => {
      void refresh();
    }, 12000);
    const online = () => {
      void refresh();
    };
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
  const run: Run = async (name, args) => {
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
  function createRoom() {
    setAction({
      title: 'Create room',
      command: 'room_create',
      label: 'Create room',
      description: 'Give the agents one clear objective. You keep authority over execution.',
      fields: [
        { key: 'title', label: 'Room name', required: true },
        { key: 'objective', label: 'Objective', required: true, type: 'textarea' },
        {
          key: 'workflow',
          label: 'Workflow',
          type: 'select',
          required: true,
          value: 'discussion',
          options: [
            { value: 'discussion', label: 'Discussion and decisions' },
            { value: 'coding', label: 'Coding and verification' },
          ],
        },
      ],
      onSuccess: (result) => {
        if (isRecord(result)) {
          const room = isRecord(result.room) ? result.room : result;
          setRoomId(string(room, 'id'));
          setView('rooms');
        }
      },
    });
  }
  async function pair(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError('');
    try {
      await client.pair(code.trim());
      setCode('');
      await client.session();
      setPhase('ready');
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : 'Pairing failed. Generate another code and try again.',
      );
    } finally {
      setLoading(false);
    }
  }
  if (phase === 'checking')
    return (
      <div className="boot-screen">
        <Brand />
        <p role="status">Checking this browser’s local session…</p>
      </div>
    );
  if (phase === 'pair')
    return (
      <div className="pair-page">
        <header>
          <Brand />
          <span>Local agent collaboration</span>
        </header>
        <main className="pair-content">
          <div className="pair-copy">
            <h1>
              Your agents.
              <br />
              One shared room.
            </h1>
            <p>
              Connect this browser to your running Converoom server. Rooms, approvals, and evidence
              stay in your local workspace.
            </p>
            <ol>
              <li>
                Start the server in your terminal:<code>converoom start</code>
              </li>
              <li>
                Generate a one-use browser code:<code>converoom pair</code>
              </li>
              <li>Type that code below.</li>
            </ol>
            <p className="muted">
              Need the CLI? Install the local package described in the project README, then run{' '}
              <code>converoom doctor</code> to check the setup.
            </p>
          </div>
          <form
            className="pair-form"
            onSubmit={(event) => {
              void pair(event);
            }}
          >
            <h2>Pair this browser</h2>
            <p>Use the code from your terminal. It is single use and expires.</p>
            <label className="field">
              <span>Pairing code</span>
              <input
                autoFocus
                autoComplete="off"
                spellCheck={false}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
                disabled={loading}
              />
            </label>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <button className="primary" disabled={loading || !code.trim()}>
              {loading ? 'Pairing…' : 'Connect to Converoom'}
            </button>
            <p className="muted">
              The code is sent directly to this local server. It is never saved in browser storage.
            </p>
          </form>
        </main>
      </div>
    );
  const room = snapshot?.rooms.find((item) => item.id === roomId);
  const pending = snapshot?.permissions.filter((item) => item.status === 'pending') ?? [];
  const rooms =
    snapshot?.rooms.filter((item) =>
      `${string(item, 'title')} ${string(item, 'objective')}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to content
      </a>
      <header className="toolbar">
        <Brand />
        <nav aria-label="Application">
          <button className={view === 'rooms' ? 'active' : ''} onClick={() => setView('rooms')}>
            Rooms
          </button>
          <button
            className={view === 'workspace' ? 'active' : ''}
            onClick={() => setView('workspace')}
          >
            Workspace
          </button>
          <button
            className={view === 'approvals' ? 'active' : ''}
            onClick={() => setView('approvals')}
          >
            <ShieldCheck size={16} aria-hidden="true" />
            Approvals{pending.length > 0 && <span className="count">{pending.length}</span>}
          </button>
        </nav>
        <div className="toolbar-end">
          <span
            className={`connection connection-${connection}`}
            title={
              connection === 'live'
                ? 'Receiving local server events'
                : 'Reconnecting automatically; snapshots refresh every 12 seconds'
            }
          >
            {connection === 'live' ? (
              <Wifi size={15} aria-hidden="true" />
            ) : (
              <WifiOff size={15} aria-hidden="true" />
            )}
            <span>
              {connection === 'live'
                ? 'Connected'
                : connection === 'reconnecting'
                  ? 'Reconnecting'
                  : connection === 'offline'
                    ? 'Offline'
                    : 'Connecting'}
            </span>
          </span>
          <button
            className="icon-button"
            aria-label="Refresh state"
            onClick={() => {
              void refresh();
            }}
          >
            <RefreshCw size={17} />
          </button>
        </div>
      </header>
      {error && (
        <div className="global-message">
          <ErrorNotice dismiss={() => setError('')}>
            {error} Current content may be out of date. Refresh when the server is available.
          </ErrorNotice>
        </div>
      )}
      <div className="sr-only" role="status" aria-live="polite">
        {notice}
      </div>
      {view === 'rooms' ? (
        <div className={`room-layout ${room ? 'has-room' : ''}`}>
          <aside className="room-sidebar" aria-label="Rooms">
            <div className="sidebar-heading">
              <h2>Rooms</h2>
              <button className="icon-button" aria-label="Create room" onClick={createRoom}>
                <Plus size={19} />
              </button>
            </div>
            <label className="search-field">
              <Search size={16} aria-hidden="true" />
              <input
                aria-label="Search rooms"
                placeholder="Find a room"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <div className="room-list">
              {rooms.map((item) => (
                <button
                  key={string(item, 'id')}
                  className={`room-link ${item.id === roomId ? 'selected' : ''}`}
                  onClick={() => setRoomId(string(item, 'id'))}
                >
                  <span className="room-link-title">{string(item, 'title', 'Untitled room')}</span>
                  <span className="room-link-objective">{string(item, 'objective')}</span>
                  <Status value={string(item, 'status', 'open')} />
                </button>
              ))}
              {snapshot && rooms.length === 0 && (
                <p className="sidebar-empty">
                  {search ? 'No matching rooms.' : 'Your rooms will appear here.'}
                </p>
              )}
            </div>
            <button
              className="sidebar-join"
              onClick={() =>
                setAction({
                  title: 'Join room',
                  command: 'room_join',
                  description:
                    'Enter a room ID shared with you. Membership and permissions are checked by the local server.',
                  fields: [
                    { key: 'roomId', label: 'Room ID', required: true },
                    { key: 'name', label: 'Participant name', value: 'Human' },
                    {
                      key: 'product',
                      label: 'Product',
                      value: 'codex',
                      type: 'select',
                      options: products,
                    },
                  ],
                  onSuccess: (result) => {
                    if (isRecord(result)) setRoomId(string(result, 'roomId', string(result, 'id')));
                  },
                })
              }
            >
              Join by room ID
            </button>
          </aside>
          <main id="main-content" tabIndex={-1} className="room-main">
            {room && snapshot ? (
              <>
                <button className="mobile-back text-button" onClick={() => setRoomId('')}>
                  <ArrowLeft size={16} />
                  All rooms
                </button>
                <RoomView room={room} state={snapshot} run={run} openAction={setAction} />
              </>
            ) : !snapshot ? (
              <div className="empty" role="status">
                <h2>Loading rooms…</h2>
                <p>Reading the local workspace.</p>
              </div>
            ) : (
              <Empty
                title="Make room for a shared objective"
                action={
                  <button className="primary" onClick={createRoom}>
                    <Plus size={17} aria-hidden="true" />
                    Create your first room
                  </button>
                }
              >
                Create a discussion or coding room, add agents, and decide what they should work on.
                Execution always comes through your approval queue.
              </Empty>
            )}
          </main>
        </div>
      ) : (
        <main id="main-content" tabIndex={-1} className="workspace-main">
          {snapshot &&
            (view === 'workspace' ? (
              <WorkspaceView state={snapshot} room={room} run={run} openAction={setAction} />
            ) : (
              <ApprovalQueue permissions={pending} rooms={snapshot.rooms} openAction={setAction} />
            ))}
        </main>
      )}
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
      <MessageSquare size={23} strokeWidth={2.1} aria-hidden="true" />
      <span>Converoom</span>
    </div>
  );
}
export const products = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'opencode', label: 'OpenCode' },
];
export function ApprovalQueue({
  permissions,
  rooms,
  openAction,
}: {
  permissions: RecordData[];
  rooms: RecordData[];
  openAction: (action: Action) => void;
}) {
  return (
    <section className="approval-queue">
      <div className="section-heading">
        <div>
          <h1>Approval queue</h1>
          <p>Review the exact action and scope before granting execution.</p>
        </div>
        <span className="count">{permissions.length} pending</span>
      </div>
      {permissions.length === 0 && (
        <Empty title="No approvals waiting">
          An execution request appears here when an agent needs your authority. Nothing is approved
          automatically.
        </Empty>
      )}
      {permissions.map((permission) => {
        const expired =
          typeof permission.expiresAt === 'number' && permission.expiresAt <= Date.now();
        const expiry =
          typeof permission.expiresAt === 'number'
            ? new Date(permission.expiresAt).toLocaleString('en-AU')
            : 'Not supplied';
        const title = string(permission, 'action').replaceAll('_', ' ');
        const args = { requestId: permission.id };
        return (
          <article key={string(permission, 'id')} className="permission">
            <div className="row-heading">
              <h2>{title}</h2>
              <Status value={expired ? 'expired' : 'pending'} />
            </div>
            <p>{string(permission, 'summary', 'Review the scope below.')}</p>
            <dl className="metadata">
              <div>
                <dt>Room</dt>
                <dd>
                  {string(
                    rooms.find((room) => room.id === permission.roomId) ?? {},
                    'title',
                    string(permission, 'roomId'),
                  )}
                </dd>
              </div>
              <div>
                <dt>Expires</dt>
                <dd>{expiry}</dd>
              </div>
              <div>
                <dt>Request</dt>
                <dd>
                  <code>{string(permission, 'id')}</code>
                </dd>
              </div>
              <div>
                <dt>Scope digest</dt>
                <dd>
                  <code>{string(permission, 'scopeDigest')}</code>
                </dd>
              </div>
            </dl>
            <details open>
              <summary>Exact execution scope</summary>
              <pre>{JSON.stringify(permission.scope, null, 2)}</pre>
            </details>
            <div className="row-actions">
              <button
                className="primary"
                disabled={expired}
                onClick={() =>
                  openAction({
                    title: 'Grant this exact request',
                    command:
                      permission.action === 'host_transfer'
                        ? 'host_transfer_confirm'
                        : 'permission_grant',
                    args: { ...args, scopeDigest: permission.scopeDigest },
                    label: 'Grant permission',
                    confirm: `Grant “${title}” only for the displayed scope digest ${string(permission, 'scopeDigest')}. This authorises local execution until ${expiry}. Review any commands and paths in the scope first.`,
                  })
                }
              >
                Review and grant
              </button>
              <button
                onClick={() =>
                  openAction({
                    title: 'Deny request',
                    command: 'permission_deny',
                    args,
                    label: 'Deny request',
                    confirm:
                      'This request will be denied. The agent must submit a new request if its action or scope changes.',
                    danger: true,
                  })
                }
              >
                Deny
              </button>
            </div>
          </article>
        );
      })}
    </section>
  );
}
