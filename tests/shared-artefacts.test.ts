import { beforeEach, afterEach, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { createCore } from '../packages/core/src/index.js';
import { createStore } from '../packages/store/src/index.js';
import { sharedCommand, sharedProjection } from '../packages/core/src/membership.js';
import type { Actor, Core, Room, HumanMembership, ToolArgs } from '../packages/shared/src/contracts.js';
const a: Actor = { kind: 'human', ownerId: 'owner-a', principalId: 'human-a' };
const b: Actor = { kind: 'human', ownerId: 'owner-b', principalId: 'human-b' };
let core: Core, room: Room, member: HumanMembership;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const call = (name: string, args: ToolArgs, actor = a) => core.dispatch(actor, name, args);
const share = (content = '# Public review', overrides: ToolArgs = {}, actor = b) => call('shared_artefact_publish', {
  roomId: room.id, name: 'review.md', mimeType: 'text/markdown', content, digest: digest(content), clientKey: digest(content), ...overrides,
}, actor);
beforeEach(async () => {
  core = createCore(createStore(':memory:'));
  room = await call('room_create', { title: 'Review', objective: 'Approved immutable content' }) as Room;
  const invite = await call('membership_invite', { roomId: room.id, displayName: 'B', role: 'participant', clientKey: 'invite' }) as { code: string };
  member = await call('membership_redeem', { roomId: room.id, code: invite.code }, b) as HumanMembership;
  await call('membership_confirm', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
});
afterEach(() => core.store.close());
it('shares only an exact human-approved text digest with immutable room provenance', async () => {
  core.store.put('manifest', 'private', { roomId: room.id, content: 'Unapproved local evidence', path: 'C:\\private' });
  const value = await share() as ToolArgs;
  expect(value).toMatchObject({ roomId: room.id, ownerId: b.ownerId, visibility: 'room', bytes: 15, digest: digest('# Public review') });
  expect(JSON.stringify(sharedProjection(core, b, room.id))).not.toContain('Unapproved local evidence');
  expect(JSON.stringify(sharedProjection(core, b, room.id))).not.toContain('# Public review');
  const read = await sharedCommand(core, b, room.id, member.generation, 'shared_artefact_get', { roomId: room.id, artefactId: value.id });
  expect(read).toMatchObject({ content: '# Public review' });
  await expect(share('Tampered', { digest: value.digest })).rejects.toThrow();
  await expect(share('Changed', { artefactId: value.id })).rejects.toThrow();
  expect(core.store.count('shared_artefact')).toBe(1);
});
it('rejects agents, private reasoning, binary, archives, active HTML and path-shaped names', async () => {
  const seat = await call('seat_add', { roomId: room.id, product: 'claude', name: 'B agent' }, b) as { principalId: string };
  await expect(share('Public', {}, { kind: 'agent', principalId: seat.principalId, ownerId: b.ownerId })).rejects.toMatchObject({ code: 'human_required' });
  for (const content of ['<script>alert(1)</script>', '<thinking>Private</thinking>', 'binary\u0000', '\ud800', '[click](javascript:alert(1))'])
    await expect(share(content)).rejects.toMatchObject({ code: 'artefact_content' });
  for (const name of ['../review.md', 'C:\\private.md', 'archive.zip', 'script.exe', 'folder/review.md'])
    await expect(share('Public', { name })).rejects.toMatchObject({ code: 'artefact_name' });
  expect(core.store.count('shared_artefact')).toBe(0);
});
it('enforces byte and room quotas transactionally without partial publication', async () => {
  await expect(share('x'.repeat(1048577))).rejects.toThrow();
  await expect(share('é'.repeat(524289))).rejects.toThrow();
  for (let i = 0; i < 10; i++) await share(String(i).repeat(1048576), { clientKey: 'full-' + i });
  await expect(share('Quota exceeded')).rejects.toThrow();
  expect(core.store.count('shared_artefact')).toBe(10);
});
it('denies other-room and revoked reads including retained artefact identifiers', async () => {
  const value = await share() as ToolArgs, other = await call('room_create', { title: 'Other', objective: 'Private' }) as Room;
  await expect(sharedCommand(core, b, room.id, member.generation, 'shared_artefact_get', { roomId: other.id, artefactId: value.id })).rejects.toThrow();
  await call('membership_revoke', { roomId: room.id, memberId: member.id, expectedGeneration: member.generation });
  await expect(sharedCommand(core, b, room.id, member.generation, 'shared_artefact_get', { roomId: room.id, artefactId: value.id })).rejects.toThrow();
});
it('rejects stored digest tampering instead of serving corrupted approved text', async () => {
  const value = await share() as ToolArgs, stored = core.store.get<ToolArgs>('shared_artefact', String(value.id))!;
  core.store.put('shared_artefact', String(value.id), { ...stored, content: 'Tampered text' });
  await expect(sharedCommand(core, b, room.id, member.generation, 'shared_artefact_get', { artefactId: value.id })).rejects.toMatchObject({ code: 'artefact_integrity' });
});
