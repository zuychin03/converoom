import { randomUUID } from 'node:crypto';
import { scopeDigest } from '../../store/src/index.js';
import type { Actor, Room, Store, ToolArgs } from '../../shared/src/contracts.js';

// NFR-09: an authority change records its actor, a digest of exactly what changed, its scope and expiry, and the policy in force.
export const authority = (store: Store, a: Pick<Actor, 'principalId'>, r: Room, type: string, data: ToolArgs) =>
  store.append(r.id, type, a.principalId, { ...data, actionDigest: scopeDigest(data), policyVersion: r.policyVersion });

// Changes outside any room, such as local bridge credentials, become append-only records; no command updates or removes them.
export function installationAuthority(store: Store, a: Actor, type: string, data: ToolArgs) {
  const id = randomUUID();
  store.put('authority_audit', id, { id, type, actorId: a.principalId, at: Date.now(), data: { ...data, actionDigest: scopeDigest(data) } });
}
