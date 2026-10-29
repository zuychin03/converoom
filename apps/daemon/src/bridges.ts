import { randomBytes, createHash } from 'node:crypto';
import { isProduct } from '../../../packages/shared/src/products.js';
import { ConveroomError, type Actor, type Product, type RemoteConnection, type Runtime, type Store } from '../../../packages/shared/src/contracts.js';
import { installationAuthority } from '../../../packages/core/src/audit.js';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function humanIdentity(runtime: Runtime): Actor {
  return ownerIdentity(runtime.core.store);
}
export function ownerIdentity(store: Store): Actor {
  let actor = store.get<Actor>('identity', 'human');
  if (!actor) {
    const id = crypto.randomUUID();
    actor = { kind: 'human', principalId: id, ownerId: id };
    store.put('identity', 'human', actor);
  }
  return actor;
}
export function revokeBridgeCredential(store: Store, principalId: string): void {
  let revoked = false;
  for (const credential of store.list<Actor>('bridge'))
    if (credential.principalId === principalId) {
      // Hash keys are not exposed by Store.list; credentials are revoked through an indexed principal record.
      store.put('revoked', credential.principalId, true);
      revoked = true;
    }
  if (revoked) installationAuthority(store, ownerIdentity(store), 'bridge.credential_revoked', { principalId });
}
export function issueBridgeCredential(
  runtime: Runtime,
  product: Product,
  remoteConnectionId?: string,
): { token: string; principalId: string; remoteConnectionId?: string } {
  if (!isProduct(product))
    throw new ConveroomError('invalid_product', 'Choose a supported product');
  const token = secret();
  const principalId = crypto.randomUUID();
  if (remoteConnectionId) {
    const c = runtime.core.store.get<RemoteConnection>('remote_connection', remoteConnectionId);
    if (!c || c.localOwnerId !== humanIdentity(runtime).ownerId || c.status !== 'connected' || c.mode !== 'polling' || c.product !== product)
      throw new ConveroomError('remote_registration', 'Own connected polling product required', 403);
  }
  runtime.core.store.put('bridge', hash(token), {
    kind: 'agent',
    principalId,
    ownerId: humanIdentity(runtime).ownerId,
    product,
    ...(remoteConnectionId ? { remoteConnectionId } : {}),
    createdAt: Date.now(),
  });
  return { token, principalId, ...(remoteConnectionId ? { remoteConnectionId } : {}) };
}
