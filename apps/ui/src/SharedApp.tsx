import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, createClient, isRecord, string, type RecordData, type Snapshot } from './api.js';
import { Brand, ThemeSwitch } from './App.js';
import { ArtefactsView, MembersView } from './Collaboration.js';
import { ActionDialog, ErrorNotice, type Action } from './components.js';
import { RoomView } from './RoomView.js';
import { useTheme } from './theme.js';

const client = createClient(undefined, true);
export function SharedApp() {
  const [session, setSession] = useState<RecordData>(), [snapshot, setSnapshot] = useState<Snapshot>();
  const [phase, setPhase] = useState<'checking' | 'join' | 'pending' | 'ready'>('checking');
  const [roomId, setRoomId] = useState(''), [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [view, setView] = useState<'room' | 'members' | 'artefacts'>('room'), [action, setAction] = useState<Action>();
  const [focusSeq, setFocusSeq] = useState<number | null>(null), [connected, setConnected] = useState(false);
  const inFlight = useRef(false), theme = useTheme();
  const refresh = useCallback(async () => {
    if (inFlight.current) return; inFlight.current = true;
    try {
      const current = await client.session(); setSession(current); setRoomId(string(current, 'roomId'));
      if (current.membershipStatus !== 'active') { setPhase('pending'); setSnapshot(undefined); return; }
      setSnapshot(await client.state()); setPhase('ready'); setError('');
    } catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 403)) { setSnapshot(undefined); setSession(undefined); setAction(undefined); setView('room'); setPhase('join'); }
      else if (phase === 'checking') setPhase('join');
      if (!(e instanceof ApiError && e.status === 401 && phase === 'checking')) setError(e instanceof Error ? e.message : 'Private room unavailable');
      setConnected(false);
    } finally { inFlight.current = false; }
  }, [phase]);
  useEffect(() => { void refresh(); }, []);
  useEffect(() => {
    if (phase !== 'pending' && phase !== 'ready') return;
    const timer = setInterval(() => void refresh(), phase === 'pending' ? 2000 : 12000);
    const focus = () => void refresh(); window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [phase, refresh]);
  useEffect(() => {
    if (phase !== 'ready') return;
    const events = new EventSource(client.eventsPath);
    events.onopen = () => setConnected(true); events.onerror = () => { setConnected(false); void refresh(); };
    events.addEventListener('room', () => void refresh());
    return () => events.close();
  }, [phase, refresh]);
  async function run(name: string, args: RecordData) {
    try { const result = await client.command(name, { ...args, clientKey: crypto.randomUUID() }); await refresh(); setNotice('Change saved.'); return result; }
    catch (e) { await refresh(); throw e; }
  }
  const actor = session && isRecord(session.actor) ? session.actor : {};
  const room = snapshot?.rooms[0];
  const authorizationRequest = new URL(window.location.href).searchParams.get('authorization_request');
  if (phase === 'checking') return <main className="boot"><Brand /><p role="status">Checking private room membership…</p></main>;
  if (phase === 'join' || phase === 'pending') return <div className="pair"><header className="pair-head"><Brand /><span>Private shared discussion</span></header>
    <main className="pair-body"><div className="pair-copy"><h1>{phase === 'pending' ? 'Waiting for your inviter' : 'Join your private room'}</h1>
      <p>Use the one-use invitation from the room owner. Membership allows public room access. Native execution requires approval on your own machine.</p></div>
      {phase === 'pending' ? <section className="panel"><h2>Confirmation pending</h2><p>{string(session ?? {}, 'displayName')} · generation {String(session?.generation)}</p>
        <p className="record-id">Your owner identity: {string(actor, 'ownerId')}</p><p>Confirm this identity with the inviter before they activate membership.</p><button className="button" onClick={() => void refresh()}>Check confirmation</button></section>
        : <form className="pair-form" onSubmit={(e) => { e.preventDefault(); setBusy(true); setError(''); void client.join(roomId.trim(), code.trim(), recovery).then(async () => { setCode(''); await refresh(); }).catch((e: unknown) => setError(e instanceof Error ? e.message : 'Join failed')).finally(() => setBusy(false)); }}>
          <label>Shared room ID<input required value={roomId} onChange={(e) => setRoomId(e.target.value)} /></label>
          <label>Invitation code<input required autoComplete="off" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} /></label>
          <label className="checkbox-label"><input type="checkbox" checked={recovery} onChange={(e) => setRecovery(e.target.checked)} />Recover my existing identity</label>
          <p>Returning after session expiry? Ask the room owner for a recovery code. Your identity and history stay intact; reconnect agents and approve fresh consent after confirmation.</p>
          <button className="button primary" disabled={busy}>Redeem invitation</button>
        </form>}{error && <ErrorNotice>{error}</ErrorNotice>}</main></div>;
  return <div className="app"><a className="skip-link" href="#main-content">Skip to content</a><header className="topbar"><Brand />
    <nav className="nav" aria-label="Shared room">{(['room', 'members', 'artefacts'] as const).map((v) => <button key={v} className={view === v ? 'active' : ''} aria-current={view === v ? 'page' : undefined} onClick={() => setView(v)}>{v === 'room' ? 'Room' : v === 'members' ? 'Members' : 'Artefacts'}</button>)}</nav>
    <div className="topbar-end"><span className="connection-text">{connected ? 'Connected' : 'Reconnecting'}</span><ThemeSwitch choice={theme.choice} setChoice={theme.setChoice} /><button className="button small" onClick={() => void refresh()}>Refresh</button></div></header>
    {error && <ErrorNotice>{error}</ErrorNotice>}<div className="sr-only" role="status">{notice}</div>
    {authorizationRequest && <p className="panel"><a className="button" href={'/shared/authorize?request=' + encodeURIComponent(authorizationRequest)}>Review bridge access</a></p>}
    <main id="main-content" tabIndex={-1} className={'main main-' + view}>{snapshot && room && (view === 'members'
      ? <MembersView state={snapshot} room={room} ownerId={string(actor, 'ownerId')} run={run} openAction={setAction} shared />
      : view === 'artefacts' ? <ArtefactsView state={snapshot} room={room} run={run} openAction={setAction} exportPage={() => client.exportPage()} />
      : <div className="room-layout shared-room-layout"><RoomView room={room} state={snapshot} humanId={string(actor, 'principalId')} run={run} openAction={setAction} focusSeq={focusSeq} setFocusSeq={setFocusSeq} onAllRooms={() => setView('members')} shared /></div>)}</main>
    {action && <ActionDialog key={action.command} action={action} close={() => setAction(undefined)} run={run} />}
  </div>;
}
