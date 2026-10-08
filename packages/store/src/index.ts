import Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ConveroomError,
  type Event,
  type Store,
  type ToolArgs,
} from '../../shared/src/contracts.js';

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const result = JSON.stringify(value);
    if (result === undefined) throw new ConveroomError('invalid_payload', 'Payload must be JSON');
    return result;
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((k) => (value as ToolArgs)[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as ToolArgs)[k])}`)
    .join(',')}}`;
}
export function scopeDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function redactPublic<T>(value: T): T {
  function redact(item: unknown): unknown {
    if (typeof item === 'string')
      return item
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '[private reasoning removed]')
        .replace(new RegExp('\\b(Bearer\\s+)[A-Za-z0-9._~+/-]+=*', 'gi'), '$1[REDACTED]')
        .replace(
          /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g,
          '[REDACTED]',
        )
        .replace(
          /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[:=]\s*)[^\s,;]+/gi,
          '$1[REDACTED]',
        );
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === 'object')
      return Object.fromEntries(
        Object.entries(item).map(([key, val]) => [
          key,
          /(?:token|password|secret|authorization|credential|api.?key|private.?reasoning|chain.?of.?thought|thinking)/i.test(
            key,
          )
            ? '[REDACTED]'
            : redact(val),
        ]),
      );
    return item;
  }
  return redact(value) as T;
}

export function createStore(path: string): Store {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    const version = (
      db.prepare('SELECT sqlite_version() AS version').get() as { version: string }
    ).version
      .split('.')
      .map(Number);
    if (
      version[0] < 3 ||
      (version[0] === 3 && (version[1] < 51 || (version[1] === 51 && version[2] < 3)))
    )
      throw new ConveroomError('sqlite_version', 'SQLite >=3.51.3 is required');
    const userVersion = db.pragma('user_version', { simple: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
      .all() as { name: string }[];
    if (userVersion !== 0 && userVersion !== 1)
      throw new ConveroomError('schema_version', 'Unsupported database schema version');
    if (userVersion === 0 && tables.length)
      throw new ConveroomError('schema_version', 'Unidentified database schema; migration refused');
    if (
      userVersion === 1 &&
      (tables.length !== 3 ||
        !['records', 'events', 'idempotency'].every((n) => tables.some((t) => t.name === n)))
    )
      throw new ConveroomError('schema_version', 'Invalid database schema');
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('synchronous = FULL');
    db.pragma('busy_timeout = 5000');
    if (userVersion === 0)
      db.transaction(() =>
        db.exec(`
      CREATE TABLE records(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(kind,id));
      CREATE TABLE events(room_id TEXT NOT NULL,seq INTEGER NOT NULL,id TEXT NOT NULL UNIQUE,json TEXT NOT NULL CHECK(json_valid(json)),PRIMARY KEY(room_id,seq));
      CREATE TABLE idempotency(actor_id TEXT NOT NULL,command TEXT NOT NULL,client_key TEXT NOT NULL,payload_hash TEXT NOT NULL,result TEXT NOT NULL CHECK(json_valid(result)),PRIMARY KEY(actor_id,command,client_key));
      PRAGMA user_version = 1;
    `),
      )();
    const get = db.prepare('SELECT json FROM records WHERE kind=? AND id=?');
    const list = db.prepare('SELECT json FROM records WHERE kind=? ORDER BY rowid');
    const put = db.prepare(
      'INSERT INTO records(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json',
    );
    const del = db.prepare('DELETE FROM records WHERE kind=? AND id=?');
    const append = db.prepare('INSERT INTO events(room_id,seq,id,json) VALUES(?,?,?,?)');
    const events = db.prepare(
      'SELECT json FROM events WHERE room_id=? AND seq>? ORDER BY seq LIMIT ?',
    );
    const idemGet = db.prepare(
      'SELECT payload_hash,result FROM idempotency WHERE actor_id=? AND command=? AND client_key=?',
    );
    const idemPut = db.prepare('INSERT INTO idempotency VALUES(?,?,?,?,?)');
    const parse = <T>(row: unknown): T | undefined =>
      row ? (JSON.parse((row as { json: string }).json) as T) : undefined;
    const store: Store = {
      get: <T>(kind: string, id: string) => parse<T>(get.get(kind, id)),
      list: <T>(kind: string) => list.all(kind).map((row) => parse<T>(row)!),
      put: (kind, id, value) => {
        put.run(kind, id, canonicalJson(value));
      },
      remove: (kind, id) => {
        del.run(kind, id);
      },
      transaction: (fn) =>
        db
          .transaction(() => {
            const result = fn();
            if (result && typeof (result as { then?: unknown }).then === 'function')
              throw new ConveroomError('async_transaction', 'Transactions must be synchronous');
            return result;
          })
          .immediate(),
      append: (roomId, type, actorId, data) =>
        store.transaction(() => {
          const room = store.get<ToolArgs>('room', roomId);
          if (!room) throw new ConveroomError('room_not_found', 'Room not found', 404);
          const event: Event = {
            id: randomUUID(),
            roomId,
            seq: Number(room.seq) + 1,
            type,
            actorId,
            at: Date.now(),
            data: redactPublic(data),
          };
          append.run(roomId, event.seq, event.id, canonicalJson(event));
          store.put('room', roomId, { ...room, seq: event.seq });
          return event;
        }),
      events: (roomId, after = 0, limit = 100) =>
        events
          .all(
            roomId,
            Math.max(0, Math.floor(after)),
            Math.max(1, Math.min(1000, Math.floor(limit))),
          )
          .map((row) => parse<Event>(row)!),
      importEvents: (input) =>
        store.transaction(() => {
          const cursors = new Map<string, number>();
          for (const event of input) {
            if (
              !store.get('room', event.roomId) ||
              !Number.isSafeInteger(event.seq) ||
              event.seq !== (cursors.get(event.roomId) ?? 0) + 1 ||
              typeof event.id !== 'string' ||
              typeof event.type !== 'string' ||
              !event.data
            )
              throw new ConveroomError('export_invalid', 'Invalid event provenance');
            append.run(event.roomId, event.seq, event.id, canonicalJson(redactPublic(event)));
            cursors.set(event.roomId, event.seq);
          }
        }),
      idempotent: <T>(
        actorId: string,
        command: string,
        key: string,
        payload: unknown,
        fn: () => T,
      ) =>
        store.transaction(() => {
          const hash = scopeDigest(payload);
          const previous = idemGet.get(actorId, command, key) as
            { payload_hash: string; result: string } | undefined;
          if (previous) {
            if (previous.payload_hash !== hash)
              throw new ConveroomError(
                'idempotency_conflict',
                'Client key reused with a different payload',
                409,
              );
            return JSON.parse(previous.result) as T;
          }
          const result = fn();
          idemPut.run(actorId, command, key, hash, canonicalJson(result));
          return result;
        }),
      backup: async (destination) => {
        await db.backup(destination);
      },
      close: () => {
        if (db.open) db.close();
      },
    };
    return store;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function allRoomEvents(store: Store, roomId: string): Event[] {
  const result: Event[] = [];
  let cursor = 0;
  while (true) {
    const page = store.events(roomId, cursor, 1000);
    result.push(...page);
    if (result.length > 50000)
      throw new ConveroomError('export_limit', 'Room history exceeds the bounded export limit');
    if (page.length < 1000) return result;
    cursor = page.at(-1)!.seq;
  }
}
