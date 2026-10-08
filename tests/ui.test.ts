import { describe, expect, it, vi } from 'vitest';
import { createClient, ApiError, parseSnapshot } from '../apps/ui/src/api.js';

describe('browser command boundary', () => {
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
