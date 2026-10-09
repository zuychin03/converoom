import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { createOAuthMetadata } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { OAuthClientInformationFullSchema, type OAuthClientInformationFull, type OAuthTokens,
  type OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidClientError, InvalidGrantError, InvalidRequestError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { ConveroomError as E, type Actor, type Core, type Seat } from '../../shared/src/contracts.js';
import { activeMembership, currentSeat } from '../../core/src/membership.js';

const secret = () => randomBytes(32).toString('base64url');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function privateOrigin(value: string) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.ts.net') || url.username || url.password || value !== url.origin)
    throw new E('private_origin', 'An exact Tailscale HTTPS origin is required');
  return url.origin;
}
interface Request {
  id: string;
  clientId: string;
  roomId: string;
  state: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
  approved?: boolean;
}
interface Binding {
  clientId: string;
  roomId: string;
  actor: Actor;
  memberPrincipalId?: string;
  generation: number;
  audience: string;
  familyId: string;
  expiresAt: number;
}
interface Code extends Binding { codeChallenge: string; redirectUri: string }
export class SharedOAuth implements OAuthServerProvider {
  readonly origin: string;
  readonly resource: string;
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly metadata;
  private readonly clients = new Map<string, OAuthClientInformationFull>();
  constructor(private readonly core: Core, origin: string, clients: OAuthClientInformationFull[]) {
    this.origin = privateOrigin(origin); this.resource = this.origin + '/mcp';
    if (!clients.length || clients.length > 20) throw new E('oauth_client', 'One to twenty explicit bridge clients required');
    for (const input of clients) {
      const client = OAuthClientInformationFullSchema.parse(input);
      if (!client.client_id || client.client_id.length > 256 || this.clients.has(client.client_id) || client.client_secret ||
        client.token_endpoint_auth_method !== 'none' || client.redirect_uris.length !== 1)
        throw new E('oauth_client', 'Unique public PKCE bridge clients required');
      const redirect = new URL(client.redirect_uris[0]);
      if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.username ||
        redirect.password || redirect.search || redirect.hash || redirect.pathname !== '/oauth/callback')
        throw new E('oauth_redirect', 'An exact registered loopback callback is required');
      this.clients.set(client.client_id, Object.freeze(client));
    }
    this.clientsStore = { getClient: (id) => this.clients.get(id) };
    this.metadata = { ...createOAuthMetadata({ provider: this, issuerUrl: new URL(this.origin),
      scopesSupported: ['room'], baseUrl: new URL(this.origin) }), issuer: this.origin,
      token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'] };
  }
  private client(id: string) {
    const client = this.clients.get(id);
    if (!client) throw new InvalidClientError('Registered participant bridge required');
    return client;
  }
  private audience(resource?: URL) {
    if (resource?.href !== this.resource) throw new InvalidRequestError('Exact room resource audience required');
  }
  private check(binding: Binding) {
    const m = activeMembership(this.core.store, binding.roomId, binding.actor.ownerId, binding.memberPrincipalId ?? binding.actor.principalId);
    const r = this.core.store.get<{ workflow: string; status: string }>('room', binding.roomId);
    if (!m || m.generation !== binding.generation || r?.workflow !== 'discussion' || r.status === 'closed' ||
      binding.audience !== this.resource || binding.expiresAt <= Date.now() || this.core.store.get('shared_oauth_revoked', binding.familyId))
      throw new InvalidTokenError('Credential expired, removed or outside this room');
    if (binding.actor.kind === 'agent') {
      const seat = this.core.store.get<Seat>('seat', binding.actor.seatId ?? '');
      if (!seat || seat.roomId !== binding.roomId || seat.ownerId !== binding.actor.ownerId || seat.principalId !== binding.actor.principalId ||
        !currentSeat(this.core.store, this.core.requireRoom({ kind: 'human', ownerId: binding.actor.ownerId,
          principalId: binding.memberPrincipalId! }, binding.roomId), seat)) throw new InvalidTokenError('Agent seat withdrawn');
    }
  }
  private bounded(kind: string) {
    for (const record of this.core.store.list<{ id?: string; expiresAt?: number }>(kind)) {
      if (record.id && Number(record.expiresAt) <= Date.now()) this.core.store.remove(kind, record.id);
    }
    if (this.core.store.count(kind) >= 1000) throw new E('auth_capacity', 'Authentication capacity reached', 429);
  }
  begin(clientId: string, params: AuthorizationParams) {
    const client = this.client(clientId); this.audience(params.resource);
    if (!client.redirect_uris.includes(params.redirectUri) || !params.state || params.state.length < 32 || params.state.length > 256 ||
      !/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || params.scopes?.length !== 1 ||
      !/^room:[A-Za-z0-9-]{1,256}$/.test(params.scopes[0]))
      throw new InvalidRequestError('Registered redirect, state, S256 PKCE and one room scope required');
    this.bounded('shared_oauth_request');
    const request: Request = { id: randomUUID(), clientId, roomId: params.scopes[0].slice(5), state: params.state,
      redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, expiresAt: Date.now() + 300000 };
    this.core.store.put('shared_oauth_request', request.id, request);
    return { id: request.id, url: this.origin + '/shared/authorize?request=' + request.id };
  }
  request(id: string) {
    const request = this.core.store.get<Request>('shared_oauth_request', id);
    if (!request || request.approved || request.expiresAt <= Date.now()) throw new InvalidGrantError('Authorization request unavailable');
    return request;
  }
  approve(id: string, actor: Actor) {
    return this.core.store.transaction(() => {
      const request = this.request(id);
      if (actor.kind !== 'human') throw new InvalidGrantError('Human authorization required');
      const m = activeMembership(this.core.store, request.roomId, actor.ownerId, actor.principalId);
      if (!m) throw new InvalidGrantError('Confirmed room membership required');
      this.bounded('shared_oauth_code');
      const code = secret(), record: Code = { clientId: request.clientId, roomId: request.roomId, actor, generation: m.generation,
        codeChallenge: request.codeChallenge, redirectUri: request.redirectUri, audience: this.resource,
        familyId: randomUUID(), expiresAt: Date.now() + 120000 };
      this.check(record);
      this.core.store.put('shared_oauth_code', hash(code), { ...record, id: hash(code) });
      this.core.store.put('shared_oauth_request', id, { ...request, approved: true });
      const redirect = new URL(request.redirectUri);
      redirect.searchParams.set('code', code); redirect.searchParams.set('state', request.state); redirect.searchParams.set('iss', this.origin);
      return redirect.href;
    });
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Parameters<OAuthServerProvider['authorize']>[2]) {
    res.redirect(this.begin(client.client_id, params).url);
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) {
    const record = this.core.store.get<Code>('shared_oauth_code', hash(code));
    if (!record || record.clientId !== this.client(client.client_id).client_id) throw new InvalidGrantError('Code unavailable');
    this.check(record); return record.codeChallenge;
  }
  private issue(binding: Binding): OAuthTokens {
    this.bounded('shared_oauth_access'); this.bounded('shared_oauth_refresh');
    const access = secret(), refresh = secret(), accessId = hash(access), refreshId = hash(refresh);
    this.core.store.put('shared_oauth_access', accessId, { ...binding, id: accessId, expiresAt: Date.now() + 900000 });
    this.core.store.put('shared_oauth_refresh', refreshId, { ...binding, id: refreshId, expiresAt: Date.now() + 86400000 });
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 900, scope: 'room:' + binding.roomId };
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, verifier?: string, redirectUri?: string, resource?: URL) {
    return this.core.store.transaction(() => {
      this.audience(resource);
      const record = this.core.store.get<Code>('shared_oauth_code', hash(code));
      if (!record || record.clientId !== this.client(client.client_id).client_id || redirectUri !== record.redirectUri ||
        !verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || createHash('sha256').update(verifier).digest('base64url') !== record.codeChallenge)
        throw new InvalidGrantError('Authorization code binding rejected');
      this.check(record); const result = this.issue(record);
      this.core.store.remove('shared_oauth_code', hash(code)); return result;
    });
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, token: string, scopes?: string[], resource?: URL) {
    return this.core.store.transaction(() => {
      this.audience(resource);
      const record = this.core.store.get<Binding>('shared_oauth_refresh', hash(token));
      if (!record || record.clientId !== this.client(client.client_id).client_id ||
        (scopes && (scopes.length !== 1 || scopes[0] !== 'room:' + record.roomId))) throw new InvalidGrantError('Refresh scope rejected');
      this.check(record); const result = this.issue(record);
      this.core.store.remove('shared_oauth_refresh', hash(token)); return result;
    });
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.core.store.get<Binding>('shared_oauth_access', hash(token));
    if (!record) throw new InvalidTokenError('Credential unavailable');
    this.client(record.clientId); this.check(record);
    return { token, clientId: record.clientId, scopes: ['room:' + record.roomId], expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(this.resource), extra: { actor: record.actor, roomId: record.roomId, generation: record.generation } };
  }
  async issueAgent(token: string, seat: Seat) {
    const parent = this.core.store.get<Binding>('shared_oauth_access', hash(token));
    if (!parent || parent.actor.kind !== 'human' || seat.ownerId !== parent.actor.ownerId || seat.roomId !== parent.roomId)
      throw new InvalidGrantError('Own registered agent required');
    this.check(parent);
    const binding: Binding = { ...parent, actor: { kind: 'agent', ownerId: seat.ownerId, principalId: seat.principalId, seatId: seat.id },
      memberPrincipalId: parent.actor.principalId };
    this.check(binding); return this.core.store.transaction(() => this.issue(binding));
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    const id = hash(request.token), record = this.core.store.get<Binding>('shared_oauth_access', id) ?? this.core.store.get<Binding>('shared_oauth_refresh', id);
    if (record?.clientId === this.client(client.client_id).client_id) {
      this.core.store.put('shared_oauth_revoked', record.familyId, { revokedAt: Date.now() });
      for (const kind of ['shared_oauth_access', 'shared_oauth_refresh'])
        for (const row of this.core.store.list<Binding & { id: string }>(kind))
          if (row.familyId === record.familyId) this.core.store.remove(kind, row.id);
    }
  }
}
