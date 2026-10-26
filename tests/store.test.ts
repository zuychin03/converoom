import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStore, redactTransport } from '../packages/store/src/index.js';
import type { Store } from '../packages/shared/src/contracts.js';

const stores: Store[] = [];
const directories: string[] = [];
function open() {
  const dir = mkdtempSync(join(tmpdir(), 'converoom-store-'));
  directories.push(dir);
  const path = join(dir, 'rooms.sqlite');
  const store = createStore(path);
  stores.push(store);
  return { store, path, dir };
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const s of stores.splice(0)) s.close();
  for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('durable store', () => {
  it('opens a working SQLite store', () => {
    expect(() => open()).not.toThrow();
  });
  it('commits event sequences with room state and rolls back failures', () => {
    const { store, path } = open();
    store.put('room', 'r', { id: 'r', seq: 0 });
    expect(store.append('r', 'post', 'a', { text: 'one' }).seq).toBe(1);
    expect(() =>
      store.transaction(() => {
        store.append('r', 'post', 'a', {});
        throw new Error('crash');
      }),
    ).toThrow('crash');
    expect(store.get('room', 'r')).toEqual({ id: 'r', seq: 1 });
    store.close();
    const restored = createStore(path);
    stores.push(restored);
    expect(restored.append('r', 'post', 'a', {}).seq).toBe(2);
    expect(restored.events('r').map((e) => e.seq)).toEqual([1, 2]);
  });
  it('notifies append listeners once per synchronous batch after it commits, past a failing listener, until they unsubscribe', async () => {
    const { store } = open();
    store.put('room', 'r', { id: 'r', seq: 0 });
    const seen: number[][] = [];
    store.onAppend(() => { throw new Error('listener failure'); });
    const stop = store.onAppend(() => seen.push(store.events('r').map((e) => e.seq)));
    store.transaction(() => {
      store.append('r', 'post', 'a', {});
      store.append('r', 'post', 'a', {});
    });
    store.append('r', 'post', 'a', {});
    expect(seen).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([[1, 2, 3]]);
    stop();
    store.append('r', 'post', 'a', {});
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([[1, 2, 3]]);
  });
  it('deduplicates 100 callers and rejects changed payload reuse', async () => {
    const { store } = open();
    store.put('room', 'r', { id: 'r', seq: 0 });
    const results = await Promise.all(
      Array.from({ length: 100 }, async () =>
        store.idempotent('actor', 'post', 'key', { b: 2, a: 1 }, () =>
          store.append('r', 'post', 'actor', {}),
        ),
      ),
    );
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(store.events('r')).toHaveLength(1);
    expect(() => store.idempotent('actor', 'post', 'key', { a: 2 }, () => null)).toThrow(
      /payload/i,
    );
    expect(store.idempotent('actor', 'post', 'key', { a: 1, b: 2 }, () => null)).toEqual(
      results[0],
    );
  });
  it('expires stored results a week after a later pass without changing the 0.2.0 table', () => {
    let now = 1_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { store, path } = open(), week = 7 * 86400000;
    const run = (key: string, value: string) => store.idempotent('actor', 'post', key, { key }, () => value);
    run('old', 'first');
    expect(store.expireResults(now - week, 1000)).toBe(0);
    now += 3600000;
    run('new', 'second');
    expect(store.expireResults(now - week, 1000)).toBe(0);
    now += week - 3600000;
    expect(store.expireResults(now - week, 1000)).toBe(1);
    expect(run('old', 'rerun')).toBe('rerun');
    expect(run('new', 'duplicate')).toBe('second');
    store.close();
    const db = new Database(path);
    expect(db.pragma('user_version', { simple: true })).toBe(2);
    expect(db.prepare("SELECT name FROM pragma_table_info('idempotency')").pluck().all())
      .toEqual(['actor_id', 'command', 'client_key', 'payload_hash', 'result']);
    db.close();
  });
  it('expires a backlog in bounded batches and keeps the mark until its rows are gone', () => {
    let now = 1_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { store } = open(), week = 7 * 86400000;
    for (const key of ['a', 'b', 'c']) store.idempotent('actor', 'post', key, { key }, () => key);
    store.expireResults(now - week, 2);
    now += week;
    expect(store.expireResults(now - week, 2)).toBe(2);
    expect(store.expireResults(now - week, 2)).toBe(1);
    expect(store.expireResults(now - week, 2)).toBe(0);
  });
  it('expires finished records of one kind a period after they finish, timing older records from first sight', () => {
    let now = 1_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { store } = open(), day = 86400000, week = 7 * day;
    const expire = (limit = 1000) => store.expireRecords('command', ['done', 'failed'], now - week, limit);
    for (const id of ['done-1', 'done-2']) store.put('command', id, { status: 'done', at: now });
    store.put('command', 'failed', { status: 'failed', at: now });
    store.put('command', 'working', { status: 'working' });
    store.put('other', 'done', { status: 'done', at: now });
    now += day;
    store.put('command', 'earlier-version', { status: 'done' });
    expect(expire()).toBe(0);
    now += week - day;
    expect(expire(2)).toBe(2);
    expect(expire(2)).toBe(1);
    expect(store.get('command', 'earlier-version')).toMatchObject({ status: 'done' });
    now += day;
    expect(expire()).toBe(1);
    expect(store.get('command', 'working')).toEqual({ status: 'working' });
    expect(store.get('other', 'done')).toBeDefined();
  });
  it('drops a mark whose row has gone instead of expiring a newer row that reuses its rowid', () => {
    let now = 1_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { store } = open(), week = 7 * 86400000;
    const run = (key: string, value: string) => store.idempotent('actor', 'post', key, { key }, () => value);
    run('first', 'one');
    store.expireResults(now - week, 1000);
    store.forgetResults(['post']);
    now += 60000;
    run('second', 'two');
    now += week;
    expect(store.expireResults(now - week, 1000)).toBe(0);
    expect(run('second', 'duplicate')).toBe('two');
  });
  it('backups contain a consistent committed event projection', async () => {
    const { store, dir } = open();
    store.put('room', 'r', { id: 'r', seq: 0 });
    store.append('r', 'post', 'a', {});
    const backup = join(dir, 'backup.sqlite');
    await store.backup(backup);
    const copy = createStore(backup);
    stores.push(copy);
    expect(copy.get('room', 'r')).toEqual({ id: 'r', seq: 1 });
    expect(copy.events('r')).toHaveLength(1);
  });
  it('migrates version 1 rooms to an independent lifecycle and phase', () => {
    const { store, path } = open();
    for (const [id, status] of [['open', 'open'], ['paused', 'paused'], ['closed', 'closed'], ['decided', 'open']])
      store.put('room', id, { id, seq: 0, status });
    store.append('decided', 'decision', 'host', { decision: 'Use SQLite' });
    store.put('room', 'current', { id: 'current', seq: 0, lifecycle: 'cancelled', phase: 'owner_review' });
    store.put('turn', 't', { id: 't', roomId: 'open', status: 'queued' });
    store.close();
    const db = new Database(path);
    db.pragma('user_version = 1');
    db.close();
    const migrated = createStore(path);
    stores.push(migrated);
    expect(['open', 'paused', 'closed', 'decided'].map((id) => migrated.get('room', id))).toEqual([
      { id: 'open', seq: 0, lifecycle: 'active', phase: 'deliberation' },
      { id: 'paused', seq: 0, lifecycle: 'paused', phase: 'deliberation' },
      { id: 'closed', seq: 0, lifecycle: 'completed', phase: 'deliberation' },
      { id: 'decided', seq: 1, lifecycle: 'active', phase: 'decision_proposed' },
    ]);
    expect(migrated.get('room', 'current')).toEqual({ id: 'current', seq: 0, lifecycle: 'cancelled', phase: 'owner_review' });
    expect(migrated.get('turn', 't')).toEqual({ id: 't', roomId: 'open', status: 'queued' });
    migrated.close();
    const check = new Database(path);
    expect(check.pragma('user_version', { simple: true })).toBe(2);
    check.close();
  });
  it('refuses future schemas and unidentified populated databases', () => {
    const { store, path } = open();
    store.close();
    const db = new Database(path);
    db.pragma('user_version = 999');
    db.close();
    expect(() => createStore(path)).toThrow(/schema/i);
    const stray = join(directories[0], 'stray.sqlite');
    const unknown = new Database(stray);
    unknown.exec('CREATE TABLE private_data(id TEXT)');
    unknown.close();
    expect(() => createStore(stray)).toThrow(/schema/i);
  });
  it('redacts for transport idempotently, so a second pass cannot change a hashed export', () => {
    const value = {
      apiKey: 'sk-fixtureSECRET1234', cookie: 'c', keep: 'Bearer fixture password=fixture <thinking>hidden-plan</thinking> api_key=Bearer fixture',
      nested: [{ reasoning: 'r', note: 'secret: sk-abcdefgh12, refresh_token=fixture;rest' }, 'ghp_fixture1234 Bearer abc== tail'],
    };
    const once = redactTransport(value);
    expect(redactTransport(once)).toEqual(once);
    expect(JSON.stringify(once)).not.toMatch(/fixture|SECRET|hidden-plan|abcdefgh12/);
  });
  it('does not persist credentials or private reasoning in public events', () => {
    const { store } = open();
    store.put('room', 'r', { id: 'r', seq: 0 });
    const e = store.append('r', 'status', 'a', {
      token: 'secret-fixture',
      nested: { privateReasoning: 'private-fixture' },
      text: 'Authorization: Bearer abcdefghijk',
    });
    expect(JSON.stringify(e)).not.toContain('secret-fixture');
    expect(JSON.stringify(e)).not.toContain('private-fixture');
    expect(JSON.stringify(e)).not.toContain('abcdefghijk');
  });
});
