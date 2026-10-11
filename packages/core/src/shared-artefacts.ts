import { createHash, randomUUID } from 'node:crypto';
import { ConveroomError as E, requiredString as str, type Core, type Actor, type SharedArtefact } from '../../shared/src/contracts.js';
import { redactPublic } from '../../store/src/index.js';
import { requireHumanParticipant } from './membership.js';

export const textDigest = (content: string) => createHash('sha256').update(content).digest('hex');
// Markdown renderers may pass raw HTML through and decode character references in link targets.
const ACTIVE_TAGS = new Set(['script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'svg', 'math', 'link', 'meta',
  'base', 'form', 'input', 'button', 'textarea', 'select', 'template', 'noscript', 'xmp', 'plaintext', 'listing', 'portal']);
const SCRIPT_URL = /(?:(?:\]\(|\]:|=)\s*(?:["'<]\s*)?|<)(?:j\s*a\s*v\s*a\s*s\s*c\s*r\s*i\s*p\s*t|v\s*b\s*s\s*c\s*r\s*i\s*p\s*t|d\s*a\s*t\s*a)\s*:/i;
const codePoint = (n: number) => n <= 0x10ffff ? String.fromCodePoint(n) : '';
const decodeReferences = (text: string) => text.replace(/&#x0*([0-9a-f]{1,6});?/gi, (_, hex: string) => codePoint(parseInt(hex, 16)))
  .replace(/&#0*(\d{1,7});?/g, (_, dec: string) => codePoint(Number(dec)))
  .replace(/&(colon|tab|newline);/gi, (_, name: string) => ({ colon: ':', tab: '\t', newline: '\n' })[name.toLowerCase()]!);
function activeContent(content: string) {
  for (const [, name, rest] of content.matchAll(/<\/?([a-z][a-z0-9-]*)([^<>]*>?)/gi))
    if (ACTIVE_TAGS.has(name.toLowerCase()) || /[\s/](?:on[a-z]+|style)\s*=(?!>)/i.test(rest)) return true;
  return SCRIPT_URL.test(decodeReferences(content));
}
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
      /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(content) || activeContent(content))
      throw new E('artefact_content', 'Only UTF-8 text or Markdown without scripts, frames, forms, event or style attributes or script links is supported');
    if (redactPublic(content) !== content)
      throw new E('artefact_content', 'Remove credentials and private reasoning before sharing');
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
