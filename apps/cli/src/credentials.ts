import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { supervisorPath } from '../../../packages/adapters/src/process.js';
import { ConveroomError } from '../../../packages/shared/src/contracts.js';
import { privateDirectory } from './support.js';

export interface SecretStore {
  read(target: string): Promise<string | undefined>;
  write(target: string, value: string): Promise<void>;
  remove(target: string): Promise<void>;
}
export class CredentialStoreUnavailable extends Error {}
export const CLIENT_SECRETS = ['token'] as const;
export const REMOTE_SECRETS = ['accessToken', 'refreshToken'] as const;
export const OAUTH_SECRETS = ['verifier', 'tokens'] as const;
const STORED = 'windows-credential-manager';
const SECRET_FILES: [string, RegExp, readonly string[]][] = [
  ['clients', /\.json$/i, CLIENT_SECRETS],
  ['remote', /^[0-9a-f-]{36}\.json$/i, REMOTE_SECRETS],
  ['remote', /^[0-9a-f-]{36}\.oauth\.json$/i, OAUTH_SECRETS],
];

function helper(args: string[], input = ''): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done, fail) => {
    const child = spawn(supervisorPath(), ['--credential', ...args], { windowsHide: true });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', fail);
    child.once('close', (code) => done({ code: code ?? 70, stdout, stderr }));
    child.stdin.end(input);
  });
}
// The helper exits 2 for a missing credential; any other failure means the store cannot be used from this session.
export function windowsCredentialStore(): SecretStore {
  const call = async (args: string[], input?: string) => {
    const result = await helper(args, input).catch((error: unknown) => {
      throw new CredentialStoreUnavailable(error instanceof Error ? error.message : 'Credential helper unavailable');
    });
    if (result.code !== 0 && result.code !== 2)
      throw new CredentialStoreUnavailable(result.stderr.trim() || 'Credential helper exited with ' + result.code);
    return result;
  };
  return {
    read: async (target) => {
      const result = await call(['read', target]);
      return result.code === 2 ? undefined : result.stdout;
    },
    write: async (target, value) => { await call(['write', target], value); },
    remove: async (target) => { await call(['delete', target]); },
  };
}
const filesOnly: SecretStore = {
  read: () => Promise.reject(new CredentialStoreUnavailable('CONVEROOM_CREDENTIAL_STORE=file keeps credentials in private files')),
  write: () => Promise.reject(new CredentialStoreUnavailable('CONVEROOM_CREDENTIAL_STORE=file keeps credentials in private files')),
  remove: () => Promise.reject(new CredentialStoreUnavailable('CONVEROOM_CREDENTIAL_STORE=file keeps credentials in private files')),
};
const windows = windowsCredentialStore();
let override: SecretStore | undefined;
const active = () => override ?? (process.env.CONVEROOM_CREDENTIAL_STORE === 'file' ? filesOnly : windows);
export function useCredentialStore(store?: SecretStore): SecretStore | undefined {
  const previous = override;
  override = store;
  return previous;
}
export function credentialTarget(path: string): string {
  const full = resolve(path), root = dirname(dirname(full));
  const id = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex').slice(0, 16);
  return `Converoom/${id}/${basename(dirname(full))}/${basename(full)}`;
}
async function replace(path: string, value: unknown) {
  await privateDirectory(dirname(path));
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, path);
}
// Secret fields go to the store and the file keeps the rest; without a usable store the whole value stays in the private file.
export async function writeCredential(path: string, value: Record<string, unknown>, secrets: readonly string[]): Promise<'credential-manager' | 'file'> {
  const hidden: Record<string, unknown> = {}, visible: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) if (item !== undefined) (secrets.includes(key) ? hidden : visible)[key] = item;
  const target = credentialTarget(path);
  try {
    await active().write(target, JSON.stringify(hidden));
  } catch (error) {
    if (!(error instanceof CredentialStoreUnavailable)) throw error;
    await replace(path, value);
    return 'file';
  }
  await replace(path, { ...visible, credentialStore: STORED, credentialTarget: target });
  return 'credential-manager';
}
export async function readCredential<T>(path: string): Promise<T> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  if (value.credentialStore !== STORED) return value as T;
  const target = String(value.credentialTarget), visible = { ...value };
  delete visible.credentialStore;
  delete visible.credentialTarget;
  let secret: string | undefined;
  try {
    secret = await active().read(target);
  } catch (error) {
    if (!(error instanceof CredentialStoreUnavailable)) throw error;
    throw new ConveroomError('credential_unavailable',
      `Windows Credential Manager is unavailable in this session, so ${basename(path)} cannot be read: ${error.message}`, 503);
  }
  if (secret === undefined)
    throw new ConveroomError('credential_missing', `The saved credential for ${basename(path)} is missing from Windows Credential Manager. ` +
      'Reconnect it: converoom connect for an agent product, or connect the shared room again.', 409);
  return { ...visible, ...(JSON.parse(secret) as Record<string, unknown>) } as T;
}
export async function credentialLocation(path: string): Promise<string | undefined> {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (value.credentialStore !== STORED) return 'private file';
  try {
    return (await active().read(String(value.credentialTarget))) === undefined ? 'missing from Windows Credential Manager' : 'Windows Credential Manager';
  } catch (error) {
    if (!(error instanceof CredentialStoreUnavailable)) throw error;
    return 'Windows Credential Manager, which is unavailable in this session';
  }
}
export async function removeCredential(path: string): Promise<void> {
  await active().remove(credentialTarget(path)).catch((error: unknown) => {
    if (!(error instanceof CredentialStoreUnavailable)) throw error;
  });
  await unlink(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
}
export async function migrateCredentials(dataDir: string): Promise<number> {
  let moved = 0;
  for (const [folder, pattern, secrets] of SECRET_FILES)
    for (const name of await readdir(join(dataDir, folder)).catch(() => [] as string[])) {
      if (!pattern.test(name)) continue;
      const path = join(dataDir, folder, name);
      let value: Record<string, unknown>;
      try {
        value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (value.credentialStore === STORED || !secrets.some((key) => value[key] !== undefined)) continue;
      if ((await writeCredential(path, value, secrets)) === 'credential-manager') moved++;
    }
  return moved;
}
export async function credentialStorage(): Promise<{ store: string; reason?: string; protects: string; limits: string }> {
  const probe = `Converoom/probe/${process.pid}-${Date.now()}`;
  try {
    await active().write(probe, '{}');
    await active().remove(probe);
    return {
      store: 'Windows Credential Manager',
      protects: 'Copies of the data folder, backups and synced files hold no saved agent or room connection credentials.',
      limits: 'Programs running as you can still read Credential Manager, so it does not separate Converoom from them.',
    };
  } catch (error) {
    if (!(error instanceof CredentialStoreUnavailable)) throw error;
    return {
      store: 'private files',
      reason: error.message,
      protects: 'The data folder is limited to your account, the system and administrators.',
      limits: 'Copies of the data folder include the saved credentials, and programs running as you can read them.',
    };
  }
}
