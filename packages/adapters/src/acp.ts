import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { launch } from './process.js';
import { ConveroomError, type AppliedProfile, type Product, type SeatProfile } from '../../shared/src/contracts.js';
import { PRODUCT_PROFILES } from '../../shared/src/products.js';
import { redactPublic } from '../../store/src/index.js';
import type { ManagedMcp } from '../../mcp/src/managed.js';
import type { ManagedSession, PermissionHandler } from './index.js';
import { mountAcpWorkspace } from './acp-workspace.js';
import { offers, resolveEffort, unsupported, type Offered } from './profile.js';

// Positive evidence that a prompt never began executing; any other failure after sending leaves its outcome unknown.
export const notStarted = <T extends Error>(error: T) => Object.assign(error, { notStarted: true as const });
// Evidence that a session refused at startup left no native process running.
export const stopped = (error: unknown, confirmed: boolean) => confirmed && error instanceof Error ? Object.assign(error, { stopped: true as const }) : error;
// JSON-RPC refusals of the request itself; -32000 is ACP's authentication-required code.
const REFUSED = new Set([-32700, -32600, -32601, -32602, -32000]);
// -32800 is an agent aborting the request, which some agents send instead of a cancelled stop reason.
function promptFailure(error: unknown): never {
  const code = (error as { code?: unknown }).code;
  if (code === -32800) throw new ConveroomError('cancelled', 'Vendor confirmed cancellation');
  throw typeof code === 'number' && REFUSED.has(code) ? notStarted(error as Error) : error;
}

export async function bounded<T>(request: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ConveroomError('protocol_timeout', 'Native protocol request timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Native login method IDs these vendors document; selecting one refuses API-key authentication.
export const NATIVE_AUTH: Partial<Record<Product, string>> = { grok: 'cached_token', antigravity: 'oauth-personal', cursor: 'cursor_login' };

const KINDS = { model: { category: 'model', ids: ['model'] }, effort: { category: 'thought_level', ids: ['thought_level', 'reasoning_effort', 'effort'] } };
const optionFor = (options: acp.SessionConfigOption[], kind: keyof typeof KINDS) =>
  options.find((o) => o.type === 'select' && (o.category === KINDS[kind].category || KINDS[kind].ids.includes(o.id)));
const choices = (o: acp.SessionConfigOption): Offered[] => o.type !== 'select' ? [] : (o.options as Array<acp.SessionConfigSelectOption | acp.SessionConfigSelectGroup>)
  .flatMap((v) => 'group' in v ? v.options : [v]).map((v) => ({ value: v.value, name: v.name }));

// FR-56: the agent's advertised session config options are the only source; a choice it does not offer or does not keep is refused.
async function applyProfile(connection: acp.ClientConnection, sessionId: string, product: Product, profile: SeatProfile,
  initial: acp.SessionConfigOption[]): Promise<AppliedProfile> {
  const label = PRODUCT_PROFILES[product].label;
  let options = initial;
  const choose = async (kind: keyof typeof KINDS, wanted: string, pick: (offered: Offered[]) => string | undefined) => {
    const option = optionFor(options, kind);
    if (!option) throw unsupported(`${label} offers no ${kind} choice to Converoom`);
    const offered = choices(option), value = pick(offered);
    if (!value) throw unsupported(kind === 'model'
      ? `${label} does not offer the model ${wanted}. It offers: ${offers(offered.map((o) => o.value))}`
      : `${label} does not offer ${wanted} effort. It offers: ${offers(offered.map((o) => o.value))}`);
    if (option.currentValue !== value)
      options = (await bounded(connection.agent.request(acp.methods.agent.session.setConfigOption, { sessionId, configId: option.id, value }), 30000)).configOptions;
    const kept = optionFor(options, kind)?.currentValue;
    if (kept !== value) throw unsupported(`${label} kept ${kind} ${String(kept)} instead of ${value}`);
  };
  if (profile.model) await choose('model', profile.model, (offered) => offered.find((o) => o.value === profile.model || o.name === profile.model)?.value);
  if (profile.effort) await choose('effort', profile.effort, (offered) => resolveEffort(profile.effort!, offered));
  const model = optionFor(options, 'model')?.currentValue, effort = optionFor(options, 'effort')?.currentValue;
  return { ...(typeof model === 'string' ? { model } : {}), ...(typeof effort === 'string' ? { effort } : {}) };
}

export async function startAcp(
  product: Product, entry: { command: string; args: string[] }, cwd: string,
  onPermission: PermissionHandler, env: NodeJS.ProcessEnv, readOnly: boolean, mcp?: ManagedMcp, profile?: SeatProfile,
): Promise<ManagedSession> {
  let id = '', reply = '', replyBytes = 0, active = false, closed = false, cancelled = false;
  const client = acp.client({ name: 'converoom' })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      if (!active || ctx.params.sessionId !== id || closed || cancelled)
        return { outcome: { outcome: 'cancelled' as const } };
      const allowed = await onPermission(redactPublic({ ...ctx.params }));
      if (!active || closed || cancelled) return { outcome: { outcome: 'cancelled' as const } };
      const option = ctx.params.options.find((o) => o.kind === (allowed ? 'allow_once' : 'reject_once'));
      return option ? { outcome: { outcome: 'selected' as const, optionId: option.optionId } }
        : { outcome: { outcome: 'cancelled' as const } };
    })
    .onNotification(acp.methods.client.session.update, (ctx) => {
      const u = ctx.params.update;
      if (active && ctx.params.sessionId === id && u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text') {
        replyBytes += Buffer.byteLength(u.content.text, 'utf8');
        if (replyBytes > 1048576) {
          connection.close(new ConveroomError('output_limit', 'Native public response exceeded 1 MiB'));
          child.kill();
        } else reply += u.content.text;
      }
    });
  const workspace = await mountAcpWorkspace(client, cwd, !readOnly, async (sessionId, scope) => {
    const current = () => active && !closed && !cancelled && sessionId === id;
    if (!current()) throw new ConveroomError('client_scope', 'Client request does not belong to an active coding prompt');
    if (scope && !await onPermission(redactPublic({ sessionId, ...scope })))
      throw new ConveroomError('permission_denied', 'Workspace client request was denied');
    if (!current()) throw new ConveroomError('client_scope', 'Client request approval is no longer active');
  }, env);
  const child = launch(entry.command, entry.args, cwd, env);
  child.stderr.resume();
  const stream = acp.ndJsonStream(
    Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
  );
  const connection = client.connect(stream);
  child.once('error', (error) => connection.close(error));
  child.once('close', () => connection.close(new ConveroomError('vendor_disconnected', 'Native process disconnected')));
  const close = async () => {
    closed = true; active = false; connection.close(); child.kill();
    const agentStopped = await new Promise<boolean>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
      const timer = setTimeout(() => resolve(false), 5000);
      child.once('close', () => { clearTimeout(timer); resolve(true); });
    });
    return await workspace.stop() && agentStopped;
  };
  try {
    const initParams: acp.InitializeRequest = {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientInfo: { name: 'converoom', version: '0.2.0' }, clientCapabilities: workspace.capabilities,
    };
    const init = await bounded(connection.agent.request(acp.methods.agent.initialize, initParams), 60000);
    if (init.protocolVersion !== acp.PROTOCOL_VERSION)
      throw new ConveroomError('protocol_version', 'Native agent negotiated an incompatible ACP version');
    const methodId = NATIVE_AUTH[product];
    if (methodId) {
      const method = init.authMethods?.find((m) => m.id === methodId && !('type' in m && m.type === 'terminal'));
      if (!method) throw new ConveroomError('subscription_required', 'Native ' + methodId + ' authentication is required; API authentication is disabled', 403);
      await bounded(connection.agent.request(acp.methods.agent.authenticate, {
        methodId, ...(product === 'grok' ? { _meta: { headless: true } } : {}),
      }), 30000);
    }
    const sessionParams: acp.NewSessionRequest = {
      cwd, mcpServers: mcp ? [{ name: mcp.name, command: mcp.command, args: mcp.args, env: mcp.env }] : [],
    };
    const session = await bounded(connection.agent.request(acp.methods.agent.session.new, sessionParams), 30000);
    id = session.sessionId;
    const mode = session.modes?.availableModes.find((m) => ['ask', 'plan', 'planner', 'read-only'].includes(m.id));
    if (readOnly && mode) await bounded(connection.agent.request(acp.methods.agent.session.setMode, {
      sessionId: id, modeId: mode.id,
    }), 30000);
    const applied = profile ? await applyProfile(connection, id, product, profile, session.configOptions ?? []) : undefined;
    return {
      id, product, ...(applied ? { profile: applied } : {}), capabilities: ['prompt', 'cancel', ...(!readOnly ? ['client-files', 'client-terminal'] : [])],
      prompt: async (text) => {
        if (closed) throw notStarted(new ConveroomError('vendor_disconnected', 'Native session is closed'));
        if (active) throw notStarted(new ConveroomError('session_busy', 'A native prompt is already running'));
        reply = ''; replyBytes = 0; active = true; cancelled = false;
        try {
          const result = await bounded(connection.agent.request(acp.methods.agent.session.prompt, {
            sessionId: id, prompt: [{ type: 'text', text }],
          }).catch(promptFailure), 1800000);
          if (result.stopReason === 'cancelled') throw new ConveroomError('cancelled', 'Vendor confirmed cancellation');
          if (result.stopReason !== 'end_turn')
            throw new ConveroomError('vendor_turn_failed', 'Native turn stopped: ' + result.stopReason);
          return redactPublic(reply);
        } finally { active = false; await workspace.stop(); }
      },
      cancel: async () => {
        if (active && !closed) { cancelled = true; await connection.agent.notify(acp.methods.agent.session.cancel, { sessionId: id }); }
        await workspace.stop();
      },
      close,
    };
  } catch (error) { throw stopped(error, await close()); }
}
