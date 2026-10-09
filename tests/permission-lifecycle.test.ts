import { it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import type { Permission } from '../packages/core/src/index.js';
import type { Actor, ToolArgs, Turn } from '../packages/shared/src/contracts.js';
import { pendingPermissions, agentWaitEnds } from '../apps/ui/src/model.js';
import { parseSnapshot } from '../apps/ui/src/api.js';

const owner: Actor = { kind: 'human', principalId: 'owner', ownerId: 'owner' };
it.each(['timeout', 'cancel', 'grant', 'deny'] as const)(
  'resolves a vendor approval when its native callback ends: %s', async (outcome) => {
    const dir = await mkdtemp(join(tmpdir(), 'converoom-permission-'));
    let now = 1000000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    let approved: boolean | undefined;
    const runtime = await createRuntime(dir, { tickMs: 10, startSession: async (product, _cwd, approve) => ({
      id: 'permission-fixture', product, capabilities: ['prompt', 'cancel'],
      prompt: async () => { approved = await approve({ tool: 'fixture' }); return 'Public reply'; },
      cancel: async () => {}, close: async () => true,
    }) });
    const call = (name: string, args: ToolArgs) => runtime.core.dispatch(owner, name, args) as Promise<ToolArgs>;
    try {
      const room = await call('room_create', { title: 'Permission lifecycle', objective: 'Resolve native approval' });
      const seat = await call('seat_add', { roomId: room.id, product: 'codex', mode: 'managed', name: 'Fixture' });
      await call('seat_consent', { roomId: room.id, seatId: seat.id, consent: true });
      const turn = await call('turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Request a fixture tool' });
      await call('permission_grant', { requestId: turn.permissionRequestId });
      await expect.poll(() => runtime.core.store.list<Permission>('permission').find((p) => p.action === 'vendor_tool')).toBeDefined();
      const request = runtime.core.store.list<Permission>('permission').find((p) => p.action === 'vendor_tool')!;
      expect(request.expiresAt).toBe(now + 120000);
      expect(agentWaitEnds({ ...request })).toBe(request.expiresAt);
      if (outcome === 'timeout') now = request.expiresAt;
      else if (outcome === 'cancel') {
        await call('turn_cancel', { roomId: room.id, turnId: turn.id });
        await expect(call('permission_grant', { requestId: request.id })).rejects.toThrow();
      } else await call(outcome === 'grant' ? 'permission_grant' : 'permission_deny', { requestId: request.id });
      await expect.poll(() => approved).toBe(outcome === 'grant');
      const expected = { timeout: 'expired', cancel: 'cancelled', grant: 'granted', deny: 'denied' }[outcome];
      await expect.poll(() => runtime.core.store.get<Permission>('permission', request.id)?.status).toBe(expected);
      const state = parseSnapshot({ permissions: runtime.core.store.list('permission') });
      expect(pendingPermissions(state, now)).toHaveLength(0);
      await expect(call('permission_grant', { requestId: request.id })).rejects.toThrow();
      if (outcome === 'timeout' || outcome === 'cancel') {
        expect(runtime.core.store.events(String(room.id)).filter((e) => e.type === 'permission.' + expected)).toHaveLength(1);
        expect(runtime.core.store.list<ToolArgs>('grant').some((g) => g.requestId === request.id)).toBe(false);
      }
      await expect.poll(() => runtime.core.store.get<Turn>('turn', String(turn.id))?.status).toBe(
        outcome === 'cancel' ? 'cancelled' : 'completed',
      );
    } finally {
      await runtime.stop(); clock.mockRestore(); await rm(dir, { recursive: true, force: true });
    }
  },
);
