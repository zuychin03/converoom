import { useState } from 'react';
import { isManagedProduct } from '../../../packages/shared/src/products.js';
import { isRecord, list, string, type RecordData, type Snapshot } from './api.js';
import { PRODUCTS } from './actions.js';
import { Empty, ErrorNotice, JsonDetails, Status, type Action, type Run } from './components.js';
import { shortId } from './model.js';

export function MembersView({ state, room, ownerId, run, openAction, shared = false }: {
  state: Snapshot; room?: RecordData; ownerId: string; run: Run; openAction: (a: Action) => void; shared?: boolean;
}) {
  const [invitation, setInvitation] = useState<RecordData>();
  if (!room) return <Empty title="Choose a room">Open a discussion room to manage its participants.</Empty>;
  if (room.workflow !== 'discussion') return <Empty title="Coding stays local">Shared membership is available in discussion rooms.</Empty>;
  const id = string(room, 'id'), admin = !shared && room.ownerId === ownerId;
  const members = state.members.filter((m) => m.roomId === id);
  const ownSeats = state.seats.filter((s) => s.roomId === id && s.ownerId === ownerId && s.status !== 'left');
  return <section className="collaboration" aria-labelledby="members-title">
    <h1 id="members-title">Members</h1>
    <p>Room membership allows public discussion. Each participant approves native execution on their own Windows machine.</p>
    <p className="record-id">Room ID: <code>{id}</code></p>
    {admin && <button className="button" onClick={() => openAction({ title: 'Invite participant', command: 'membership_invite', args: { roomId: id }, label: 'Create invitation',
      description: 'Share the private room address, room ID and one-use code with the intended person. Confirm their identity before activating membership.',
      fields: [{ key: 'displayName', label: 'Participant name', required: true }, { key: 'role', label: 'Membership role', type: 'select', value: 'participant', options: [{ value: 'participant', label: 'Participant' }, { value: 'observer', label: 'Observer' }] }],
      onSuccess: (v) => { if (isRecord(v)) setInvitation({ ...v, roomId: id }); } })}>Invite participant</button>}
    {invitation?.roomId === id && <section className="panel" aria-label="New invitation">
      <h2>One-use invitation</h2>
      {invitation.codeAvailable === true ? <><p>Expires in ten minutes. This code is shown once.</p><code className="record-id" data-testid="invitation-code">{string(invitation, 'code')}</code></>
        : <p>The code was already returned. Revoke this invitation and create another if delivery was uncertain.</p>}
      <button className="button" onClick={() => setInvitation(undefined)}>Hide invitation code</button>
    </section>}
    <ul className="collaboration-list">{members.map((m) => <li className="panel" key={string(m, 'id')}>
      <h2>{string(m, 'displayName')}</h2><p>{string(m, 'role')} · {string(m, 'status')} · generation {String(m.generation)}</p>
      <p className="record-id">Owner {string(m, 'ownerId')} {m.principalId ? `· Principal ${string(m, 'principalId')}` : ''}</p>
      {admin && m.ownerId !== ownerId && m.status !== 'pending' && <button className="button" onClick={() => openAction({ title: 'Recover participant identity', command: 'membership_invite',
        args: { roomId: id, displayName: m.displayName, role: m.role, recoverMemberId: m.id, expectedGeneration: m.generation }, label: 'Create recovery code',
        confirm: `Create a one-use recovery code for ${string(m, 'displayName')} after checking their identity. Redemption revokes old sessions and retires agent registrations. Confirm them again before access resumes.`,
        onSuccess: (v) => { if (isRecord(v)) setInvitation({ ...v, roomId: id }); } })}>Recover identity</button>}
      {admin && m.ownerId !== ownerId && m.status === 'pending' && <button className="button" onClick={() => openAction({ title: 'Confirm participant', command: 'membership_confirm',
        args: { roomId: id, memberId: m.id, expectedGeneration: m.generation }, label: 'Confirm participant',
        confirm: `Confirm ${string(m, 'displayName')} after checking their owner identity and generation with them. Membership does not authorise their native agent.` })}>Confirm participant</button>}
      {admin && m.ownerId !== ownerId && m.status !== 'revoked' && <button className="button" onClick={() => openAction({ title: 'Remove participant', command: 'membership_revoke',
        args: { roomId: id, memberId: m.id, expectedGeneration: m.generation }, label: 'Remove participant', danger: true,
        confirm: `Remove ${string(m, 'displayName')} and revoke their room access. Running external work remains uncertain until their machine confirms stop.` })}>Remove participant</button>}
    </li>)}</ul>
    {admin && state.invitations.filter((i) => i.roomId === id && i.status === 'available').map((i) => <div className="panel" key={string(i, 'id')}>
      <span>{string(i, 'displayName')} · invitation available</span>{' '}<button className="button small" onClick={() => openAction({ title: 'Revoke invitation', command: 'invitation_revoke', args: { roomId: id, invitationId: i.id }, confirm: 'Invalidate this unused invitation?', label: 'Revoke invitation', danger: true })}>Revoke invitation</button>
    </div>)}
    <h2>My agent permissions</h2><p>Choose who may request your agent's turns and set bounds. Each managed turn still needs approval in your local Converoom.</p>
    {ownSeats.length === 0 && <p>No agents owned by you are connected. Use Connections in your local Converoom to connect a product.</p>}
    {ownSeats.map((s) => <OwnerConsentEditor key={string(s, 'id')} seat={s} members={members} consent={state.ownerConsents.find((c) => c.seatId === s.id)} roomOwnerId={string(room, 'ownerId')} run={run} />)}
  </section>;
}

function OwnerConsentEditor({ seat, members, consent, roomOwnerId, run }: { seat: RecordData; members: RecordData[]; consent?: RecordData; roomOwnerId: string; run: Run }) {
  const [senders, setSenders] = useState<string[]>(consent ? list(consent, 'allowedSenderOwnerIds') : []);
  const [turns, setTurns] = useState(String(consent?.maxTurns ?? 3)), [ms, setMs] = useState(String(consent?.maxTurnMs ?? 60000));
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const choices = members.filter((m) => m.status === 'active');
  if (!choices.some((m) => m.ownerId === roomOwnerId)) choices.push({ ownerId: roomOwnerId, displayName: 'Room owner', status: 'active' });
  return <form className="panel consent-form" onSubmit={(e) => { e.preventDefault(); setBusy(true); setError(''); void run('owner_consent_update', { roomId: seat.roomId, seatId: seat.id, allowedSenderOwnerIds: senders, maxTurns: Number(turns), maxTurnMs: Number(ms) })
    .then(() => setNotice('Room consent saved. Local execution still requires approval.')).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Consent failed')).finally(() => setBusy(false)); }}>
    <h3>{string(seat, 'name')}</h3>
    <fieldset><legend>Allowed requesters</legend>{choices.map((m) => <label className="checkbox-label" key={string(m, 'ownerId')}>
      <input type="checkbox" checked={senders.includes(string(m, 'ownerId'))} onChange={(e) => setSenders(e.target.checked ? [...senders, string(m, 'ownerId')] : senders.filter((id) => id !== m.ownerId))} />{string(m, 'displayName')}
    </label>)}</fieldset>
    <label>Maximum requested turns<input type="number" min="1" max="60" required value={turns} onChange={(e) => setTurns(e.target.value)} /></label>
    <label>Maximum milliseconds per turn<input type="number" min="1000" max="600000" required value={ms} onChange={(e) => setMs(e.target.value)} /></label>
    <button className="button" disabled={busy}>Save room consent</button>{error && <ErrorNotice>{error}</ErrorNotice>}<p role="status">{notice}</p>
  </form>;
}

export function ConnectionsView({ state, openAction }: { state: Snapshot; run: Run; openAction: (a: Action) => void }) {
  const [authorization, setAuthorization] = useState('');
  return <section className="collaboration" aria-labelledby="connections-title"><h1 id="connections-title">Connections</h1>
    <p>Join and confirm membership in the private room first. Connect from your own Windows Converoom, using that shared browser session to approve room access.</p>
    <button className="button" onClick={() => openAction({ title: 'Connect private room', command: 'remote_connection_prepare', label: 'Prepare connection',
      fields: [{ key: 'origin', label: 'Private HTTPS origin', required: true }, { key: 'remoteRoomId', label: 'Shared room ID', required: true }, { key: 'product', label: 'Product', type: 'select', options: PRODUCTS, value: 'codex', required: true }],
      onSuccess: (v) => { if (isRecord(v)) setAuthorization(string(v, 'authorizationUrl')); } })}>Connect private room</button>
    {authorization && <p><a className="button" href={authorization} target="_blank" rel="noreferrer">Approve room connection</a></p>}
    <p>Credential storage uses private Windows files. OS keystore support remains unavailable.</p>
    <ul className="collaboration-list">{state.remoteConnections.map((c) => <li className="panel" key={string(c, 'id')}>
      <h2>My {string(c, 'product')} · {shortId(string(c, 'id'))}</h2><Status kind={c.status === 'connected' ? 'ok' : 'warn'}>{string(c, 'status')}</Status>
      <p className="record-id">{string(c, 'origin')} · room {string(c, 'remoteRoomId')}</p><p>{c.mode === 'managed' ? 'Managed discussion, exact local approval per turn' : 'Polling, connect your product with the CLI command below'}</p>
      {c.mode === 'polling' && c.status === 'connected' && <code className="record-id">converoom connect {string(c, 'product')} --remote-connection {string(c, 'id')}</code>}
      {c.status === 'connected' && c.mode === 'polling' && isManagedProduct(string(c, 'product')) && <button className="button" onClick={() => openAction({ title: 'Enable local managed discussion', command: 'remote_connection_enable', args: { connectionId: c.id }, label: 'Enable managed discussion',
        description: 'This enables your local native adapter within these bounds. Incoming proposals still need exact local acceptance and an execution grant.',
        fields: [{ key: 'maxTurns', label: 'Local turn limit', type: 'number', value: '3', required: true }, { key: 'maxTurnMs', label: 'Local turn milliseconds', type: 'number', value: '60000', required: true }] })}>Enable managed discussion</button>}
      {['connected', 'disconnected'].includes(string(c, 'status')) && <button className="button" onClick={() => openAction({ title: 'Refresh connection', command: 'remote_refresh', args: { connectionId: c.id }, label: 'Refresh connection' })}>Refresh connection</button>}
      {c.status !== 'revoked' && <button className="button" onClick={() => openAction({ title: 'Disconnect locally', command: 'remote_connection_disconnect', args: { connectionId: c.id }, label: 'Disconnect locally', danger: true,
        confirm: 'Fence local proposals and remove local room credentials. Ask the room owner to remove membership for server-side revocation. This does not confirm external work has stopped.' })}>Disconnect locally</button>}
      {c.status === 'uncertain' && <p>Inspect retained work and create a new connection. Consequential operations are not retried automatically.</p>}
    </li>)}</ul>
    <h2>Incoming proposals</h2>{state.remoteProposals.length === 0 && <p>No incoming proposals.</p>}
    {state.remoteProposals.map((p) => <section className="panel" aria-label="Incoming proposal" key={string(p, 'id')}>
      <h3>{string(p, 'prompt')}</h3><Status kind={p.status === 'pending' ? 'needs' : p.status === 'completed' ? 'ok' : 'warn'}>{string(p, 'status')}</Status>
      <p>Requester {string(p, 'senderOwnerId')} · membership {String(p.generation)} · policy {String(p.policyVersion)} · {String(p.maxTurnMs)} ms</p>
      <p>Expires {new Date(Number(p.deadline)).toLocaleString('en-AU')}</p><p className="record-id">Digest {string(p, 'digest')}</p><details><summary>Public context</summary><pre tabIndex={0}>{string(p, 'publicContext')}</pre></details>
      {p.status === 'pending' && <><button className="button" onClick={() => openAction({ title: 'Accept exact proposal', command: 'remote_turn_accept', args: { proposalId: p.id, digest: p.digest }, label: 'Accept proposal',
        confirm: 'Accept this exact public prompt and budget. Then review the separate execution request in Approvals. Acceptance alone does not run inference.' })}>Accept proposal</button>
        <button className="button" onClick={() => openAction({ title: 'Decline proposal', command: 'remote_turn_decline', args: { proposalId: p.id, digest: p.digest }, label: 'Decline proposal', confirm: 'Cancel this requested turn without starting a local agent?' })}>Decline proposal</button></>}
    </section>)}
  </section>;
}

export function ArtefactsView({ state, room, run, openAction, exportPage }: { state: Snapshot; room?: RecordData; run: Run; openAction: (a: Action) => void; exportPage?: () => Promise<unknown> }) {
  const [preview, setPreview] = useState<RecordData>(), [error, setError] = useState('');
  const [name, setName] = useState('review.md'), [content, setContent] = useState('');
  if (!room) return <Empty title="Choose a room">Open a discussion room to review shared artefacts.</Empty>;
  const id = string(room, 'id');
  async function prepare() {
    setError('');
    try {
      const bytes = new TextEncoder().encode(content);
      if (bytes.length > 1048576) throw new Error('Artefacts must be 1 MiB or less.');
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
      openAction({ title: 'Publish reviewed artefact', command: 'shared_artefact_publish', args: { roomId: id, name, content, digest, mimeType: name.endsWith('.md') ? 'text/markdown' : 'text/plain' }, label: 'Publish to room',
        confirm: `Publish the reviewed ${name} (${bytes.length} bytes) to all current room members? Digest ${digest}. Content is immutable once shared.`, onSuccess: () => setContent('') });
    } catch (e) { setError(e instanceof Error ? e.message : 'Review failed'); }
  }
  return <section className="collaboration" aria-labelledby="artefacts-title"><h1 id="artefacts-title">Shared artefacts</h1>
    <p>Paste only public text or Markdown. Review it before publishing. Maximum 1 MiB each, 10 MiB and 100 artefacts per room.</p>
    {room.workflow === 'discussion' && <form className="panel consent-form" onSubmit={(e) => { e.preventDefault(); void prepare(); }}>
      <label>Artefact name<input required value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label>Reviewed public content<textarea required rows={8} value={content} onChange={(e) => setContent(e.target.value)} /></label>
      <button className="button" disabled={room.status !== 'open'}>Review publication</button>
    </form>}
    {error && <ErrorNotice>{error}</ErrorNotice>}
    {state.sharedArtefacts.filter((a) => a.roomId === id).map((a) => <section className="panel" key={string(a, 'id')}><h2>{string(a, 'name')}</h2><p className="record-id">Owner {string(a, 'ownerId')} · digest {string(a, 'digest')} · {String(a.bytes)} bytes</p>
      <button className="button" onClick={() => void run('shared_artefact_get', { roomId: id, artefactId: a.id }).then((v) => { if (isRecord(v)) setPreview(v); }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Read failed'))}>Read {string(a, 'name')}</button></section>)}
    {preview && <section className="panel" aria-label="Artefact content"><h2>{string(preview, 'name')}</h2><pre tabIndex={0}>{string(preview, 'content')}</pre><JsonDetails value={{ digest: preview.digest, provenance: preview.provenance }} title="Provenance" /></section>}
    {exportPage && <button className="button" onClick={() => void exportPage().then((v) => { if (isRecord(v)) setPreview({ name: 'Bounded Markdown history page', content: v.markdown, digest: v.digest, provenance: { cursor: v.cursor, hasMore: v.hasMore } }); }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Export failed'))}>Review Markdown history page</button>}
  </section>;
}
