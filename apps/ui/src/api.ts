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
  'members', 'invitations', 'ownerConsents', 'remoteConnections', 'remoteProposals', 'sharedArtefacts',
] as const;
export type Snapshot = { [K in (typeof collections)[number]]: RecordData[] };
export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code = 'request_failed',
    public committed: boolean | null = null,
    public retrySafe = false,
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
export function createClient(transport: Transport = (url, init) => fetch(url, init), shared = false) {
  let csrf = '';
  let generation = 0, policyVersion = 0, roomId = '';
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
        isRecord(error) && typeof error.committed === 'boolean' ? error.committed : null,
        isRecord(error) && error.retrySafe === true,
      );
    }
    return value;
  }
  return {
    async join(id: string, code: string, recovery = false) {
      if (!shared) throw new Error('Shared browser required');
      await request('/shared/v1/join', { method: 'POST', body: JSON.stringify({ roomId: id, code, ...(recovery ? { recovery: true } : {}) }) });
    },
    async pair(code: string) {
      await request('/api/pair', { method: 'POST', body: JSON.stringify({ code }) });
    },
    async session() {
      const value = await request(shared ? '/shared/v1/session' : '/api/session');
      if (!isRecord(value) || typeof value.csrf !== 'string' || !value.csrf)
        throw new Error('Invalid browser session. Pair this browser again.');
      csrf = value.csrf;
      if (shared) { roomId = string(value, 'roomId'); generation = Number(value.generation); }
      return value;
    },
    async state() {
      if (shared) {
        const value = await request('/shared/v1/browser/state');
        if (!isRecord(value) || !isRecord(value.room)) throw new Error('Invalid shared room state');
        policyVersion = Number(value.room.policyVersion);
        return parseSnapshot({ rooms: [value.room], seats: value.seats, events: value.events, turns: value.turns, interactions: value.interactions,
          members: value.members, ownerConsents: value.ownerConsents, sharedArtefacts: value.artefacts });
      }
      return parseSnapshot(await request('/api/state'));
    },
    async command(name: string, args: RecordData) {
      if (!csrf) throw new ApiError('Pair this browser before making changes.', 401);
      if (shared && (!policyVersion || args.roomId && args.roomId !== roomId)) throw new Error('Refresh the current shared room before making changes.');
      const value = await request(shared ? name === 'shared_artefact_publish' ? '/shared/v1/artefacts' : '/shared/v1/browser/commands' : name === 'shared_artefact_publish' ? '/api/artefacts' : '/api/commands', {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrf },
        body: JSON.stringify(shared ? name === 'shared_artefact_publish' ? { ...args, roomId, expectedGeneration: generation, expectedPolicyVersion: policyVersion }
          : { name, args: { ...args, roomId, expectedGeneration: generation, expectedPolicyVersion: policyVersion } } : { name, args }),
      });
      return isRecord(value) ? value.result : value;
    },
    async exportPage(cursor = 0) { return request('/shared/v1/export?cursor=' + cursor); },
    eventsPath: shared ? '/shared/v1/events' : '/api/events',
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
