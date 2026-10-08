export type RecordData = Record<string, unknown>;
export const collections = [
  'rooms',
  'seats',
  'events',
  'interactions',
  'turns',
  'permissions',
  'tasks',
  'attempts',
  'repos',
  'profiles',
  'manifests',
  'verifications',
  'reviews',
  'candidates',
  'resources',
] as const;
export type Snapshot = { [K in (typeof collections)[number]]: RecordData[] };
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = 'request_failed',
  ) {
    super(message);
    this.name = 'ApiError';
  }
}
export function isRecord(value: unknown): value is RecordData {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function parseSnapshot(value: unknown): Snapshot {
  if (!isRecord(value)) throw new Error('Invalid state received. Refresh to try again.');
  return Object.fromEntries(
    collections.map((key) => {
      const items = value[key] ?? [];
      if (!Array.isArray(items) || items.some((item) => !isRecord(item)))
        throw new Error(`Invalid ${key} received. Refresh to try again.`);
      return [key, items];
    }),
  ) as Snapshot;
}
type Transport = (url: string, init?: RequestInit) => Promise<Response>;
export function createClient(transport: Transport = (url, init) => fetch(url, init)) {
  let csrf = '';
  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const response = await transport(path, {
      ...init,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401) csrf = '';
      const error = isRecord(value) && isRecord(value.error) ? value.error : value;
      throw new ApiError(
        isRecord(error) && typeof error.message === 'string'
          ? error.message
          : `Request failed (${response.status}). Try again.`,
        response.status,
        isRecord(error) && typeof error.code === 'string' ? error.code : undefined,
      );
    }
    return value;
  }
  return {
    async pair(code: string) {
      await request('/api/pair', { method: 'POST', body: JSON.stringify({ code }) });
    },
    async session() {
      const value = await request('/api/session');
      if (!isRecord(value) || typeof value.csrf !== 'string' || !value.csrf)
        throw new Error('Invalid browser session. Pair this browser again.');
      csrf = value.csrf;
      return value;
    },
    async state() {
      return parseSnapshot(await request('/api/state'));
    },
    async command(name: string, args: RecordData) {
      if (!csrf) throw new ApiError('Pair this browser before making changes.', 401);
      const value = await request('/api/commands', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf },
        body: JSON.stringify({ name, args }),
      });
      return isRecord(value) ? value.result : value;
    },
  };
}
export const string = (record: RecordData, key: string, fallback = '') =>
  typeof record[key] === 'string' ? (record[key] as string) : fallback;
export const objects = (record: RecordData, key: string): RecordData[] =>
  Array.isArray(record[key]) ? (record[key] as unknown[]).filter(isRecord) : [];
export const list = (record: RecordData, key: string): string[] =>
  Array.isArray(record[key])
    ? (record[key] as unknown[]).filter((item): item is string => typeof item === 'string')
    : [];
