import { mkdir, mkdtemp, readdir, readFile, stat, link, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createStore, scopeDigest, redactTransport } from '../../../packages/store/src/index.js';
import { ConveroomError, type Event, type ToolArgs } from '../../../packages/shared/src/contracts.js';
interface History {
  schemaVersion: number;
  digest: string;
  records: { kind: string; id: string; value: ToolArgs }[];
  events: Event[];
}
const kinds = new Set(['room', 'seat', 'interaction', 'turn', 'policy', 'permission',
  'manifest', 'verification', 'review', 'candidate', 'task']);
const object = (value: unknown): value is ToolArgs => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;
function validate(value: unknown): History {
  const invalid = () => { throw new ConveroomError('export_invalid', 'Export digest, schema or provenance is invalid'); };
  if (!object(value) || value.schemaVersion !== 2 || !Array.isArray(value.records) ||
    !Array.isArray(value.events) || value.records.length > 10000 || value.events.length > 50000 ||
    scopeDigest({ records: value.records, events: value.events }) !== value.digest) invalid();
  const e = value as unknown as History;
  const recordIds = new Set<string>(), rooms = new Map<string, ToolArgs>();
  for (const r of e.records) {
    if (!object(r) || !kinds.has(r.kind) || !text(r.id) || !object(r.value) ||
      recordIds.has(r.kind + ':' + r.id)) invalid();
    recordIds.add(r.kind + ':' + r.id);
    if (r.kind === 'room') {
      if (r.value.id !== r.id || !text(r.value.ownerId) || !Number.isSafeInteger(r.value.seq) || Number(r.value.seq) < 0) invalid();
      rooms.set(r.id, r.value);
    }
  }
  if (!rooms.size || new Set([...rooms.values()].map((r) => r.ownerId)).size !== 1) invalid();
  for (const r of e.records) if (r.kind !== 'room' && !rooms.has(String(r.value.roomId))) invalid();
  const eventIds = new Set<string>(), cursors = new Map<string, number>();
  for (const event of e.events) {
    if (!object(event) || !text(event.id) || eventIds.has(event.id) || !rooms.has(event.roomId) ||
      !text(event.type) || !text(event.actorId) || !Number.isFinite(event.at) || !object(event.data) ||
      event.seq !== (cursors.get(event.roomId) ?? 0) + 1) invalid();
    eventIds.add(event.id); cursors.set(event.roomId, event.seq);
  }
  for (const [id, room] of rooms) if (room.seq !== (cursors.get(id) ?? 0)) invalid();
  return e;
}
export async function restoreHistory(input: string, dataDir: string): Promise<void> {
  const maximum = 64 * 1024 * 1024;
  if ((await stat(input)).size > maximum) throw new ConveroomError('export_limit', 'Export exceeds the 64 MiB restore limit');
  const content = await readFile(input, 'utf8');
  if (Buffer.byteLength(content) > maximum) throw new ConveroomError('export_limit', 'Export exceeds the 64 MiB restore limit');
  const e = validate(JSON.parse(content));
  const target = resolve(dataDir);
  await mkdir(target, { recursive: true, mode: 0o700 });
  if ((await readdir(target)).length) throw new ConveroomError('restore_target', 'Restore requires an empty data directory');
  const staging = await mkdtemp(join(target, '.restore-'));
  const owned = relative(target, staging);
  if (!owned || owned.startsWith('..') || isAbsolute(owned))
    throw new ConveroomError('restore_path', 'Restore staging path escaped its target');
  try {
    const store = createStore(join(staging, 'converoom.sqlite'));
    try {
      store.transaction(() => {
        for (const r of e.records) {
          const value = { ...redactTransport(r.value) };
          for (const key of ['path', 'dataPath', 'basePath', 'workspace', 'foundationPath']) delete value[key];
          if (r.kind === 'turn') value.status = 'uncertain';
          if (r.kind === 'room') value.status = 'closed';
          if (r.kind === 'seat') { value.consent = false; value.status = 'left'; }
          if (r.kind === 'permission') value.status = 'denied';
          store.put(r.kind, r.id, value);
        }
        store.importEvents(redactTransport(e.events));
        const ownerId = String(e.records.find((r) => r.kind === 'room')!.value.ownerId);
        store.put('identity', 'human', { kind: 'human', principalId: ownerId, ownerId });
      });
    } finally { store.close(); }
    await link(join(staging, 'converoom.sqlite'), join(target, 'converoom.sqlite'));
  } finally {
    await rm(staging, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
