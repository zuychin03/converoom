import { describe, expect, it, vi } from 'vitest';
import { createClient, ApiError, parseSnapshot } from '../apps/ui/src/api.js';
import { grantAction } from '../apps/ui/src/actions.js';
import { capabilityLine, commandLabel, failureLabel, interruptedFor, requestDetails, seatState, turnEvidence, turnKind, turnTarget, visibleTurn, workerSeat } from '../apps/ui/src/model.js';
import { coalesce } from '../apps/ui/src/refresh.js';

describe('browser command boundary', () => {
  it('offers turns and coding work only to seats the backend admits', () => {
    const managed = { mode: 'managed', product: 'codex', role: 'member', status: 'idle' };
    expect([turnTarget(managed), workerSeat(managed)]).toEqual([true, true]);
    expect([turnTarget({ ...managed, mode: 'polling' }), workerSeat({ ...managed, mode: 'polling' })]).toEqual([true, false]);
    for (const refused of [{ ...managed, role: 'observer' }, { ...managed, status: 'left' }, { ...managed, product: 'claude' }])
      expect([turnTarget(refused), workerSeat(refused)]).toEqual([false, false]);
    expect(turnTarget({ ...managed, product: 'claude', mode: 'polling' })).toBe(true);
    const label = (seat: Record<string, unknown>) => seatState({ id: 'seat', ...seat }, parseSnapshot({}), 0).label;
    expect([label(managed), label({ ...managed, role: 'observer' }), label({ ...managed, product: 'claude' })])
      .toEqual(['Requests off', 'Observing', 'Turns unavailable']);
  });
  it('stops flagging an uncertain turn once the owner records an inspection', () => {
    const seat = { id: 'seat', mode: 'managed', product: 'codex', role: 'member', consent: true };
    const turn = { id: 'turn', seatId: 'seat', status: 'uncertain', failure: 'turn_timeout', createdAt: 1 };
    const state = (t: Record<string, unknown>) => parseSnapshot({ seats: [seat], turns: [t] });
    expect(turnKind(turn, state(turn), 0)).toEqual({ kind: 'warn', label: 'Uncertain · timed out' });
    expect(seatState(seat, state(turn), 0)).toMatchObject({ kind: 'warn' });
    const inspected = { ...turn, inspection: { finding: 'not_acted', note: '', at: 2, by: 'owner' } };
    expect(turnKind(inspected, state(inspected), 0)).toEqual({ kind: 'closed', label: 'Uncertain · inspected, agent did not act' });
    expect(seatState(seat, state(inspected), 0)).toMatchObject({ kind: 'idle', label: 'Ready' });
  });
  it('lists the execution evidence an owner needs to inspect a turn', () => {
    const state = parseSnapshot({ seats: [{ id: 'managed', mode: 'managed' }, { id: 'polling', mode: 'polling' }],
      events: [{ id: 'answer-event', roomId: 'room', seq: 12, type: 'message', data: {} }] });
    const labels = (rows: [string, string][]) => Object.fromEntries(rows);
    const uncertain = labels(turnEvidence({ seatId: 'managed', status: 'uncertain', dispatchBoundaryAt: 1, sessionId: 'session-abcdef', failure: 'turn_timeout',
      cancelRequestedAt: 2 }, state));
    expect(uncertain.Dispatch).toMatch(/^Committed /);
    expect(uncertain['Native session']).toBe('session-abcd… · stop not confirmed');
    expect(uncertain).toMatchObject({ 'Outcome code': 'turn_timeout', Containment: 'Trusted local and advisory, not a sandbox' });
    expect(uncertain['Cancel requested']).toBeDefined();
    const done = labels(turnEvidence({ seatId: 'managed', status: 'completed', dispatchBoundaryAt: 1, sessionId: 'session-abcdef', sessionStoppedAt: 3,
      responseEventId: 'answer-event' }, state));
    expect(done['Native session']).toMatch(/^session-abcd… · stop confirmed /);
    expect(done['Posted answer']).toBe('Entry 012');
    expect(labels(turnEvidence({ seatId: 'managed', status: 'failed' }, state)).Dispatch).toBe('Never committed, so known not sent');
    expect(labels(turnEvidence({ seatId: 'managed', status: 'queued' }, state)).Dispatch).toBe('Not yet');
    const polling = labels(turnEvidence({ seatId: 'polling', status: 'uncertain' }, state));
    expect(polling).toEqual({ 'Native session': 'External conversation, outside runtime control' });
  });
  it('labels declared, probed and tested capabilities separately', () => {
    expect(capabilityLine({ capabilities: { declared: ['prompt', 'cancel'], probed: [], tested: [] } }))
      .toBe('Declared prompt, cancel · probed not yet · tested not yet');
    expect(capabilityLine({ capabilities: { declared: ['prompt', 'cancel'], probed: ['prompt'], tested: ['prompt'] } }))
      .toBe('Declared prompt, cancel · probed prompt · tested prompt');
    expect(capabilityLine({})).toBe('Declared none · probed not yet · tested not yet');
  });
  it('confirms a host transfer as orchestration that authorises no execution', () => {
    const request = { id: 'request', scopeDigest: 'digest', expiresAt: Date.UTC(2026, 9, 12) };
    const transfer = grantAction({ ...request, action: 'host_transfer', scope: { seatId: 'seat' } });
    expect(transfer).toMatchObject({ title: 'Confirm host transfer', command: 'host_transfer_confirm', label: 'Transfer host',
      args: { requestId: 'request', scopeDigest: 'digest' } });
    expect(transfer.confirm).toContain('authorises no local execution');
    expect(transfer.confirm).not.toContain('authorises local execution');
    const execution = grantAction({ ...request, action: 'turn_execute' });
    expect(execution).toMatchObject({ title: 'Grant this exact request', command: 'permission_grant', label: 'Grant permission' });
    expect(execution.confirm).toContain('This authorises local execution until');
  });
  it('uses public lifecycle evidence rather than presenting a historical request as still queued', () => {
    const queued = { id: 'turn', seatId: 'removed-seat', status: 'queued' };
    const state = parseSnapshot({ events: [{ roomId: 'room', seq: 10, type: 'turn.cancelled', data: { turnId: 'turn' } }] });
    expect(visibleTurn(state, 'room', queued)).toMatchObject({ status: 'cancelled' });
    expect(visibleTurn(parseSnapshot({}), 'room', queued)).toMatchObject({ status: 'unavailable' });
    expect(visibleTurn(parseSnapshot({ turns: [{ ...queued, roomId: 'room', status: 'running' }] }), 'room', queued)).toMatchObject({ status: 'running' });
  });
  it('shows interrupted commands for the open room plus room-less ones, with readable labels and identifiers', () => {
    const state = parseSnapshot({ interruptedCommands: [
      { id: 'a', command: 'task_submit', args: { roomId: 'room', attemptId: 'attempt-1' } },
      { id: 'b', command: 'repo_register', args: { path: 'C:/repo', name: 'repo' } },
      { id: 'c', command: 'task_claim', args: { roomId: 'other', taskId: 'task-2' } },
      { id: 'd', command: 'custom_step' },
    ] });
    expect(interruptedFor(state, 'room').map((entry) => entry.id)).toEqual(['a', 'b', 'd']);
    expect(interruptedFor(state, '').map((entry) => entry.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(commandLabel('task_submit')).toBe('Submit work');
    expect(commandLabel('custom_step')).toBe('custom step');
    expect(requestDetails({ roomId: 'room', attemptId: 'attempt-1', manifestIds: ['m1', 'm2'], confirm: true }, 'room'))
      .toBe('attemptId attempt-1 · manifestIds m1, m2 · confirm true');
    expect(requestDetails(undefined, 'room')).toBe('');
  });
  it('follows refreshes requested mid-load with exactly one trailing load', async () => {
    const releases: Array<() => void> = [];
    const refresh = coalesce(() => new Promise<void>((resolve) => { releases.push(resolve); }));
    const requests = [refresh(), refresh(), refresh()];
    expect(releases).toHaveLength(1);
    releases[0]!();
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    let settled = false;
    void Promise.all(requests).then(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);
    releases[1]!();
    await Promise.all(requests);
    expect(releases).toHaveLength(2);
    void refresh();
    expect(releases).toHaveLength(3);
    releases[2]!();
  });
  it('names a room budget refusal instead of a generic failure', () => {
    expect(failureLabel({ status: 'failed', failure: 'budget' })).toBe('Failed · budget');
  });
  it('keeps the reason on uncertain turns', () => {
    const state = parseSnapshot({});
    expect(turnKind({ status: 'uncertain', failure: 'turn_timeout' }, state, 0)).toEqual({ kind: 'warn', label: 'Uncertain · timed out' });
    expect(turnKind({ status: 'uncertain' }, state, 0)).toEqual({ kind: 'warn', label: 'Uncertain' });
  });
  it('keeps shared browser commands on their scoped routes and freezes current authority', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const value = url.endsWith('/session') ? { csrf: 'shared-csrf', roomId: 'shared-room', generation: 7, membershipStatus: 'active' }
        : url.endsWith('/state') ? { room: { id: 'shared-room', policyVersion: 3 }, members: [{ ownerId: 'other' }], seats: [], events: [], turns: [], interactions: [{ id: 'receipt', status: 'read' }], artefacts: [], permissions: [{ private: true }] }
        : { result: { saved: true } };
      return new Response(JSON.stringify(value));
    };
    const client = createClient(transport, true);
    await client.join('shared-room', 'invitation-secret'); await client.session();
    const state = await client.state();
    expect(state.rooms[0]?.id).toBe('shared-room'); expect(state.permissions).toEqual([]);
    expect(state.interactions).toEqual([{ id: 'receipt', status: 'read' }]);
    await client.command('room_post', { roomId: 'shared-room', text: 'Public', clientKey: 'once', expectedGeneration: 999 });
    expect(calls.map((c) => c.url)).toEqual(['/shared/v1/join', '/shared/v1/session', '/shared/v1/browser/state', '/shared/v1/browser/commands']);
    expect(calls.every((c) => !c.url.includes('invitation-secret'))).toBe(true);
    expect(JSON.parse(String(calls[3]!.init!.body)).args).toMatchObject({ expectedGeneration: 7, expectedPolicyVersion: 3 });
    expect(calls[3]!.init!.headers).toMatchObject({ 'X-CSRF-Token': 'shared-csrf' });
  });

  it('reports ambiguous commits without retrying a consequential browser action', async () => {
    const transport = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith('/session') ? { csrf: 'csrf' }
      : { error: { message: 'Delivery uncertain', code: 'uncertain', committed: null, retrySafe: false } }), { status: url.endsWith('/session') ? 200 : 500 }));
    const client = createClient(transport); await client.session();
    await expect(client.command('remote_turn_accept', { proposalId: 'p' })).rejects.toMatchObject({ committed: null, retrySafe: false });
    expect(transport).toHaveBeenCalledTimes(2);
  });
  it('pairs through the body and uses the session CSRF token for commands', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const transport = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(
        JSON.stringify(
          url === '/api/session' ? { csrf: 'csrf-fixture' } : { result: { id: 'room1' } },
        ),
        { status: 200 },
      );
    });
    const client = createClient(transport);
    await client.pair('one-use-code');
    await client.session();
    expect(await client.command('room_create', { title: 'Review', clientKey: 'key1' })).toEqual({
      id: 'room1',
    });
    expect(calls.every((call) => !call.url.includes('one-use-code'))).toBe(true);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ code: 'one-use-code' });
    expect(calls[2]?.init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-fixture' });
    expect(calls[2]?.init?.credentials).toBe('same-origin');
  });

  it('refuses mutation before authentication and propagates server rejection', async () => {
    const transport = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'Session expired', code: 'unauthorised' }), {
          status: 401,
        }),
    );
    const client = createClient(transport);
    await expect(client.command('permission_grant', { requestId: 'request1' })).rejects.toThrow(
      'Pair this browser',
    );
    expect(transport).not.toHaveBeenCalled();
    await expect(client.session()).rejects.toBeInstanceOf(ApiError);
  });

  it('never treats malformed state as an empty successful room list', () => {
    expect(() => parseSnapshot(null)).toThrow('Invalid state');
    expect(() => parseSnapshot({ rooms: 'unexpected' })).toThrow('Invalid rooms');
    const state = parseSnapshot({ rooms: [{ id: 'room1' }], events: [] });
    expect(state.rooms).toEqual([{ id: 'room1' }]);
    expect(state.tasks).toEqual([]);
  });
});
