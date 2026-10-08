import { useState } from 'react';
import { Play, Pause, Send, Plus, Square, Check, MessageSquare } from 'lucide-react';
import { string, objects, isRecord, type RecordData, type Snapshot } from './api.js';
import {
  ErrorNotice,
  Status,
  Empty,
  JsonDetails,
  When,
  type Run,
  type Action,
} from './components.js';
import { WorkspaceView } from './WorkspaceView.js';
const products = [
  { value: 'codex', label: 'Codex' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'claude', label: 'Claude Code' },
  { value: 'opencode', label: 'OpenCode' },
];
export function RoomView({
  room,
  state,
  run,
  openAction,
}: {
  room: RecordData;
  state: Snapshot;
  run: Run;
  openAction: (a: Action) => void;
}) {
  const [tab, setTab] = useState('conversation'),
    [text, setText] = useState(''),
    [recipient, setRecipient] = useState(''),
    [intent, setIntent] = useState('question'),
    [replyToId, setReply] = useState(''),
    [error, setError] = useState(''),
    [sending, setSending] = useState(false);
  const id = string(room, 'id'),
    seats = state.seats.filter((s) => s.roomId === id && s.status !== 'left'),
    events = state.events.filter((e) => e.roomId === id),
    interactions = state.interactions.filter((i) => i.roomId === id && i.status !== 'resolved'),
    turns = state.turns.filter((t) => t.roomId === id),
    open = room.status === 'open';
  const names = (sender: unknown) =>
    string(
      seats.find((s) => s.id === sender || s.principalId === sender) ?? {},
      'name',
      'You / host',
    );
  const act = (title: string, command: string, args: RecordData = {}, confirm?: string) =>
    openAction({ title, command, args: { roomId: id, ...args }, confirm });
  async function post(e: React.FormEvent) {
    e.preventDefault();
    setSending(true);
    setError('');
    try {
      await run('room_post', {
        roomId: id,
        text,
        ...(recipient ? { mentions: [{ seatId: recipient, intent }] } : {}),
        ...(replyToId ? { replyToId } : {}),
      });
      setText('');
      setReply('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Message failed');
    } finally {
      setSending(false);
    }
  }
  return (
    <div className="room-view">
      <header className="room-heading">
        <div>
          <div className="row-heading">
            <h1>{string(room, 'title')}</h1>
            <Status value={string(room, 'status')} />
          </div>
          <p className="objective">{string(room, 'objective')}</p>
          <p className="muted small">
            {string(room, 'workflow')} · Room <code>{id}</code>
          </p>
        </div>
        <div className="row-actions">
          <button
            onClick={() =>
              act(open ? 'Pause room' : 'Resume room', open ? 'room_pause' : 'room_resume')
            }
            disabled={room.status === 'closed'}
          >
            {open ? <Pause size={16} /> : <Play size={16} />} {open ? 'Pause' : 'Resume'}
          </button>
          <button
            onClick={() =>
              act(
                'Close room',
                'room_close',
                {},
                'Close this room and stop new dispatch. Active work remains visible until cancellation is confirmed.',
              )
            }
            disabled={room.status === 'closed'}
          >
            <Square size={15} />
            Close
          </button>
        </div>
      </header>
      <nav className="room-tabs" aria-label="Room views">
        {['conversation', 'work', 'controls'].map((t) => (
          <button key={t} className={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'work'
              ? 'Tasks and evidence'
              : t === 'controls'
                ? 'Room controls'
                : 'Conversation'}
          </button>
        ))}
      </nav>
      {tab === 'work' ? (
        <WorkspaceView state={state} room={room} run={run} openAction={openAction} />
      ) : tab === 'controls' ? (
        <div className="control-content">
          <h2>Host and policy</h2>
          <p>
            The host organises turns. Human approvals authorise execution. The originating
            conversation remains a polling participant unless you create a new managed session.
          </p>
          <JsonDetails value={room.policy} title={'Policy version ' + String(room.policyVersion)} />
          <div className="row-actions">
            <button
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
              onClick={() =>
                openAction({
                  title: 'Propose decision',
                  command: 'room_propose_decision',
                  args: { roomId: id },
                  fields: [
                    { key: 'decision', label: 'Decision', type: 'textarea', required: true },
                    { key: 'dissent', label: 'Dissent, one per line', type: 'paths' },
                    { key: 'evidence', label: 'Evidence IDs, one per line', type: 'paths' },
                  ],
                })
              }
            >
              Propose decision
            </button>
            <button
              onClick={() =>
                openAction({
                  title: 'Change policy',
                  command: 'policy_update',
                  args: { roomId: id },
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
          <h2>Interaction obligations</h2>
          {interactions.map((i) => (
            <div className="obligation" key={string(i, 'id')}>
              <span>
                {names(i.senderId)} → {names(i.recipientId)}
              </span>
              <Status value={string(i, 'status')} />
              <button
                onClick={() =>
                  openAction({
                    title: 'Resolve interaction',
                    command: 'interaction_resolve',
                    args: { roomId: id, interactionId: i.id },
                    fields: [
                      {
                        key: 'reason',
                        label: 'Resolution and remaining risks',
                        type: 'textarea',
                        required: true,
                      },
                    ],
                  })
                }
              >
                <Check size={15} />
                Resolve
              </button>
              <JsonDetails value={i} />
            </div>
          ))}
          {!interactions.length && <p>No unresolved obligations.</p>}
        </div>
      ) : (
        <div className="conversation-layout">
          <div className="conversation-column">
            <div className="transcript" role="log" aria-label="Public room conversation">
              {events
                .filter((e) => ['message', 'agenda', 'decision'].includes(string(e, 'type')))
                .map((e) => {
                  const data = isRecord(e.data) ? e.data : {};
                  return (
                    <article
                      className={'message message-' + string(e, 'type')}
                      key={string(e, 'id')}
                    >
                      <header>
                        <strong>{names(data.senderId ?? e.actorId)}</strong>
                        <span>{string(e, 'type')}</span>
                        <When at={e.at} />
                      </header>
                      <div className="message-text">
                        {string(data, 'text', string(data, 'agenda', string(data, 'decision')))}
                      </div>
                      {objects(data, 'mentions').map((m) => (
                        <span className="recipient" key={string(m, 'seatId')}>
                          {string(m, 'intent')} to {names(m.seatId)}
                        </span>
                      ))}
                      {data.replyToId !== null && data.replyToId !== undefined && (
                        <p className="small muted">
                          Reply to <code>{String(data.replyToId)}</code>
                        </p>
                      )}
                    </article>
                  );
                })}
              {!events.some((e) => e.type === 'message') && (
                <Empty title="Start the discussion">
                  Post a question or request a managed turn. Text names do not wake agents; choose a
                  directed recipient.
                </Empty>
              )}
            </div>
            {error && <ErrorNotice>{error}</ErrorNotice>}
            <form className="composer" onSubmit={(e) => void post(e)}>
              <label className="field">
                <span>Public message</span>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Share a question, critique or decision…"
                  required
                  disabled={!open || sending}
                  rows={3}
                />
              </label>
              <div className="composer-options">
                <label>
                  <span className="small">Directed recipient</span>
                  <select
                    aria-label="Directed recipient"
                    value={recipient}
                    onChange={(e) => setRecipient(e.target.value)}
                    disabled={!open}
                  >
                    <option value="">Room broadcast</option>
                    {seats.map((s) => (
                      <option key={string(s, 'id')} value={string(s, 'id')}>
                        {string(s, 'name')}
                      </option>
                    ))}
                  </select>
                </label>
                {recipient && (
                  <select
                    aria-label="Interaction intent"
                    value={intent}
                    onChange={(e) => setIntent(e.target.value)}
                  >
                    {['question', 'review', 'challenge'].map((i) => (
                      <option key={i}>{i}</option>
                    ))}
                  </select>
                )}
                <button className="primary" disabled={!open || sending || !text.trim()}>
                  <Send size={16} />
                  {sending ? 'Posting…' : 'Post message'}
                </button>
              </div>
              {replyToId && (
                <p>
                  Replying to {replyToId}
                  <button type="button" onClick={() => setReply('')}>
                    Cancel reply
                  </button>
                </p>
              )}
            </form>
          </div>
          <aside className="participants" aria-label="Agents and turns">
            <div className="section-heading">
              <h2>In the room</h2>
              <button
                className="icon-button"
                aria-label="Add agent"
                disabled={!open}
                onClick={() =>
                  openAction({
                    title: 'Add agent',
                    command: 'seat_add',
                    args: { roomId: id },
                    fields: [
                      { key: 'name', label: 'Agent name', required: true },
                      {
                        key: 'product',
                        label: 'Product',
                        type: 'select',
                        options: products,
                        required: true,
                        value: 'codex',
                      },
                      {
                        key: 'mode',
                        label: 'Connection',
                        type: 'select',
                        options: [
                          { value: 'managed', label: 'New managed session' },
                          { value: 'polling', label: 'Existing MCP conversation' },
                        ],
                        value: 'managed',
                        required: true,
                      },
                      {
                        key: 'role',
                        label: 'Role',
                        type: 'select',
                        options: [
                          { value: 'member', label: 'Member' },
                          { value: 'host', label: 'Host' },
                          { value: 'observer', label: 'Observer' },
                        ],
                        value: 'member',
                      },
                    ],
                  })
                }
              >
                <Plus size={17} />
              </button>
            </div>
            {!seats.length && (
              <p className="muted">
                Add a managed agent, or let an existing MCP conversation join.
              </p>
            )}
            {seats.map((s) => (
              <section className="participant" key={string(s, 'id')}>
                <div className="row-heading">
                  <strong>{string(s, 'name')}</strong>
                  <Status value={string(s, 'status')} />
                </div>
                <p className="small">
                  {string(s, 'product')} · {string(s, 'role')} · {string(s, 'mode')}
                </p>
                <p className="small muted">
                  {s.mode === 'managed'
                    ? 'Each turn starts a separate managed session.'
                    : 'Polls the inbox; outside runtime process control.'}
                </p>
                {s.sessionId !== undefined && (
                  <p className="small">
                    <code>{String(s.sessionId)}</code>
                  </p>
                )}
                <div className="row-actions">
                  {s.mode === 'managed' && (
                    <>
                      <button
                        onClick={() =>
                          act(
                            s.consent ? 'Revoke consent' : 'Allow turn requests',
                            'seat_consent',
                            { seatId: s.id, consent: !s.consent },
                            s.consent
                              ? 'Queued dispatch will be blocked. Active work remains visible.'
                              : 'Allow the host to request turns for this seat. Each turn still needs your scoped execution approval.',
                          )
                        }
                      >
                        {s.consent ? 'Revoke consent' : 'Allow requests'}
                      </button>
                      <button
                        disabled={!open || !s.consent}
                        onClick={() =>
                          openAction({
                            title: 'Request managed turn',
                            command: 'turn_request',
                            args: { roomId: id, seatId: s.id },
                            description:
                              'This creates an execution request. Review and grant it in Approvals before the new session runs.',
                            fields: [
                              {
                                key: 'prompt',
                                label: 'Assigned prompt',
                                type: 'textarea',
                                required: true,
                              },
                            ],
                          })
                        }
                      >
                        <Play size={14} />
                        Request turn
                      </button>
                    </>
                  )}
                </div>
                <JsonDetails
                  value={s.capabilities}
                  title="Declared, probed and tested capabilities"
                />
              </section>
            ))}
            <h2>Turns</h2>
            {turns
              .slice()
              .reverse()
              .map((t) => (
                <section key={string(t, 'id')} className="turn">
                  <div className="row-heading">
                    <strong>{names(t.seatId)}</strong>
                    <Status value={string(t, 'status')} />
                  </div>
                  <p>{string(t, 'prompt')}</p>
                  {t.error !== undefined && <ErrorNotice>{String(t.error)}</ErrorNotice>}
                  {['queued', 'running', 'dispatching', 'cancelling'].includes(
                    string(t, 'status'),
                  ) && (
                    <button onClick={() => act('Cancel turn', 'turn_cancel', { turnId: t.id })}>
                      Cancel turn
                    </button>
                  )}
                  {t.status === 'cancelling' && (
                    <button
                      onClick={() =>
                        act(
                          'Stop managed worker',
                          'managed_stop',
                          { turnId: t.id },
                          'Stop this runtime-owned worker process tree. Work is preserved; unknown execution is quarantined.',
                        )
                      }
                    >
                      Stop worker
                    </button>
                  )}
                  <JsonDetails value={t} />
                </section>
              ))}
            <h2>Pending interactions</h2>
            {interactions.map((i) => (
              <div className="obligation" key={string(i, 'id')}>
                <MessageSquare size={15} />
                <span>{names(i.recipientId)}</span>
                <Status value={string(i, 'status')} />
                {seats.find((s) => s.id === i.recipientId)?.mode === 'managed' ? (
                  <button
                    disabled={
                      !!i.turnId || !open || !seats.find((s) => s.id === i.recipientId)?.consent
                    }
                    onClick={() =>
                      openAction({
                        title: 'Request linked reply',
                        command: 'turn_request',
                        args: { roomId: id, seatId: i.recipientId, interactionId: i.id },
                        description:
                          'The recipient replies through its managed turn after your scoped approval.',
                        fields: [
                          {
                            key: 'prompt',
                            label: 'Reply instructions',
                            type: 'textarea',
                            required: true,
                          },
                        ],
                      })
                    }
                  >
                    Request reply
                  </button>
                ) : (
                  <span className="muted small">Waiting for recipient inbox</span>
                )}
              </div>
            ))}
            {!interactions.length && <p className="muted small">No unresolved questions.</p>}
          </aside>
        </div>
      )}
    </div>
  );
}
