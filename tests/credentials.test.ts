import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  CLIENT_SECRETS, CredentialStoreUnavailable, credentialStorage, credentialTarget, migrateCredentials, readCredential, removeCredential,
  useCredentialStore, windowsCredentialStore, writeCredential, type SecretStore,
} from '../apps/cli/src/credentials.js';
import { supervisorPath } from '../packages/adapters/src/process.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRuntime } from '../apps/daemon/src/runtime.js';
import { createServer, issueBridgeCredential } from '../apps/daemon/src/server.js';

let dir: string, vault: Map<string, string>, previous: SecretStore | undefined;
const memory: SecretStore = {
  read: async (target) => vault.get(target),
  write: async (target, value) => { vault.set(target, value); },
  remove: async (target) => { vault.delete(target); },
};
const unavailable: SecretStore = {
  read: async () => { throw new CredentialStoreUnavailable('Credential read failed with Windows error 1312'); },
  write: async () => { throw new CredentialStoreUnavailable('Credential write failed with Windows error 1312'); },
  remove: async () => { throw new CredentialStoreUnavailable('Credential delete failed with Windows error 1312'); },
};
const raw = async (path: string) => JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'converoom-credentials-'));
  vault = new Map();
  previous = useCredentialStore(memory);
});
afterEach(async () => {
  useCredentialStore(previous);
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it('keeps the secret in the credential store and only a reference in the file', async () => {
  const path = join(dir, 'clients', 'codex.json');
  const value = { principalId: 'p', token: 'secret-token', product: 'codex', config: 'C:/codex/config.toml' };
  expect(await writeCredential(path, value, CLIENT_SECRETS)).toBe('credential-manager');
  const file = await raw(path);
  expect(JSON.stringify(file)).not.toContain('secret-token');
  expect(file).toEqual({ principalId: 'p', product: 'codex', config: 'C:/codex/config.toml',
    credentialStore: 'windows-credential-manager', credentialTarget: credentialTarget(path) });
  expect(credentialTarget(path)).toMatch(/^Converoom\/[0-9a-f]{16}\/clients\/codex\.json$/);
  expect(credentialTarget(join(dir.toUpperCase(), 'clients', 'codex.json'))).toBe(credentialTarget(path));
  expect([...vault.values()]).toEqual([JSON.stringify({ token: 'secret-token' })]);
  expect(await readCredential(path)).toEqual(value);
  await removeCredential(path);
  expect(existsSync(path)).toBe(false);
  expect(vault.size).toBe(0);
});

it('keeps a private file when the credential store is unavailable and reads it back', async () => {
  useCredentialStore(unavailable);
  const path = join(dir, 'clients', 'codex.json');
  expect(await writeCredential(path, { principalId: 'p', token: 't' }, CLIENT_SECRETS)).toBe('file');
  expect(await raw(path)).toEqual({ principalId: 'p', token: 't' });
  expect(await readCredential(path)).toEqual({ principalId: 'p', token: 't' });
  await removeCredential(path);
  expect(existsSync(path)).toBe(false);
});

it('refuses a reference whose secret is gone and names the fix', async () => {
  const path = join(dir, 'clients', 'cursor.json');
  await writeCredential(path, { principalId: 'p', token: 't' }, CLIENT_SECRETS);
  vault.clear();
  await expect(readCredential(path)).rejects.toThrow(/missing from Windows Credential Manager.*converoom connect/i);
  useCredentialStore(unavailable);
  await expect(readCredential(path)).rejects.toThrow(/Credential Manager is unavailable/i);
});

it('moves plain credentials into the store and leaves per-turn and non-secret files alone', async () => {
  for (const sub of ['clients', 'remote', 'bridges']) await mkdir(join(dir, sub));
  const id = randomUUID(), client = join(dir, 'clients', 'codex.json'), remote = join(dir, 'remote', id + '.json'),
    oauth = join(dir, 'remote', id + '.oauth.json'), turn = join(dir, 'bridges', 'turn.json');
  await writeFile(client, JSON.stringify({ principalId: 'p', token: 'bridge-secret', skill: { path: 's', digest: 'd' } }));
  await writeFile(remote, JSON.stringify({ accessToken: 'access-secret', refreshToken: 'refresh-secret', accessExpiresAt: 1, connection: { id } }));
  await writeFile(oauth, JSON.stringify({ nonce: 'n', verifier: 'verifier-secret', tokens: { access_token: 'oauth-secret' }, callbackUsed: false }));
  await writeFile(turn, JSON.stringify({ principalId: 't', token: 'turn-secret' }));
  expect(await migrateCredentials(dir)).toBe(3);
  for (const [path, secret] of [[client, 'bridge-secret'], [remote, 'refresh-secret'], [oauth, 'verifier-secret'], [oauth, 'oauth-secret']])
    expect(await readFile(path, 'utf8')).not.toContain(secret);
  expect(await raw(client)).toMatchObject({ principalId: 'p', skill: { path: 's', digest: 'd' } });
  expect(await raw(oauth)).toMatchObject({ nonce: 'n', callbackUsed: false });
  expect(await readCredential(remote)).toEqual({ accessToken: 'access-secret', refreshToken: 'refresh-secret', accessExpiresAt: 1, connection: { id } });
  expect(await readCredential(oauth)).toMatchObject({ verifier: 'verifier-secret', tokens: { access_token: 'oauth-secret' } });
  expect(await readFile(turn, 'utf8')).toContain('turn-secret');
  expect(await migrateCredentials(dir)).toBe(0);
});

it('reports where credentials are kept and what that protects against', async () => {
  expect(await credentialStorage()).toMatchObject({ store: 'Windows Credential Manager', limits: expect.stringMatching(/programs running as you/i) });
  expect(vault.size).toBe(0);
  useCredentialStore(unavailable);
  expect(await credentialStorage()).toMatchObject({ store: 'private files', reason: expect.stringMatching(/1312/) });
  useCredentialStore(undefined);
  vi.stubEnv('CONVEROOM_CREDENTIAL_STORE', 'file');
  expect(await credentialStorage()).toMatchObject({ store: 'private files', reason: expect.stringMatching(/CONVEROOM_CREDENTIAL_STORE/) });
  expect(await writeCredential(join(dir, 'clients', 'codex.json'), { principalId: 'p', token: 't' }, CLIENT_SECRETS)).toBe('file');
});

it('round-trips through Windows Credential Manager with the shipped helper', async () => {
  const target = 'Converoom/test/' + randomUUID(), store = windowsCredentialStore();
  try {
    await store.write(target, '{"token":"live"}');
  } catch (error) {
    // A session without a credential vault (such as some service logons) reports this; callers then keep private files.
    expect(error).toBeInstanceOf(CredentialStoreUnavailable);
    expect((error as Error).message).toMatch(/Windows error 1312/);
    return;
  }
  try {
    expect(await store.read(target)).toBe('{"token":"live"}');
  } finally {
    await store.remove(target);
  }
  expect(await store.read(target)).toBeUndefined();
  await store.remove(target);
  expect(spawnSync(supervisorPath(), ['--credential', 'write', target], { input: 'x'.repeat(3000) }).status).toBe(65);
  expect(await store.read(target)).toBeUndefined();
});

it('lets an MCP bridge authenticate with its credential in Windows Credential Manager', async () => {
  const data = join(dir, 'data'), runtime = await createRuntime(data, { noScheduler: true }), server = await createServer(runtime, { port: 0 });
  const file = join(data, 'clients', 'codex.json'), client = new Client({ name: 'vault-fixture', version: '1.0' }, { capabilities: {} });
  useCredentialStore(windowsCredentialStore());
  try {
    await writeFile(join(data, 'runtime.json'), JSON.stringify({ url: server.url }));
    const credential = issueBridgeCredential(runtime, 'codex');
    // Without a credential vault in this session the file keeps the credential, and the bridge must still connect.
    if ((await writeCredential(file, { ...credential }, CLIENT_SECRETS)) === 'credential-manager')
      expect(await readFile(file, 'utf8')).not.toContain(credential.token);
    await client.connect(new StdioClientTransport({ command: process.execPath, stderr: 'pipe',
      args: [join(process.cwd(), 'dist', 'cli.js'), 'mcp', '--client', 'codex', '--data-dir', data] }));
    const created = await client.callTool({ name: 'room_create', arguments: { title: 'Vault', objective: 'Bridge reads the store', clientKey: 'create' } });
    expect(created.isError).not.toBe(true);
  } finally {
    await client.close();
    await removeCredential(file);
    await server.close();
    await runtime.stop();
  }
}, 60000);
