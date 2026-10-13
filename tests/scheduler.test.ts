import { it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { ConveroomError, type Actor, type ToolArgs, type Turn } from '../packages/shared/src/contracts.js';
const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
it('dispatches retained approved work once after resume and never while paused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-pause-'));
  let started = 0;
  const runtime = await createRuntime(dir, { tickMs: 10, startSession: async (product) => {
    started++;
    return { id: 'pause-fixture', product, capabilities: ['prompt', 'cancel'],
      prompt: async () => 'Public retained reply', cancel: async () => {}, close: async () => true };
  } });
  const call = (name: string, args: ToolArgs) => runtime.core.dispatch(owner, name, args) as Promise<ToolArgs>;
  try {
    const room = await call('room_create', { title: 'Pause recovery', objective: 'Retain queued work' });
    const seat = await call('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Worker' });
    await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
    const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Retained work' });
    await call('room_pause', { roomId: room.id });
    await call('permission_grant', { requestId: turn.permissionRequestId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started).toBe(0);
    expect(runtime.core.store.get<Turn>('turn', String(turn.id))?.status).toBe('queued');
    await call('room_resume', { roomId: room.id });
    await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status).toBe('completed');
    await call('room_pause', { roomId: room.id });
    await call('room_resume', { roomId: room.id });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started).toBe(1);
    expect(runtime.core.store.events(String(room.id)).filter((event) => event.type === 'turn.started')).toHaveLength(1);
  } finally { await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
});
it('dispatches approved managed work once abandoned polling claims expire', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-polling-capacity-'));
  let started = 0, offset = 0;
  const clock = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => clock() + offset);
  const runtime = await createRuntime(dir, { tickMs: 10, startSession: async (product) => {
    started++;
    return { id: 'capacity-fixture', product, capabilities: ['prompt', 'cancel'],
      prompt: async () => 'Public reply after capacity returned', cancel: async () => {}, close: async () => true };
  } });
  const call = (name: string, args: ToolArgs, actor = owner) => runtime.core.dispatch(actor, name, args) as Promise<ToolArgs>;
  try {
    const room = await call('room_create', { title: 'Capacity', objective: 'Abandoned polling claims' });
    for (const name of ['First', 'Second']) {
      const seat = await call('seat_add', { roomId: room.id, product: 'claude', mode: 'polling', name });
      const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Manual work' });
      await call('turn_claim', { roomId: room.id, turnId: turn.id }, { kind: 'agent', principalId: String(seat.principalId), ownerId: String(seat.ownerId) });
    }
    const worker = await call('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Worker' });
    await call('seat_consent', { roomId: room.id, seatId: worker.id, consent: true });
    const managed = await call('turn_request', { roomId: room.id, seatId: worker.id, prompt: 'Managed work' });
    await call('permission_grant', { requestId: managed.permissionRequestId });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started).toBe(0);
    offset = 600000;
    await expect.poll(() => runtime.core.store.get<Turn>('turn', String(managed.id))?.status).toBe('completed');
    expect(started).toBe(1);
    expect(runtime.core.store.list<Turn>('turn', { roomId: String(room.id), status: ['uncertain'] })).toHaveLength(2);
  } finally { vi.restoreAllMocks(); await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
});
async function budgetRoom(maxMessages: number, prompt: () => Promise<string>, cancel = async () => {}, close = async () => true) {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-budget-'));
  let started = 0;
  const runtime = await createRuntime(dir, { tickMs: 10, startSession: async (product) => {
    started++;
    return { id: 'budget-fixture', product, capabilities: ['prompt', 'cancel'], prompt, cancel, close };
  } });
  const call = (name: string, args: ToolArgs) => runtime.core.dispatch(owner, name, args) as Promise<ToolArgs>;
  const room = await call('room_create', { title: 'Budget', objective: 'Bounded discussion' });
  await call('policy_update', { roomId: room.id, policy: { maxMessages } });
  const seat = await call('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Worker' });
  await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
  const request = async () => {
    const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Answer carefully' });
    await call('permission_grant', { requestId: turn.permissionRequestId });
    return String(turn.id);
  };
  const turn = (id: string) => runtime.core.store.get<Turn & { failure?: string; retainedAnswer?: ToolArgs }>('turn', id)!;
  return { runtime, call, room, request, turn, started: () => started, close: async () => { await runtime.stop(); await rm(dir, { recursive: true, force: true }); } };
}
it('retains a finished managed answer that the exhausted room budget no longer lets it publish', async () => {
  let release!: (text: string) => void, running!: () => void;
  const prompting = new Promise<void>((resolve) => { running = resolve; });
  const fixture = await budgetRoom(1, () => { running(); return new Promise<string>((resolve) => { release = resolve; }); });
  try {
    const id = await fixture.request();
    await prompting;
    await fixture.call('room_post', { roomId: fixture.room.id, text: 'The last allowed message' });
    release('<thinking>private plan</thinking>Expensive public answer');
    await expect.poll(() => fixture.turn(id).status).toBe('failed');
    expect(fixture.turn(id)).toMatchObject({ failure: 'budget', retainedAnswer: { truncated: false } });
    expect(String(fixture.turn(id).retainedAnswer?.text)).toContain('Expensive public answer');
    expect(String(fixture.turn(id).retainedAnswer?.text)).not.toContain('private plan');
    const events = fixture.runtime.core.store.events(String(fixture.room.id));
    expect(JSON.stringify(events)).not.toContain('Expensive public answer');
    expect(events.some((e) => e.type === 'turn.failed' && e.data.answerRetained === true)).toBe(true);
  } finally { await fixture.close(); }
});
it('keeps a bounded UTF-8 copy of an answer too large for a room message', async () => {
  const fixture = await budgetRoom(5, async () => '€'.repeat(400000));
  try {
    const id = await fixture.request();
    await expect.poll(() => fixture.turn(id).status).toBe('failed');
    const retained = fixture.turn(id).retainedAnswer!;
    expect(retained).toMatchObject({ bytes: 1200000, truncated: true });
    expect(retained.text).toBe('€'.repeat(349525));
    expect(fixture.runtime.core.store.eventCount(String(fixture.room.id), 'message')).toBe(0);
  } finally { await fixture.close(); }
});
it.each([
  ['a disconnect after the prompt was sent', 'uncertain', () => Promise.reject(new ConveroomError('vendor_disconnected', 'Native process disconnected'))],
  ['a vendor refusal that proves the prompt never started', 'failed',
    () => Promise.reject(Object.assign(new ConveroomError('vendor_error', 'Vendor request failed: Quota exhausted'), { notStarted: true }))],
  ['the vendor reporting the turn as finished but failed', 'failed', () => Promise.reject(new ConveroomError('vendor_turn_failed', 'Vendor turn failed'))],
])('records %s as %s', async (_label, status, prompt) => {
  const fixture = await budgetRoom(5, prompt);
  try {
    const id = await fixture.request();
    await expect.poll(() => fixture.turn(id).status).toBe(status);
    expect(fixture.runtime.core.store.events(String(fixture.room.id)).some((e) => e.type === 'turn.' + status && e.data.turnId === id)).toBe(true);
  } finally { await fixture.close(); }
});
it('records a managed turn that outlives its wall time as uncertain', async () => {
  const fixture = await budgetRoom(5, () => new Promise<string>(() => {}));
  try {
    await fixture.call('policy_update', { roomId: fixture.room.id, policy: { maxTurnMs: 1000 } });
    const id = await fixture.request();
    await expect.poll(() => fixture.turn(id).status, { timeout: 5000 }).toBe('uncertain');
    expect(fixture.turn(id)).toMatchObject({ failure: 'turn_timeout' });
  } finally { await fixture.close(); }
});
it.each([
  ['unconfirmed', 'uncertain', new ConveroomError('vendor_disconnected', 'Native process disconnected')],
  ['confirmed', 'cancelled', new ConveroomError('cancelled', 'Vendor confirmed cancellation')],
])('records a cancellation the vendor left %s as %s', async (_label, status, error) => {
  let fail!: (e: Error) => void, running!: () => void;
  const prompting = new Promise<void>((resolve) => { running = resolve; });
  const fixture = await budgetRoom(5, () => new Promise<string>((_, reject) => { fail = reject; running(); }), async () => fail(error));
  try {
    const id = await fixture.request();
    await prompting;
    await fixture.call('turn_cancel', { roomId: fixture.room.id, turnId: id });
    await expect.poll(() => fixture.turn(id).status).toBe(status);
  } finally { await fixture.close(); }
});
it.each([[true, 'completed'], [false, 'uncertain']] as const)('records whether the native session stop was confirmed (%s)', async (confirmed, status) => {
  const fixture = await budgetRoom(5, async () => 'Checked answer', async () => {},
    () => new Promise<boolean>((resolve) => setTimeout(() => resolve(confirmed), 200)));
  try {
    const id = await fixture.request();
    await expect.poll(() => fixture.turn(id).status).toBe(status);
    await expect.poll(() => fixture.runtime.core.store.get<{ status: string }>('seat', fixture.turn(id).seatId)?.status).toBe(confirmed ? 'idle' : 'degraded');
    const turn = fixture.turn(id) as Turn & { dispatchBoundaryAt?: number; sessionId?: string; sessionStoppedAt?: number };
    expect(turn).toMatchObject({ sessionId: 'budget-fixture', dispatchBoundaryAt: expect.any(Number) });
    expect(turn.sessionStoppedAt === undefined).toBe(!confirmed);
  } finally { await fixture.close(); }
});
it('does not start approved managed work once the room message budget is exhausted', async () => {
  const fixture = await budgetRoom(1, async () => 'Unpostable answer');
  try {
    await fixture.call('room_post', { roomId: fixture.room.id, text: 'The last allowed message' });
    const id = await fixture.request();
    await expect.poll(() => fixture.turn(id).status).toBe('cancelled');
    expect(fixture.turn(id).error).toMatch(/message budget/i);
    expect(fixture.started()).toBe(0);
  } finally { await fixture.close(); }
});
it('requires human grants, limits busy seats, records public replies and recovers without replay', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-scheduler-'));
  let started = 0,
    busy = 0,
    max = 0;
  const runtime = await createRuntime(dir, {
    tickMs: 20,
    startSession: async (product) => ({
      id: 'fixture-session-' + started++,
      product,
      capabilities: ['prompt', 'cancel'],
      prompt: async () => {
        busy++;
        max = Math.max(max, busy);
        await new Promise((r) => setTimeout(r, 100));
        busy--;
        return '<thinking>private analysis</thinking>Public reply';
      },
      cancel: async () => {},
      close: async () => true,
    }),
  });
  const call = (name: string, args: ToolArgs = {}) =>
    runtime.core.dispatch(owner, name, {
      ...args,
      clientKey: crypto.randomUUID(),
    }) as Promise<ToolArgs>;
  try {
    const room = await call('room_create', { title: 'Room', objective: 'Fixture debate' });
    const seat = await call('seat_add', {
      roomId: room.id,
      product: 'codex',
      mode: 'managed',
      name: 'Worker',
    });
    await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
    await call('policy_update', { roomId: room.id, policy: { cooldownMs: 1 } });
    const first = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'First' });
    await new Promise((r) => setTimeout(r, 100));
    expect(started).toBe(0);
    const second = await call('turn_request', {
      roomId: room.id,
      seatId: seat.id,
      prompt: 'Second',
    });
    await call('permission_grant', { requestId: first.permissionRequestId });
    await call('permission_grant', { requestId: second.permissionRequestId });
    for (let i = 0; i < 100; i++) {
      if (runtime.core.store.get<Turn>('turn', String(second.id))?.status === 'completed') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(runtime.core.store.get<Turn>('turn', String(second.id))?.status).toBe('completed');
    expect(max).toBe(1);
    expect(started).toBe(2);
    expect(JSON.stringify(runtime.core.store.events(String(room.id)))).not.toContain(
      'private analysis',
    );
    await runtime.stop();
    const recovered = await createRuntime(dir, { noScheduler: true });
    expect(recovered.core.store.list<Turn>('turn').every((t) => t.status === 'completed')).toBe(
      true,
    );
    await recovered.stop();
  } finally {
    await runtime.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
it('expires stored mutation results hourly while the daemon keeps running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-result-expiry-'));
  let offset = 0;
  const clock = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => clock() + offset);
  const runtime = await createRuntime(dir, { tickMs: 10 });
  const create = () => runtime.core.dispatch(owner, 'room_create', { title: 'Retry', objective: 'Expire stored results', clientKey: 'create-key' }) as Promise<ToolArgs>;
  try {
    const first = await create();
    offset = 3600000;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await create()).id).toBe(first.id);
    offset += 7 * 86400000;
    await expect.poll(async () => (await create()).id).not.toBe(first.id);
  } finally { vi.restoreAllMocks(); await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
});
it('expires finished workspace journal entries hourly while the daemon keeps running', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'converoom-journal-expiry-'));
  let offset = 0;
  const clock = Date.now.bind(Date);
  vi.spyOn(Date, 'now').mockImplementation(() => clock() + offset);
  const runtime = await createRuntime(dir, { tickMs: 10 });
  const register = () => runtime.core.dispatch(owner, 'repo_register', { path: dir, clientKey: 'register-key' })
    .then(() => 'registered', (error: Error) => error.message);
  try {
    expect(await register()).toMatch(/repository root/i);
    expect(await register()).toMatch(/inspect before retry/i);
    offset = 7 * 86400000 + 3600000;
    await expect.poll(register).toMatch(/repository root/i);
  } finally { vi.restoreAllMocks(); await runtime.stop(); await rm(dir, { recursive: true, force: true }); }
});
