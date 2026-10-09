import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { sharedCommand } from '../packages/core/src/membership.js';
import { createServer, issueBridgeCredential } from '../apps/daemon/src/server.js';
import type { Actor, Runtime, Room, Seat, HumanMembership, RemoteConnection, RemoteProposal, ToolArgs, Turn, Event } from '../packages/shared/src/contracts.js';
const a: Actor = { kind: 'human', principalId: 'human-a', ownerId: 'owner-a' };
const remoteB: Actor = { kind: 'human', principalId: 'remote-human-b', ownerId: 'remote-owner-b' };
const localB: Actor = { kind: 'human', principalId: 'local-human-b', ownerId: 'local-owner-b' };
let host: Runtime, participant: Runtime, dir: string, room: Room, seat: Seat, member: HumanMembership, connection: RemoteConnection;
let started: number, dropClaim: boolean, dropReply: boolean, cancelDuringClaim: boolean, disconnectDuringClaim: boolean;
let stopPromise: Promise<boolean> | undefined, resolveStop: ((value: boolean) => void) | undefined;
let localServer: Awaited<ReturnType<typeof createServer>> | undefined, readThroughMcp: boolean, mcpResult: unknown;
let promptPromise: Promise<string> | undefined, resolvePrompt: ((value: string) => void) | undefined;
let tamperInbox: 'senderOwnerId' | 'maxTurnMs' | undefined;
const call = (runtime: Runtime, name: string, args: ToolArgs, actor = a) => runtime.core.dispatch(actor, name, args);
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'converoom-participant-')); started = 0; dropClaim = false; dropReply = false;
  cancelDuringClaim = false;
  disconnectDuringClaim = false;
  stopPromise = undefined; resolveStop = undefined;
  localServer = undefined; readThroughMcp = false; mcpResult = undefined;
  promptPromise = undefined; resolvePrompt = undefined;
  tamperInbox = undefined;
  host = await createRuntime(join(dir, 'host'), { noScheduler: true });
  room = await call(host, 'room_create', { title: 'Shared review', objective: 'Participant-local authority' }) as Room;
  const invitation = await call(host, 'membership_invite', { roomId: room.id, displayName: 'B', role: 'participant', clientKey: 'invite' }) as { code: string };
  member = await call(host, 'membership_redeem', { roomId: room.id, code: invitation.code }, remoteB) as HumanMembership;
  await call(host, 'membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  seat = await call(host, 'seat_add', { roomId: room.id, product: 'codex', name: 'B remote agent' }, remoteB) as Seat;
  await call(host, 'owner_consent_update', { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [a.ownerId], maxTurns: 3, maxTurnMs: 60000 }, remoteB);
  participant = await createRuntime(join(dir, 'participant'), { tickMs: 10, remoteTickMs: 0,
    remoteTransport: async (c) => {
      const bound = host.core.store.list<Seat>('seat', { roomId: room.id }).find((s) => s.product === c.product)!;
      return {
      identity: async () => ({ actor: { kind: 'agent', principalId: bound.principalId, ownerId: bound.ownerId, seatId: bound.id }, roomId: room.id, generation: member.generation }),
      command: async (name, args) => {
        const result = await sharedCommand(host.core, { kind: 'agent', principalId: bound.principalId, ownerId: bound.ownerId }, room.id,
          member.generation, name, args);
        if (name === 'turn_claim' && cancelDuringClaim) {
          const turn = participant.core.store.list<Turn>('turn')[0];
          await call(participant, 'turn_cancel', { roomId: turn.roomId, turnId: turn.id }, localB);
        }
        if (name === 'turn_claim' && disconnectDuringClaim)
          await call(participant, 'remote_connection_disconnect', { connectionId: connection.id }, localB);
        if ((name === 'turn_claim' && dropClaim) || (name === 'turn_complete' && dropReply)) throw new Error('Fixture response lost after commit');
        if (name === 'room_inbox' && tamperInbox) {
          const inbox = result as { turns: Turn[] };
          return { ...inbox, turns: inbox.turns.map((t) => ({ ...t, [tamperInbox!]: tamperInbox === 'senderOwnerId' ? 'forged-owner' : 1000 })) };
        }
        return result;
      }, close: async () => {},
    }; }, startSession: async (product, _cwd, _permission, _env, _readOnly, mcp) => {
      if (readThroughMcp) {
        const credential = JSON.parse(await readFile(mcp!.args[mcp!.args.indexOf('--credential-file') + 1], 'utf8'));
        const response = await fetch(localServer!.url + '/agent/commands', { method: 'POST', headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'room_read', args: { roomId: connection.localRoomId, cursor: 0, limit: 20 } }) });
        expect(response.status).toBe(200); mcpResult = await response.json();
      }
      started++; return { id: 'participant-fixture', product, capabilities: ['prompt', 'cancel'], prompt: async () => promptPromise ?? '<thinking>Private reasoning</thinking>Public B answer',
        cancel: async () => {}, close: async () => stopPromise ?? true };
    } });
  participant.core.store.put('identity', 'human', localB);
  connection = await call(participant, 'remote_connection_attach', { origin: 'https://room.example.ts.net', remoteRoomId: room.id,
    remoteOwnerId: seat.ownerId, generation: member.generation, remoteSeatId: seat.id, clientId: 'participant-bridge', accessToken: 'fixture-agent-token',
    product: 'codex', mode: 'managed', maxTurns: 2, maxTurnMs: 60000 }, localB) as RemoteConnection;
});
afterEach(async () => { resolvePrompt?.('Fixture stopped'); resolveStop?.(true); await localServer?.close(); await participant?.stop(); await host?.stop(); if (dir) await rm(dir, { recursive: true, force: true }); });
async function proposal() {
  await call(host, 'turn_request', { roomId: room.id, seatId: seat.id, prompt: 'Public review' });
  await call(participant, 'remote_refresh', { connectionId: connection.id }, localB);
  return participant.core.store.list<RemoteProposal>('remote_proposal')[0];
}
it.each(['senderOwnerId', 'maxTurnMs'] as const)('refuses admission if the accepted %s changes', async (field) => {
  const pending = await proposal();
  const accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  const remoteTurn = host.core.store.get<Turn>('turn', pending.remoteTurnId)!;
  tamperInbox = field;
  const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  await call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, localB);
  await expect.poll(() => participant.core.store.get<RemoteProposal>('remote_proposal', pending.id)?.status).toBe('uncertain');
  expect(started).toBe(0); expect(host.core.store.get<Turn>('turn', remoteTurn.id)?.status).toBe('queued');
});
it('visibly invalidates pending authorisation after restart instead of offering a dead callback', async () => {
  const id = crypto.randomUUID();
  participant.core.store.put('remote_connection', id, { ...connection, id, status: 'authorizing' });
  await participant.stop();
  participant = await createRuntime(join(dir, 'participant'), { noScheduler: true });
  expect(participant.core.store.get<RemoteConnection>('remote_connection', id)?.status).toBe('uncertain');
});
it('never starts inference from a remote proposal or a forged room-owner approval', async () => {
  const pending = await proposal(); expect(pending.status).toBe('pending'); expect(started).toBe(0);
  await expect(call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, a)).rejects.toThrow();
  await expect(call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, { kind: 'agent', ownerId: localB.ownerId, principalId: 'forged-agent' })).rejects.toThrow();
  expect(started).toBe(0);
});
it('requires an independent local grant, runs once and returns only the public answer', async () => {
  const pending = await proposal();
  const accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  expect(started).toBe(0); const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  await expect(call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, a)).rejects.toThrow();
  await call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, localB);
  await expect.poll(() => participant.core.store.get<Turn>('turn', turn.id)?.status).toBe('completed');
  await expect.poll(() => participant.core.store.get<{ status: string }>('seat', connection.localSeatId!)?.status).toBe('idle');
  await call(participant, 'remote_refresh', { connectionId: connection.id }, localB);
  expect(host.core.store.get<Turn>('turn', pending.remoteTurnId)?.status).toBe('completed');
  expect(started).toBe(1); expect(JSON.stringify(host.core.store.events(room.id))).toContain('Public B answer');
  expect(JSON.stringify(host.core.store.events(room.id))).not.toContain('Private reasoning');
});
it('does not launch or replay after an ambiguous claim acknowledgement', async () => {
  const pending = await proposal(); dropClaim = true;
  const accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  await call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, localB);
  await expect.poll(() => participant.core.store.get<RemoteProposal>('remote_proposal', pending.id)?.status).toBe('uncertain');
  expect(started).toBe(0); expect(host.core.store.get<Turn>('turn', pending.remoteTurnId)?.status).toBe('running');
  await call(participant, 'remote_refresh', { connectionId: connection.id }, localB); expect(started).toBe(0);
});
it('fences local approval if membership was removed before native admission', async () => {
  const pending = await proposal();
  const accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  await call(host, 'membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  await call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, localB);
  await expect.poll(() => participant.core.store.get<Turn>('turn', turn.id)?.status).not.toBe('queued');
  await expect.poll(() => participant.core.store.get<RemoteProposal>('remote_proposal', pending.id)?.status).toBe('uncertain');
  expect(started).toBe(0);
});
it('retains an uncertain publication instead of sending the same consequential reply twice', async () => {
  const pending = await proposal(), accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  await call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, localB);
  await expect.poll(() => participant.core.store.get<Turn>('turn', turn.id)?.status).toBe('completed');
  await expect.poll(() => participant.core.store.get<{ status: string }>('seat', connection.localSeatId!)?.status).toBe('idle'); dropReply = true;
  await call(participant, 'remote_refresh', { connectionId: connection.id }, localB);
  expect(participant.core.store.get<RemoteProposal>('remote_proposal', pending.id)?.status).toBe('uncertain');
  await call(participant, 'remote_refresh', { connectionId: connection.id }, localB);
  expect(host.core.store.eventCount(room.id, 'message')).toBe(1); expect(started).toBe(1);
});
it('admits at most one local acceptance when two approval requests race', async () => {
  const pending = await proposal(), args = { proposalId: pending.id, digest: pending.digest };
  const results = await Promise.allSettled([call(participant, 'remote_turn_accept', args, localB), call(participant, 'remote_turn_accept', args, localB)]);
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  expect(participant.core.store.count('turn', { roomId: connection.localRoomId })).toBe(1);
});
it('retains stop uncertainty instead of reporting a completed native worker remotely', async () => {
  stopPromise = new Promise<boolean>((resolve) => { resolveStop = resolve; });
  const pending = await proposal(), accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  await call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, localB);
  await expect.poll(() => participant.core.store.get<Turn>('turn', turn.id)?.status).toBe('completed');
  await call(participant, 'remote_refresh', { connectionId: connection.id }, localB);
  expect(host.core.store.get<Turn>('turn', pending.remoteTurnId)?.status).toBe('running');
  expect(host.core.store.eventCount(room.id, 'message')).toBe(0);
  resolveStop!(false);
  await expect.poll(() => participant.core.store.get<Turn>('turn', turn.id)?.status).toBe('uncertain');
  await call(participant, 'remote_refresh', { connectionId: connection.id }, localB);
  expect(participant.core.store.get<RemoteProposal>('remote_proposal', pending.id)?.status).toBe('uncertain');
});
it('routes the managed agent’s scoped Converoom tools to public shared context', async () => {
  localServer = await createServer(participant, { port: 0, pairingCode: 'fixture-human-pair' }); readThroughMcp = true;
  await call(host, 'room_post', { roomId: room.id, text: 'Live public shared context' });
  const pending = await proposal(), accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  await call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, localB);
  await expect.poll(() => participant.core.store.get<Turn>('turn', turn.id)?.status).toBe('completed');
  expect((mcpResult as { result: { events: Event[] } }).result.events).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'message', data: expect.objectContaining({ text: 'Live public shared context' }) }),
  ]));
});
it('never starts a native process after local cancellation during remote admission', async () => {
  const pending = await proposal(), accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  cancelDuringClaim = true;
  const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  await call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, localB);
  await expect.poll(() => participant.core.store.get<Turn>('turn', turn.id)?.status).toBe('cancelled');
  expect(started).toBe(0);
});
it('declines a proposal locally without granting or starting inference', async () => {
  const pending = await proposal();
  await expect(call(participant, 'remote_turn_decline', { proposalId: pending.id, digest: pending.digest }, a)).rejects.toThrow();
  await call(participant, 'remote_turn_decline', { proposalId: pending.id, digest: pending.digest }, localB);
  expect(participant.core.store.get<RemoteProposal>('remote_proposal', pending.id)?.status).toBe('declined');
  expect(host.core.store.get<Turn>('turn', pending.remoteTurnId)?.status).toBe('cancelled');
  expect(started).toBe(0);
});
it('disconnects locally, fences proposals and rejects later acceptance', async () => {
  const pending = await proposal();
  await call(participant, 'remote_connection_disconnect', { connectionId: connection.id }, localB);
  expect(participant.core.store.get<RemoteConnection>('remote_connection', connection.id)?.status).toBe('revoked');
  await expect(call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB)).rejects.toThrow();
  expect(started).toBe(0);
});
it('retains connection metadata and cursors but fences accepted work across restart', async () => {
  const pending = await proposal();
  await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB);
  const before = participant.core.store.get<RemoteConnection>('remote_connection', connection.id)!;
  await participant.stop();
  participant = await createRuntime(join(dir, 'participant'), { noScheduler: true });
  expect(participant.core.store.get<RemoteConnection>('remote_connection', connection.id)?.cursor).toBe(before.cursor);
  expect(participant.core.store.get<RemoteProposal>('remote_proposal', pending.id)?.status).toBe('uncertain');
  expect(started).toBe(0);
});
it('routes a polling bridge to its one room and rejects local coding or approval commands', async () => {
  const polling = await call(participant, 'remote_connection_attach', { origin: connection.origin, remoteRoomId: room.id,
    clientId: 'participant-bridge', accessToken: 'fixture', product: 'codex', mode: 'polling', maxTurns: 2, maxTurnMs: 60000 }, localB) as RemoteConnection;
  localServer = await createServer(participant, { port: 0 });
  const credential = issueBridgeCredential(participant, 'codex', polling.id);
  const dispatch = (name: string, args: ToolArgs) => fetch(localServer!.url + '/agent/commands', { method: 'POST',
    headers: { authorization: 'Bearer ' + credential.token, 'content-type': 'application/json' }, body: JSON.stringify({ name, args }) });
  expect((await dispatch('room_post', { roomId: room.id, text: 'Remote polling position', clientKey: 'position' })).status).toBe(200);
  expect(JSON.stringify(host.core.store.events(room.id))).toContain('Remote polling position');
  for (const name of ['room_create', 'permission_request', 'profile_register', 'remote_turn_accept'])
    expect((await dispatch(name, { roomId: room.id })).status).toBe(403);
  await call(participant, 'remote_connection_disconnect', { connectionId: polling.id }, localB);
  expect((await dispatch('room_read', { roomId: room.id })).status).not.toBe(200);
});
it('requires local approval to enable a bounded native profile on a polling connection', async () => {
  const polling = await call(participant, 'remote_connection_attach', { origin: connection.origin, remoteRoomId: room.id,
    clientId: 'participant-bridge', accessToken: 'fixture', product: 'codex', mode: 'polling', maxTurns: 2, maxTurnMs: 60000 }, localB) as RemoteConnection;
  await expect(call(participant, 'remote_connection_enable', { connectionId: polling.id, maxTurns: 2, maxTurnMs: 60000 }, a)).rejects.toThrow();
  expect(await call(participant, 'remote_connection_enable', { connectionId: polling.id, maxTurns: 2, maxTurnMs: 60000 }, localB)).toMatchObject({ mode: 'managed' });
  expect(started).toBe(0);
});
it('cancels locally running inference when current shared authority can no longer be verified', async () => {
  promptPromise = new Promise<string>((resolve) => { resolvePrompt = resolve; });
  const pending = await proposal(), accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  await call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, localB);
  await expect.poll(() => participant.core.store.get<Turn>('turn', turn.id)?.status).toBe('running');
  await call(host, 'membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  await call(participant, 'remote_refresh', { connectionId: connection.id }, localB);
  expect(participant.core.store.get<Turn>('turn', turn.id)?.status).toBe('cancelling');
  resolvePrompt!('Late answer');
  await expect.poll(() => participant.core.store.get<Turn>('turn', turn.id)?.status).toBe('cancelled');
  expect(host.core.store.eventCount(room.id, 'message')).toBe(0);
});
it('binds the local grant and native wall time to the smaller remote owner budget', async () => {
  await call(host, 'owner_consent_update', { roomId: room.id, seatId: seat.id, allowedSenderOwnerIds: [a.ownerId], maxTurns: 3, maxTurnMs: 1000 }, remoteB);
  const pending = await proposal(), accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  expect(turn.maxTurnMs).toBe(1000);
});
it('keeps remote polling stdio usable for all four product identities without local authority', async () => {
  localServer = await createServer(participant, { port: 0 });
  const participantDir = join(dir, 'participant');
  await writeFile(join(participantDir, 'runtime.json'), JSON.stringify({ url: localServer.url }));
  await mkdir(join(participantDir, 'clients'));
  for (const product of ['codex', 'cursor', 'claude', 'opencode'] as const) {
    if (product !== 'codex') await call(host, 'seat_add', { roomId: room.id, product, name: product }, remoteB);
    const c = await call(participant, 'remote_connection_attach', { origin: connection.origin, remoteRoomId: room.id,
      clientId: 'participant-bridge', accessToken: 'fixture', product, mode: 'polling', maxTurns: 2, maxTurnMs: 60000 }, localB) as RemoteConnection;
    await writeFile(join(participantDir, 'clients', product + '.json'), JSON.stringify(issueBridgeCredential(participant, product, c.id)));
    const sdk = new Client({ name: 'remote-fixture-' + product, version: '1' });
    try {
      await sdk.connect(new StdioClientTransport({ command: process.execPath, args: [join(process.cwd(), 'dist', 'cli.js'), 'mcp', '--client', product, '--data-dir', participantDir], stderr: 'pipe' }));
      expect((await sdk.listTools()).tools.some((t) => ['room_create', 'permission_request', 'profile_register'].includes(t.name))).toBe(false);
      const posted = await sdk.callTool({ name: 'room_post', arguments: { roomId: room.id, text: product + ' scoped bridge position', clientKey: product } });
      expect(posted.isError).not.toBe(true);
      expect(posted.structuredContent).toMatchObject({ committed: true, retrySafe: true });
      const read = await sdk.callTool({ name: 'room_read', arguments: { roomId: room.id } });
      expect(JSON.stringify(read)).toContain(product + ' scoped bridge position');
      expect((await sdk.listResources()).resources.some((r) => r.uri.endsWith('/state'))).toBe(true);
      expect(JSON.stringify(await sdk.readResource({ uri: 'converoom://rooms/' + room.id + '/events' }))).toContain(product + ' scoped bridge position');
    } finally { await sdk.close(); }
  }
  expect(started).toBe(0);
}, 30000);
it('fences an acknowledged remote claim if the local connection ends while awaiting it', async () => {
  const pending = await proposal(), accepted = await call(participant, 'remote_turn_accept', { proposalId: pending.id, digest: pending.digest }, localB) as ToolArgs;
  disconnectDuringClaim = true;
  const turn = participant.core.store.get<Turn>('turn', String(accepted.localTurnId))!;
  await call(participant, 'permission_grant', { requestId: turn.permissionRequestId }, localB);
  await expect.poll(() => participant.core.store.get<Turn>('turn', turn.id)?.status).not.toBe('queued');
  await expect.poll(() => participant.core.store.get<{ status: string }>('seat', connection.localSeatId!)?.status).toBe('idle');
  expect(started).toBe(0);
  expect(participant.core.store.get<RemoteProposal>('remote_proposal', pending.id)?.status).toBe('uncertain');
});
