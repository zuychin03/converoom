import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { executable, launch, run } from './process.js';
import { RpcPeer } from './rpc.js';
import { NATIVE_AUTH, bounded } from './acp.js';
import { managedEntry } from './index.js';
import { PRODUCT_IDS, PRODUCT_PROFILES, isManagedProduct, type Product } from '../../shared/src/products.js';
import { ConveroomError, type ToolArgs } from '../../shared/src/contracts.js';

export type Readiness = 'ready_managed' | 'ready_polling' | 'needs_login' | 'needs_mcp_registration' | 'not_installed';
export type SignIn = 'signed_in' | 'signed_out' | 'not_checked' | 'not_applicable';
export interface Harness {
  product: Product;
  status: Readiness;
  installed: boolean;
  version?: string;
  signIn: SignIn;
  registered: boolean;
  models?: string[];
  // Why a managed-capable product can only join by polling.
  managedIssue?: string;
  detail: string;
}
export interface Discovery { at: number; harnesses: Harness[] }
type Handshake = { signIn: SignIn; models?: string[]; blocked?: string } | { failed: string };
const CLIENT = { name: 'converoom', version: '0.2.0' };

// FR-62: no thread, session or prompt is started, nothing is authenticated or refreshed, and no account detail is kept.
async function codexHandshake(entry: { command: string; args: string[] }, cwd: string, env: NodeJS.ProcessEnv, waitMs: number): Promise<Handshake> {
  const child = launch(entry.command, [...entry.args, 'app-server', '--stdio'], cwd, env), rpc = new RpcPeer(child);
  child.stderr.resume();
  rpc.requestHandler = async () => { throw new ConveroomError('unsupported_request', 'Discovery answers no vendor requests'); };
  try {
    await rpc.request('initialize', { clientInfo: CLIENT, capabilities: { experimentalApi: false } }, waitMs);
    rpc.notify('initialized');
    const account = (await rpc.request('account/read', { refreshToken: false }, waitMs)).account as ToolArgs | null;
    const list = await rpc.request('model/list', {}, waitMs).catch(() => undefined);
    const models = Array.isArray(list?.data)
      ? list.data.map((m) => (m as ToolArgs).id).filter((id): id is string => typeof id === 'string').slice(0, 50) : undefined;
    return { signIn: account?.type === 'chatgpt' ? 'signed_in' : 'signed_out', ...(models ? { models } : {}) };
  } finally { child.kill(); }
}

async function acpHandshake(product: Product, entry: { command: string; args: string[] }, cwd: string, env: NodeJS.ProcessEnv,
  waitMs: number): Promise<Handshake> {
  const child = launch(entry.command, entry.args, cwd, env);
  child.stderr.resume();
  const connection = acp.client({ name: 'converoom' }).connect(acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  child.once('error', (error) => connection.close(error));
  try {
    const params: acp.InitializeRequest = { protocolVersion: acp.PROTOCOL_VERSION, clientInfo: CLIENT, clientCapabilities: {} };
    const init = await bounded(connection.agent.request(acp.methods.agent.initialize, params), waitMs) as acp.InitializeResponse;
    if (init.protocolVersion !== acp.PROTOCOL_VERSION) return { failed: 'it negotiated an incompatible ACP version' };
    const method = NATIVE_AUTH[product];
    if (method && !init.authMethods?.some((m) => m.id === method && !('type' in m && m.type === 'terminal')))
      return { signIn: 'not_checked', blocked: `does not offer its native ${method} sign-in, and managed sessions do not use API keys` };
    return { signIn: 'not_checked' };
  } finally { connection.close(); child.kill(); }
}

const failure = (e: unknown, waitMs: number) => e instanceof ConveroomError && ['protocol_timeout', 'vendor_timeout'].includes(e.code)
  ? `it did not answer within ${Math.ceil(waitMs / 1000)} s` : 'its handshake failed: ' + (e instanceof Error ? e.message : 'unknown error');

export function polling(h: Omit<Harness, 'status' | 'detail'>): Harness {
  const label = PRODUCT_PROFILES[h.product].label, why = h.managedIssue ? `${label}'s managed route is unavailable: ${h.managedIssue}. ` : '';
  return h.registered
    ? { ...h, status: 'ready_polling', detail: why + `${label} can join rooms through its own MCP conversation.` }
    : { ...h, status: 'needs_mcp_registration', detail: why + `${label} is installed but not connected to Converoom. Connect it to join rooms.` };
}

function classify(product: Product, installed: boolean, version: string | undefined, registered: boolean, handshake?: Handshake): Harness {
  const label = PRODUCT_PROFILES[product].label, base = { product, installed, ...(version ? { version } : {}), registered };
  if (!installed) return { ...base, status: 'not_installed', signIn: 'not_applicable', detail: `${label} is not installed on this machine.` };
  if (handshake && !('failed' in handshake)) {
    const known = { ...base, signIn: handshake.signIn, ...(handshake.models ? { models: handshake.models } : {}) };
    if (handshake.signIn === 'signed_out')
      return { ...known, status: 'needs_login', detail: `${label} is not signed in. Sign in through ${label}, then discover again.` };
    if (handshake.blocked)
      return { ...known, status: 'needs_login', detail: `${label} ${handshake.blocked}. Sign in through ${label}, then discover again.` };
    return { ...known, status: 'ready_managed', detail: handshake.signIn === 'signed_in'
      ? `${label} can start managed sessions with its own sign-in.`
      : `${label} can start managed sessions. Its sign-in is checked when a managed turn starts.` };
  }
  return polling({ ...base, signIn: isManagedProduct(product) ? 'not_checked' : 'not_applicable',
    ...(handshake ? { managedIssue: handshake.failed } : {}) });
}

async function discoverProduct(product: Product, cwd: string, registered: (product: Product) => Promise<boolean>,
  env: NodeJS.ProcessEnv, waitMs: number): Promise<Harness> {
  const profile = PRODUCT_PROFILES[product];
  let cli = false, version: string | undefined, handshake: Handshake | undefined;
  try {
    const entry = await executable(profile.command);
    const result = await run(entry.command, [...entry.args, '--version'], cwd, waitMs, env);
    cli = result.exitCode === 0;
    if (cli) version = result.output.trim().split('\n').at(-1);
  } catch { /* Not installed. */ }
  if (isManagedProduct(product)) {
    const entry = await managedEntry(product, env).catch(() => undefined);
    if (entry) handshake = await (product === 'codex' ? codexHandshake(entry, cwd, env, waitMs) : acpHandshake(product, entry, cwd, env, waitMs))
      .catch((e: unknown) => ({ failed: failure(e, waitMs) }));
    else if (cli && profile.managedCommand) handshake = { failed: `its ${profile.managedCommand} ACP server is not installed` };
  }
  return classify(product, cli || !!handshake, version, await registered(product), handshake);
}

// Runs only on an explicit owner request; each product's probes are bounded and all products run at once.
export async function discover(cwd: string, registered: (product: Product) => Promise<boolean>,
  { env = {}, waitMs = 20000 }: { env?: NodeJS.ProcessEnv; waitMs?: number } = {}): Promise<Discovery> {
  return { at: Date.now(), harnesses: await Promise.all(PRODUCT_IDS.map((p) => discoverProduct(p, cwd, registered, env, waitMs))) };
}
