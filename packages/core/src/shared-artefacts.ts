import { createHash, randomUUID } from 'node:crypto';
import { ConveroomError as E, requiredString as str, type Core, type Actor, type SharedArtefact } from '../../shared/src/contracts.js';
import { redactPublic } from '../../store/src/index.js';
import { requireHumanParticipant } from './membership.js';

export const textDigest = (content: string) => createHash('sha256').update(content).digest('hex');
export const artefactMetadata = (a: SharedArtefact) => ({ id: a.id, roomId: a.roomId, ownerId: a.ownerId, name: a.name,
  mimeType: a.mimeType, digest: a.digest, bytes: a.bytes, visibility: a.visibility, sharedAt: a.sharedAt, provenance: a.provenance });
export function readSharedArtefact(c: Core, actor: Actor, roomId: string, id: string) {
  const room = c.requireRoom(actor, roomId), a = c.store.get<SharedArtefact>('shared_artefact', id);
  if (room.workflow !== 'discussion' || !a || a.roomId !== roomId || a.visibility !== 'room') throw new E('artefact_scope', 'Shared room artefact required', 403);
  if (typeof a.content !== 'string' || a.bytes > 1048576 || Buffer.byteLength(a.content) !== a.bytes || textDigest(a.content) !== a.digest)
    throw new E('artefact_integrity', 'Stored artefact digest or size changed', 409);
  return { ...artefactMetadata(a), content: a.content };
}
export function mountSharedArtefacts(c: Core) {
  c.register('shared_artefact_publish', (actor, x) => {
    const roomId = str(x, 'roomId', 256), room = requireHumanParticipant(c, actor, roomId);
    if (room.workflow !== 'discussion' || room.status !== 'open') throw new E('artefact_scope', 'Open discussion room required', 403);
    if (Object.keys(x).some((key) => !['roomId', 'name', 'mimeType', 'content', 'digest', 'clientKey'].includes(key)))
      throw new E('artefact_argument', 'New immutable artefact fields required');
    const name = str(x, 'name', 256), content = str(x, 'content', 1048576), mimeType = str(x, 'mimeType', 256), digest = str(x, 'digest', 64);
    if (!/^[\p{L}\p{N} _.-]+\.(?:md|txt)$/u.test(name) || name.includes('..')) throw new E('artefact_name', 'A plain text or Markdown name without a path is required');
    if (!['text/plain', 'text/markdown'].includes(mimeType) || Buffer.from(content).toString('utf8') !== content ||
      // eslint-disable-next-line no-control-regex -- Reject binary control bytes in text uploads.
      /[\x00-\x08\x0b\x0c\x0e-\x1f]|<\/?[!a-z][^>]*>|(?:javascript|vbscript|data):/i.test(content) || redactPublic(content) !== content)
      throw new E('artefact_content', 'Only public UTF-8 plain text or Markdown without active content is supported');
    if (!/^[a-f0-9]{64}$/.test(digest) || textDigest(content) !== digest) throw new E('artefact_digest', 'Exact reviewed content digest required');
    const existing = c.store.list<SharedArtefact>('shared_artefact', { roomId }), bytes = Buffer.byteLength(content);
    if (existing.length >= 100 || existing.reduce((sum, item) => sum + item.bytes, 0) + bytes > 10485760)
      throw new E('artefact_capacity', 'Room artefact capacity reached', 429);
    const id = randomUUID(), sharedAt = Date.now(), value: SharedArtefact = { id, roomId, ownerId: actor.ownerId, name, mimeType,
      content, digest, bytes, visibility: 'room', sharedAt, provenance: { ownerId: actor.ownerId, sourceDigest: digest } };
    c.store.put('shared_artefact', id, value);
    c.store.append(roomId, 'artefact.shared', actor.principalId, artefactMetadata(value));
    return artefactMetadata(value);
  });
  c.register('shared_artefact_get', (actor, x) => readSharedArtefact(c, actor, str(x, 'roomId', 256), str(x, 'artefactId', 256)));
  c.register('shared_artefact_list', (actor, x) => {
    const roomId = str(x, 'roomId', 256); c.requireRoom(actor, roomId);
    return c.store.list<SharedArtefact>('shared_artefact', { roomId }).slice(0, 100).map(artefactMetadata);
  });
}
