import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { executable, launch, run } from './process.js';
import { RpcPeer } from './rpc.js';
import { ConveroomError, type Product, type ToolArgs } from '../../shared/src/contracts.js';
import { redactPublic } from '../../store/src/index.js';
import { MANAGED_TOOLS, type ManagedMcp } from '../../mcp/src/managed.js';
export interface ManagedSession {
  id: string;
  product: Product;
  capabilities: string[];
  prompt(text: string): Promise<string>;
  cancel(): Promise<void>;
  close(): Promise<boolean>;
}
export type PermissionHandler = (scope: ToolArgs) => Promise<boolean>;
async function bounded<T>(request: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      request,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ConveroomError('protocol_timeout', 'Native protocol request timed out')),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function probeProduct(product: Product, cwd: string): Promise<ToolArgs> {
  try {
    const entry = await executable(product === 'cursor' ? 'agent' : product);
    const version = await run(entry.command, [...entry.args, '--version'], cwd, 15000);
    return {
      product,
      installed: version.exitCode === 0,
      version: version.output.trim().split('\n').at(-1),
      subscription: 'native login required; doctor smoke verifies managed access',
      declared:
        product === 'codex'
          ? ['app-server', 'prompt', 'cancel']
          : product === 'cursor'
            ? ['acp', 'prompt', 'cancel']
            : ['mcp-polling'],
      probed: [],
      tested: [],
      managed:
        product === 'codex' || product === 'cursor'
          ? 'available for explicit smoke'
          : 'MCP polling fallback until native subscription adapter acceptance',
      extraUsage:
        'vendor account settings may enable extra usage; Converoom does not control these',
      quota: 'unknown',
    };
  } catch {
    return {
      product,
      installed: false,
      managed: 'MCP polling fallback',
      repair:
        'Install ' +
        (product === 'cursor' ? 'Cursor CLI' : product) +
        ' using the vendor instructions, then sign in natively',
      subscription: 'unknown',
      probed: [],
      tested: [],
    };
  }
}
export async function startManaged(
  product: Product,
  cwd: string,
  onPermission: PermissionHandler,
  env: NodeJS.ProcessEnv = {},
  readOnly = true,
  mcp?: ManagedMcp,
): Promise<ManagedSession> {
  const entry = await executable(product === 'cursor' ? 'agent' : product);
  if (product === 'codex') {
    const mcpArgs = mcp ? [
      '-c', 'mcp_servers.converoom.command=' + JSON.stringify(mcp.command),
      '-c', 'mcp_servers.converoom.args=[' + mcp.args.map((arg) => JSON.stringify(arg)).join(',') + ']',
      '-c', 'mcp_servers.converoom.enabled=true',
      '-c', 'mcp_servers.converoom.required=true',
      '-c', 'mcp_servers.converoom.enabled_tools=[' + [...MANAGED_TOOLS].map((name) => JSON.stringify(name)).join(',') + ']',
    ] : [];
    const child = launch(entry.command, [...entry.args, ...mcpArgs, 'app-server', '--stdio'], cwd, env),
      rpc = new RpcPeer(child);
    rpc.requestHandler = async (method, p) => {
      if (method.includes('requestApproval')) {
        const approved = await onPermission({ method, ...p });
        return { decision: approved ? 'accept' : 'decline' };
      }
      if (method.includes('requestUserInput')) return { answers: {} };
      throw new ConveroomError('unsupported_request', 'Unsupported native request');
    };
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'converoom', version: '0.2.0' },
        capabilities: { experimentalApi: false },
      });
      rpc.notify('initialized');
      const account = await rpc.request('account/read', { refreshToken: false });
      const auth = account.account as ToolArgs | null;
      if (!auth || auth.type !== 'chatgpt') {
        child.kill();
        throw new ConveroomError(
          'subscription_required',
          'Sign in with ChatGPT using codex login. API/unknown accounts are not enabled in V1',
          403,
        );
      }
      const result = await rpc.request('thread/start', {
        cwd,
        modelProvider: 'openai',
        sandbox: readOnly ? 'read-only' : 'workspace-write',
        approvalPolicy: 'on-request',
        ephemeral: false,
        developerInstructions:
          'Participate in a Converoom room. Return only the public answer, preserve dissent, follow the assigned workspace and task scope. Use the supplied Converoom MCP tools for public room context and directed replies. Do not commit, push, deploy or use a separately billed API provider. Native tools are trusted local; no containment promise.',
      });
      const thread = result.thread as ToolArgs,
        id = String(thread.id);
      let turnId = '';
      let finish: ((result: string) => void) | undefined;
      let fail: ((e: Error) => void) | undefined;
      let publicReply = '';
      rpc.events.on('item/completed', (p: ToolArgs) => {
        const item = p.item as ToolArgs;
        if (item?.type === 'agentMessage' && typeof item.text === 'string')
          publicReply += item.text;
      });
      rpc.events.on('turn/completed', (p: ToolArgs) => {
        const t = p.turn as ToolArgs;
        if (t.status === 'completed') finish?.(redactPublic(publicReply));
        else fail?.(new ConveroomError('vendor_turn_failed', 'Vendor turn ' + String(t.status)));
        finish = undefined;
        fail = undefined;
      });
      rpc.events.on('disconnected', (e: Error) => fail?.(e));
      return {
        id,
        product,
        capabilities: ['prompt', 'cancel'],
        prompt: async (text) => {
          publicReply = '';
          const completed = new Promise<string>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
          try {
            const response = await rpc.request('turn/start', {
              threadId: id,
              cwd,
              input: [{ type: 'text', text, text_elements: [] }],
            });
            turnId = String((response.turn as ToolArgs).id);
            return completed;
          } catch (e) {
            finish = undefined;
            fail = undefined;
            throw e;
          }
        },
        cancel: async () => {
          if (turnId) await rpc.request('turn/interrupt', { threadId: id, turnId });
        },
        close: async () => {
          child.kill();
          return new Promise((resolve) => {
            if (child.exitCode !== null) return resolve(true);
            const timer = setTimeout(() => resolve(false), 5000);
            child.once('close', () => {
              clearTimeout(timer);
              resolve(true);
            });
          });
        },
      };
    } catch (e) {
      child.kill();
      throw e;
    }
  }
  if (product === 'cursor') {
    const child = launch(entry.command, [...entry.args, 'acp'], cwd, env);
    let reply = '';
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
    const client = acp
      .client({ name: 'converoom' })
      .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
        const allowed = await onPermission({
          sessionId: ctx.params.sessionId,
          toolCall: redactPublic(ctx.params.toolCall),
          options: ctx.params.options,
        });
        const option = ctx.params.options.find(
          (o) => o.kind === (allowed ? 'allow_once' : 'reject_once'),
        );
        return option
          ? { outcome: { outcome: 'selected' as const, optionId: option.optionId } }
          : { outcome: { outcome: 'cancelled' as const } };
      })
      .onNotification(acp.methods.client.session.update, (ctx) => {
        const u = ctx.params.update;
        if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text')
          reply += u.content.text;
      });
    const connection = client.connect(stream);
    try {
      await bounded(
        connection.agent.request(acp.methods.agent.initialize, {
          protocolVersion: acp.PROTOCOL_VERSION,
          clientInfo: { name: 'converoom', version: '0.2.0' },
          clientCapabilities: {},
        }),
        30000,
      );
      const sessionParams: acp.NewSessionRequest = { cwd, mcpServers: mcp ? [{
        name: mcp.name, command: mcp.command, args: mcp.args, env: mcp.env,
      }] : [] };
      const session = await bounded(
        connection.agent.request(acp.methods.agent.session.new, sessionParams),
        30000,
      );
      if (readOnly && session.modes?.availableModes.some((m) => m.id === 'ask' || m.id === 'plan'))
        await connection.agent.request(acp.methods.agent.session.setMode, {
          sessionId: session.sessionId,
          modeId: session.modes.availableModes.find((m) => m.id === 'ask' || m.id === 'plan')!.id,
        });
      return {
        id: session.sessionId,
        product,
        capabilities: ['prompt', 'cancel'],
        prompt: async (text) => {
          reply = '';
          const result = await bounded(
            connection.agent.request(acp.methods.agent.session.prompt, {
              sessionId: session.sessionId,
              prompt: [{ type: 'text', text }],
            }),
            1800000,
          );
          if (result.stopReason === 'cancelled')
            throw new ConveroomError('cancelled', 'Vendor confirmed cancellation');
          return redactPublic(reply);
        },
        cancel: async () => {
          await connection.agent.notify(acp.methods.agent.session.cancel, {
            sessionId: session.sessionId,
          });
        },
        close: async () => {
          connection.close();
          child.kill();
          return new Promise((resolve) => {
            if (child.exitCode !== null) return resolve(true);
            const timer = setTimeout(() => resolve(false), 5000);
            child.once('close', () => {
              clearTimeout(timer);
              resolve(true);
            });
          });
        },
      };
    } catch (e) {
      connection.close();
      child.kill();
      throw e;
    }
  }
  throw new ConveroomError(
    'managed_unsupported',
    'This product participates through MCP polling in V1 until its native subscription route is tested',
    409,
  );
}
