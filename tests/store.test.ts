import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { createStore } from '../packages/store/src/index.js';
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
