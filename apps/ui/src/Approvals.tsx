import { string, type RecordData } from './api.js';
import { Countdown, Empty, Status, type Action } from './components.js';
import { agentWaitEnds, num } from './model.js';

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
  const args = { requestId: permission.id };
  const expiry = new Date(expiresAt).toLocaleString('en-AU');
  const grant = () =>
    openAction({
      title: 'Grant this exact request',
      command: permission.action === 'host_transfer' ? 'host_transfer_confirm' : 'permission_grant',
      args: { ...args, scopeDigest: digest },
      label: 'Grant permission',
      confirm: `Grant “${action}” only for scope digest ${digest}. This authorises local execution until ${expiry}. Review any commands and paths in the scope first.`,
    });
  const deny = () =>
    openAction({
      title: 'Deny request',
      command: 'permission_deny',
      args,
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
        <summary>Exact execution scope</summary>
        <pre tabIndex={0}>{JSON.stringify(permission.scope, null, 2)}</pre>
      </details>
      <div className="slip-actions">
        <button type="button" className="button" onClick={deny}>
          Deny
        </button>
        <button type="button" className="button primary" onClick={grant}>
          Review and grant
        </button>
      </div>
    </article>
  );
}

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
    <section className="approvals" aria-labelledby="approvals-title">
      <div className="page-head">
        <h1 id="approvals-title">Approval queue</h1>
        <p>Every execution waits here for your exact, scoped grant. Nothing is approved automatically.</p>
      </div>
      {permissions.length === 0 ? (
        <Empty title="No approvals waiting">
          When an agent needs your authority to run a turn or a native tool, the exact request
          appears here and pinned in its room.
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
