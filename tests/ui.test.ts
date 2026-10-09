import { describe, expect, it, vi } from 'vitest';
import { createClient, ApiError, parseSnapshot } from '../apps/ui/src/api.js';
import { visibleTurn } from '../apps/ui/src/model.js';

describe('browser command boundary', () => {
  it('uses public lifecycle evidence rather than presenting a historical request as still queued', () => {
    const queued = { id: 'turn', seatId: 'removed-seat', status: 'queued' };
    const state = parseSnapshot({ events: [{ roomId: 'room', seq: 10, type: 'turn.cancelled', data: { turnId: 'turn' } }] });
    expect(visibleTurn(state, 'room', queued)).toMatchObject({ status: 'cancelled' });
    expect(visibleTurn(parseSnapshot({}), 'room', queued)).toMatchObject({ status: 'unavailable' });
    expect(visibleTurn(parseSnapshot({ turns: [{ ...queued, roomId: 'room', status: 'running' }] }), 'room', queued)).toMatchObject({ status: 'running' });
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
