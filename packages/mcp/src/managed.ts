import { randomBytes, createHash } from 'node:crypto';
import { mkdir, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { Core, Seat, Turn } from '../../shared/src/contracts.js';

export const MANAGED_TOOLS = new Set([
  'room_get', 'room_read', 'room_wait', 'room_inbox', 'room_post', 'room_usage',
  'task_get', 'task_heartbeat', 'artefact_get', 'permission_request', 'runtime_capabilities',
  'shared_artefact_get', 'shared_artefact_list',
]);
export interface ManagedScope {
  roomId: string;
  seatId: string;
  turnId: string;
  attemptId?: string;
  generation?: number;
  remoteConnectionId?: string;
}
export interface ManagedMcp {
  name: string;
  command: string;
  args: string[];
  env: { name: string; value: string }[];
}
export async function managedBridge(core: Core, dataDir: string, cli: string, seat: Seat,
  turn: Turn, generation?: number): Promise<{ server: ManagedMcp; revoke(): Promise<void> }> {
  const token = randomBytes(32).toString('base64url');
  const key = createHash('sha256').update(token).digest('hex');
  const scope: ManagedScope = { roomId: turn.roomId, seatId: seat.id, turnId: turn.id,
    ...(turn.attemptId ? { attemptId: turn.attemptId, generation } : {}) };
  if (turn.remoteProposalId) {
    const proposal = core.store.get<{ connectionId: string }>('remote_proposal', turn.remoteProposalId);
    if (!proposal) throw new Error('Remote proposal binding missing');
    scope.remoteConnectionId = proposal.connectionId;
  }
  const path = join(dataDir, 'bridges', turn.id + '.json');
  await mkdir(join(dataDir, 'bridges'), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ token, principalId: seat.principalId, scope }), { mode: 0o600, flag: 'wx' });
  core.store.put('bridge', key, { kind: 'agent', principalId: seat.principalId,
    ownerId: seat.ownerId, scope, createdAt: Date.now() });
  return {
    server: { name: 'converoom', command: process.execPath,
      args: [cli, 'mcp', '--client', seat.product, '--data-dir', dataDir, '--credential-file', path], env: [] },
    revoke: async () => {
      core.store.remove('bridge', key);
      await unlink(path).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    },
  };
}
