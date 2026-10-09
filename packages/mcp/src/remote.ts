import { randomBytes } from 'node:crypto';
import type { OAuthClientProvider, OAuthDiscoveryState } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ConveroomError as E } from '../../shared/src/contracts.js';
import { privateOrigin } from './shared-auth.js';

export function pinnedFetch(origin: string, fetcher: FetchLike = fetch): FetchLike {
  const expected = privateOrigin(origin);
  return async (input, options) => {
    const url = input instanceof Request ? new URL(input.url) : new URL(input);
    if (url.origin !== expected || url.protocol !== 'https:' || url.username || url.password)
      throw new E('remote_origin', 'Remote discovery and requests must stay on the configured private origin', 403);
    return fetcher(input, { ...options, signal: options?.signal ?? AbortSignal.timeout(35000), redirect: 'error' });
  };
}
export interface RoomOAuthState {
  nonce: string;
  verifier?: string;
  tokens?: OAuthTokens;
  callbackUsed: boolean;
  authorizationUrl?: string;
}
export class RoomOAuthClient implements OAuthClientProvider {
  readonly origin: string;
  readonly redirectUrl: string;
  readonly clientMetadata;
  authorizationUrl?: string;
  private readonly nonce: string;
  private callbackUsed = false;
  private verifier?: string;
  private savedTokens?: OAuthTokens;
  constructor(origin: string, private readonly roomId: string, private readonly clientId: string, redirectUrl: string, state?: RoomOAuthState) {
    this.origin = privateOrigin(origin);
    const redirect = new URL(redirectUrl);
    if (redirect.protocol !== 'http:' || redirect.hostname !== '127.0.0.1' || !redirect.port || redirect.pathname !== '/oauth/callback' ||
      redirect.search || redirect.hash || redirect.username || redirect.password || redirectUrl !== redirect.href ||
      !/^[A-Za-z0-9-]{1,256}$/.test(roomId) || !clientId || clientId.length > 256)
      throw new E('remote_client', 'A room and exact registered loopback callback are required');
    this.redirectUrl = redirectUrl;
    if (state && (!/^[A-Za-z0-9_-]{43}$/.test(state.nonce) || typeof state.callbackUsed !== 'boolean'))
      throw new E('oauth_state', 'Valid private authorization state required');
    this.nonce = state?.nonce ?? randomBytes(32).toString('base64url');
    this.callbackUsed = state?.callbackUsed ?? false;
    if (state?.verifier) this.saveCodeVerifier(state.verifier);
    if (state?.tokens) this.saveTokens(state.tokens);
    this.authorizationUrl = state?.authorizationUrl;
    this.clientMetadata = { client_name: 'Converoom participant bridge', redirect_uris: [redirectUrl],
      token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: 'room:' + roomId };
  }
  state() { return this.nonce; }
  snapshot(): RoomOAuthState { return { nonce: this.nonce, verifier: this.verifier, tokens: this.tokens(), callbackUsed: this.callbackUsed,
    authorizationUrl: this.authorizationUrl }; }
  clientInformation() { return { client_id: this.clientId, issuer: this.origin }; }
  tokens() { return this.savedTokens ? { ...this.savedTokens } : undefined; }
  saveTokens(tokens: OAuthTokens) {
    if (tokens.issuer !== this.origin) throw new E('issuer', 'Configured token issuer required', 403);
    this.savedTokens = { ...tokens };
  }
  saveCodeVerifier(verifier: string) {
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new E('pkce', 'Valid PKCE verifier required');
    this.verifier = verifier;
  }
  codeVerifier() {
    if (!this.verifier) throw new E('pkce', 'Start the local authorization flow first');
    return this.verifier;
  }
  redirectToAuthorization(url: URL) {
    const q = url.searchParams;
    if (url.origin !== this.origin || url.pathname !== '/authorize' || q.get('state') !== this.nonce ||
      q.get('client_id') !== this.clientId || q.get('redirect_uri') !== this.redirectUrl ||
      q.get('resource') !== this.origin + '/mcp' || q.get('scope') !== 'room:' + this.roomId)
      throw new E('authorization_origin', 'Authorization scope or origin changed', 403);
    this.authorizationUrl = url.href;
  }
  acceptCallback(url: URL) {
    const target = new URL(this.redirectUrl), q = url.searchParams;
    if (this.callbackUsed || url.origin !== target.origin || url.pathname !== target.pathname || url.username || url.password || url.hash ||
      ['code', 'state', 'iss'].some((key) => q.getAll(key).length !== 1) || q.get('state') !== this.nonce || q.get('iss') !== this.origin ||
      !q.get('code') || q.get('code')!.length > 256 || q.has('error'))
      throw new E('oauth_callback', 'Callback state, issuer or redirect rejected', 403);
    this.callbackUsed = true; return q.get('code')!;
  }
  saveDiscoveryState(state: OAuthDiscoveryState) {
    if (String(state.authorizationServerUrl).replace(/\/$/, '') !== this.origin || state.authorizationServerMetadata?.issuer !== this.origin ||
      state.resourceMetadata?.resource !== this.origin + '/mcp' || state.resourceMetadata.authorization_servers?.some((url) => url !== this.origin))
      throw new E('oauth_discovery', 'Configured issuer and resource required', 403);
    const metadata = state.authorizationServerMetadata;
    for (const value of [metadata?.authorization_endpoint, metadata?.token_endpoint,
      metadata && 'revocation_endpoint' in metadata ? metadata.revocation_endpoint : undefined]) {
      if (value && new URL(value).origin !== this.origin) throw new E('oauth_discovery', 'Cross-origin metadata endpoint rejected', 403);
    }
  }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'tokens') this.savedTokens = undefined;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
  }
}
