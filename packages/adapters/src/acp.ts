import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { launch } from './process.js';
import { ConveroomError, type Product } from '../../shared/src/contracts.js';
import { redactPublic } from '../../store/src/index.js';
import type { ManagedMcp } from '../../mcp/src/managed.js';
import type { ManagedSession, PermissionHandler } from './index.js';
import { mountAcpWorkspace } from './acp-workspace.js';

async function bounded<T>(request: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([request, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ConveroomError('protocol_timeout', 'Native protocol request timed out')), ms);
    })]);
  } finally { clearTimeout(timer); }
}

export async function startAcp(
  product: Product, entry: { command: string; args: string[] }, cwd: string,
  onPermission: PermissionHandler, env: NodeJS.ProcessEnv, readOnly: boolean, mcp?: ManagedMcp,
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
    if (product === 'grok' || product === 'antigravity') {
      const methodId = product === 'grok' ? 'cached_token' : 'oauth-personal';
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
    return {
      id, product, capabilities: ['prompt', 'cancel', ...(!readOnly ? ['client-files', 'client-terminal'] : [])],
      prompt: async (text) => {
        if (closed) throw new ConveroomError('vendor_disconnected', 'Native session is closed');
        if (active) throw new ConveroomError('session_busy', 'A native prompt is already running');
        reply = ''; replyBytes = 0; active = true; cancelled = false;
        try {
          const result = await bounded(connection.agent.request(acp.methods.agent.session.prompt, {
            sessionId: id, prompt: [{ type: 'text', text }],
          }), 1800000);
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
  } catch (error) { await close(); throw error; }
}
