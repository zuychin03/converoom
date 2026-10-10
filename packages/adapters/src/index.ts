import { isAbsolute } from 'node:path';
import { executable, launch, run } from './process.js';
import { startAcp } from './acp.js';
import { RpcPeer } from './rpc.js';
import { ConveroomError, type Product, type ToolArgs } from '../../shared/src/contracts.js';
import { redactPublic } from '../../store/src/index.js';
import { MANAGED_TOOLS, type ManagedMcp } from '../../mcp/src/managed.js';
import { PRODUCT_PROFILES, isManagedProduct } from '../../shared/src/products.js';
export interface ManagedSession {
  id: string;
  product: Product;
  capabilities: string[];
  prompt(text: string): Promise<string>;
  cancel(): Promise<void>;
  close(): Promise<boolean>;
}
export type PermissionHandler = (scope: ToolArgs) => Promise<boolean>;
async function managedEntry(product: Product, env: NodeJS.ProcessEnv = {}) {
  const override = product === 'antigravity' ? env.CONVEROOM_ANTIGRAVITY_ACP ?? process.env.CONVEROOM_ANTIGRAVITY_ACP : undefined;
  if (override && !isAbsolute(override))
    throw new ConveroomError('invalid_executable', 'CONVEROOM_ANTIGRAVITY_ACP must be an absolute native executable path');
  const profile = PRODUCT_PROFILES[product];
  const entry = await executable(override ?? profile.managedCommand ?? profile.command);
  return { command: entry.command, args: [...entry.args, ...profile.managedArgs] };
}
export async function probeProduct(product: Product, cwd: string): Promise<ToolArgs> {
  const profile = PRODUCT_PROFILES[product];
  let installed = false, version: string | undefined, managedInstalled = false;
  try {
    const entry = await executable(profile.command);
    const result = await run(entry.command, [...entry.args, '--version'], cwd, 15000);
    installed = result.exitCode === 0;
    version = result.output.trim().split('\n').at(-1);
  } catch { /* Report missing native clients without starting inference. */ }
  if (isManagedProduct(product)) {
    try { await managedEntry(product); managedInstalled = true; }
    catch { /* The CLI and ACP server can be separate installations. */ }
  }
  return {
    product, installed, version, managedInstalled,
    subscription: 'unknown; native login and explicit managed smoke required',
    declared: isManagedProduct(product) ? [profile.protocol, 'prompt', 'cancel', 'mcp-polling'] : ['mcp-polling'],
    probed: [], tested: [],
    managed: !isManagedProduct(product) ? 'MCP polling; managed adapter deferred' : managedInstalled ? 'available for explicit smoke; vendor acceptance unverified' : 'MCP polling only; managed executable unavailable',
    ...(!installed || (isManagedProduct(product) && !managedInstalled) ? {
      repair: 'Install ' + profile.label + (profile.managedCommand ? ' and its official ACP server' : '') + ' using vendor instructions, then sign in natively',
    } : {}),
    extraUsage: 'vendor account settings may enable extra usage; Converoom does not control these', quota: 'unknown',
  };
}
export async function startManaged(
  product: Product,
  cwd: string,
  onPermission: PermissionHandler,
  env: NodeJS.ProcessEnv = {},
  readOnly = true,
  mcp?: ManagedMcp,
): Promise<ManagedSession> {
  if (!isManagedProduct(product)) throw new ConveroomError('managed_unsupported', 'This product participates through MCP polling; its managed adapter is unavailable', 409);
  const entry = await managedEntry(product, env);
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
  return startAcp(product, entry, cwd, onPermission, env, readOnly, mcp);
}
