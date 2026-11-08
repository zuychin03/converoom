import { useState } from 'react';
import { string, type RecordData } from './api.js';
import { grantAction } from './actions.js';
import { Countdown, Empty, ErrorNotice, Status, type Action, type Run } from './components.js';
import { agentWaitEnds, fmtBytes, num } from './model.js';

export function GrantSlip({
  permission,
  roomTitle,
  compact = false,
  openAction,
}: {
  permission: RecordData;
  roomTitle?: string;
  compact?: boolean;
  openAction: (action: Action) => void;
}) {
  const action = string(permission, 'action').replaceAll('_', ' ');
  const digest = string(permission, 'scopeDigest');
  const expiresAt = num(permission, 'expiresAt') ?? 0;
  const waitEnds = agentWaitEnds(permission);
  const transfer = permission.action === 'host_transfer';
  const plan = permission.action === 'round_robin';
  const attach = permission.action === 'seat_attach';
  const grant = () => openAction(grantAction(permission));
  const deny = () =>
    openAction({
      title: 'Deny request',
      command: 'permission_deny',
      args: { requestId: permission.id },
      label: 'Deny request',
      confirm:
        'This request will be denied. The agent must submit a new request if its action or scope changes.',
      danger: true,
    });
  return (
    <article className={`slip${compact ? ' compact' : ''}`} aria-label={`Approval request: ${action}`}>
      <div className="slip-head">
        <Status kind="needs">Needs you</Status>
        <h3 className="slip-title">{action}</h3>
        {roomTitle && <span className="slip-room">{roomTitle}</span>}
      </div>
      <p className="slip-summary">{string(permission, 'summary', 'Review the scope below.')}</p>
      <dl className="slip-meta">
        <div>
          <dt>Expires in</dt>
          <dd>
            <Countdown until={expiresAt} urgentBelow={120000} />
          </dd>
        </div>
        {waitEnds !== undefined && (
          <div>
            <dt>Agent waits</dt>
            <dd>
              <Countdown until={waitEnds} />
            </dd>
          </div>
        )}
        <div>
          <dt>Scope digest</dt>
          <dd>
            <code title={digest}>{digest.slice(0, 16)}</code>
          </dd>
        </div>
      </dl>
      <details className="raw" open={!compact}>
        <summary>{transfer ? 'Exact transfer request' : plan ? 'Exact round-robin plan' : attach ? 'Exact attach request' : 'Exact execution scope'}</summary>
        <pre tabIndex={0}>{JSON.stringify(permission.scope, null, 2)}</pre>
      </details>
      <div className="slip-actions">
        <button type="button" className="button" onClick={deny}>
          Deny
        </button>
        <button type="button" className="button primary" onClick={grant}>
          {transfer ? 'Review transfer' : plan ? 'Review plan' : attach ? 'Review attach' : 'Review and grant'}
        </button>
      </div>
    </article>
  );
}

// FR-63: an agent's context import waits here privately; only an approval adds it to the room.
export function ContextSlip({ request, requester, read, openAction }: {
  request: RecordData;
  requester: string;
  read: Run;
  openAction: (action: Action) => void;
}) {
  const [excerpt, setExcerpt] = useState<string>();
  const [error, setError] = useState('');
  const title = string(request, 'title'), destination = string(request, 'destination');
  const command = request.connectionId ? 'remote_context_decide' : 'session_context_decide';
  const reach = request.shared === true
    ? `This room is shared: once approved, the excerpt and summary can be read by the other owners in ${destination}.`
    : `Once approved, agents in ${destination} can read the excerpt and attach it with @.`;
  const load = () => {
    if (excerpt !== undefined) return;
    read('session_context_request_get', { requestId: request.id }).then(
      (result) => setExcerpt(string(result as RecordData, 'excerpt')),
      (cause: unknown) => setError(cause instanceof Error ? cause.message : 'The excerpt did not load. Try again.'),
    );
  };
  return (
    <article className="slip" aria-label={`Context import request: ${title}`}>
      <div className="slip-head">
        <Status kind="needs">Needs you</Status>
        <h3 className="slip-title">context import</h3>
        <span className="slip-room">{destination}</span>
      </div>
      <p className="slip-summary">{requester} asks to import “{title}” from {string(request, 'product')}.</p>
      <p className="slip-summary">{reach}</p>
      <dl className="slip-meta">
        <div><dt>Expires in</dt><dd><Countdown until={num(request, 'expiresAt') ?? 0} urgentBelow={120000} /></dd></div>
        <div><dt>Size</dt><dd>{fmtBytes(num(request, 'bytes') ?? 0)}</dd></div>
        <div><dt>Content digest</dt><dd><code title={string(request, 'digest')}>{string(request, 'digest').slice(0, 16)}</code></dd></div>
      </dl>
      <p className="slip-summary">Summary: {string(request, 'summary')}</p>
      <details className="raw" onToggle={(event) => { if (event.currentTarget.open) load(); }}>
        <summary>Redacted excerpt</summary>
        {error ? <ErrorNotice dismiss={() => setError('')}>{error}</ErrorNotice>
          : <pre tabIndex={0} aria-label={'Excerpt of ' + title}>{excerpt ?? 'Loading…'}</pre>}
      </details>
      <div className="slip-actions">
        <button type="button" className="button" onClick={() => openAction({ title: 'Decline context import', command,
          args: { requestId: request.id, approve: false }, label: 'Decline import', danger: true,
          confirm: 'Nothing from this request reaches the room, and its excerpt is deleted from this computer.' })}>
          Decline
        </button>
        <button type="button" className="button primary" onClick={() => openAction({ title: 'Approve context import', command,
          args: { requestId: request.id, approve: true }, label: 'Approve import', description: reach,
          confirm: `Import “${title}” (${fmtBytes(num(request, 'bytes') ?? 0)}, digest ${string(request, 'digest').slice(0, 16)}) into ${destination}.` })}>
          Review and approve
        </button>
      </div>
    </article>
  );
}

export function ApprovalQueue({
  permissions,
  rooms,
  openAction,
  contextRequests = [],
  seats = [],
  read,
}: {
  permissions: RecordData[];
  rooms: RecordData[];
  openAction: (action: Action) => void;
  contextRequests?: RecordData[];
  seats?: RecordData[];
  read?: Run;
}) {
  return (
    <section className="approvals" aria-labelledby="approvals-title">
      <div className="page-head">
        <h1 id="approvals-title">Approval queue</h1>
        <p>Every execution and host transfer waits here for your exact, scoped decision. Nothing is approved automatically.</p>
      </div>
      {read && contextRequests.length > 0 && (
        <div className="slip-list">
          {contextRequests.map((request) => (
            <ContextSlip key={string(request, 'id')} request={request} read={read} openAction={openAction}
              requester={string(seats.find((s) => s.id === request.seatId) ?? {}, 'name', 'An agent')} />
          ))}
        </div>
      )}
      {permissions.length === 0 && !contextRequests.length ? (
        <Empty title="No approvals waiting">
          When an agent needs your authority to run a turn or a native tool, or a host transfer needs
          your confirmation, the exact request appears here and pinned in its room.
        </Empty>
      ) : (
        <div className="slip-list">
          {permissions.map((permission) => (
            <GrantSlip
              key={string(permission, 'id')}
              permission={permission}
              roomTitle={string(
                rooms.find((room) => room.id === permission.roomId) ?? {},
                'title',
                string(permission, 'roomId'),
              )}
              openAction={openAction}
            />
          ))}
        </div>
      )}
    </section>
  );
}
