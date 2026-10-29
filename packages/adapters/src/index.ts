import { isAbsolute } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { executable, launch, run } from './process.js';
import { notStarted, startAcp, stopped } from './acp.js';
import { offers, resolveEffort, unsupported } from './profile.js';
import { RpcPeer } from './rpc.js';
import { ConveroomError, type AppliedProfile, type Effort, type Product, type SeatProfile, type ToolArgs } from '../../shared/src/contracts.js';
import { redactPublic } from '../../store/src/index.js';
import { MANAGED_TOOLS, type ManagedMcp } from '../../mcp/src/managed.js';
import { PRODUCT_PROFILES, isManagedProduct } from '../../shared/src/products.js';
export interface ManagedSession {
  id: string;
  product: Product;
  capabilities: string[];
  profile?: AppliedProfile;
  // A rejection marked notStarted proves the prompt never began; any other rejection after sending leaves the outcome unknown.
  prompt(text: string): Promise<string>;
  cancel(): Promise<void>;
  close(): Promise<boolean>;
}
export type PermissionHandler = (scope: ToolArgs) => Promise<boolean>;
export async function managedEntry(product: Product, env: NodeJS.ProcessEnv = {}) {
  const override = product === 'antigravity' ? env.CONVEROOM_ANTIGRAVITY_ACP ?? process.env.CONVEROOM_ANTIGRAVITY_ACP : undefined;
  if (override && !isAbsolute(override))
    throw new ConveroomError('invalid_executable', 'CONVEROOM_ANTIGRAVITY_ACP must be an absolute native executable path');
  const profile = PRODUCT_PROFILES[product];
  const entry = await executable(override ?? profile.managedCommand ?? profile.command);
  return { command: entry.command, args: [...entry.args, ...profile.managedArgs] };
}
// What a managed session verifies before inference; the account plan itself stays with the vendor.
export function authCheck(product: Product): string {
  const label = PRODUCT_PROFILES[product].label;
  if (!isManagedProduct(product)) return 'Not applicable: ' + label + ' joins through its own MCP conversation and keeps its own sign-in.';
  if (product === 'codex') return 'Managed sessions refuse unless the Codex app server reports a ChatGPT sign-in.';
  if (product === 'grok') return 'Managed sessions authenticate only with the advertised cached native token.';
  if (product === 'antigravity') return 'Managed sessions authenticate only with the advertised personal Google OAuth method.';
  if (product === 'cursor') return 'Managed sessions authenticate only with the advertised cursor_login method; API keys and auth tokens are removed.';
  if (product === 'kiro') return 'Managed sessions start Kiro with --auth-method=cli, so the CLI keeps its own sign-in. Confirm the account plan in Kiro.';
  return 'Not verified by Converoom: managed sessions use the ' + label + ' CLI\'s own login with its token variable removed. Confirm the account plan in ' + label + '.';
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
    authCheck: authCheck(product),
    declared: isManagedProduct(product) ? [profile.protocol, 'prompt', 'cancel', 'mcp-polling'] : ['mcp-polling'],
    probed: [], tested: [],
    managed: !isManagedProduct(product) ? 'MCP polling; managed adapter deferred' : managedInstalled ? 'available for explicit smoke; vendor acceptance unverified' : 'MCP polling only; managed executable unavailable',
    ...(!installed || (isManagedProduct(product) && !managedInstalled) ? {
      repair: 'Install ' + profile.label + (profile.managedCommand ? ' and its official ACP server' : '') + ' using vendor instructions, then sign in natively',
    } : {}),
    extraUsage: 'vendor account settings may enable extra usage; Converoom does not control these', quota: 'unknown',
  };
}
const exited = (child: ChildProcess) => new Promise<boolean>((resolve) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
  const timer = setTimeout(() => resolve(false), 5000);
  child.once('close', () => { clearTimeout(timer); resolve(true); });
});
async function codexModels(rpc: RpcPeer) {
  const models: ToolArgs[] = [];
  let cursor: unknown;
  for (let page = 0; page < 5; page++) {
    const list = await rpc.request('model/list', { includeHidden: true, ...(typeof cursor === 'string' ? { cursor } : {}) });
    if (Array.isArray(list.data)) models.push(...(list.data as ToolArgs[]));
    cursor = list.nextCursor;
    if (typeof cursor !== 'string') break;
  }
  return models;
}
const modelName = (m: ToolArgs) => String(m.model ?? m.id);
function codexEffort(models: ToolArgs[], model: string, level: Effort) {
  const entry = models.find((m) => m.id === model || m.model === model);
  const levels = Array.isArray(entry?.supportedReasoningEfforts)
    ? (entry.supportedReasoningEfforts as ToolArgs[]).map((o) => ({ value: String(o.reasoningEffort) })) : [];
  const effort = resolveEffort(level, levels);
  if (!effort) throw unsupported(`${model} does not offer ${level} effort. It offers: ${offers(levels.map((l) => l.value))}`);
  return effort;
}
export async function startManaged(
  product: Product,
  cwd: string,
  onPermission: PermissionHandler,
  env: NodeJS.ProcessEnv = {},
  readOnly = true,
  mcp?: ManagedMcp,
  profile?: SeatProfile,
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
      // FR-56: checked against this Codex's own model list before the prompt; nothing falls back to another model or level.
      const models = profile?.model || profile?.effort ? await codexModels(rpc) : [];
      const named = profile?.model ? models.find((m) => m.id === profile.model || m.model === profile.model) : undefined;
      if (profile?.model && !named) throw unsupported(`Codex does not offer the model ${profile.model}. It offers: ${
        offers(models.filter((m) => m.hidden !== true).map(modelName))}`);
      let effort = named && profile?.effort ? codexEffort(models, modelName(named), profile.effort) : undefined;
      const result = await rpc.request('thread/start', {
        cwd,
        ...(named ? { model: modelName(named) } : {}),
        modelProvider: 'openai',
        sandbox: readOnly ? 'read-only' : 'workspace-write',
        approvalPolicy: 'on-request',
        ephemeral: false,
        developerInstructions:
          'Participate in a Converoom room. Return only the public answer, preserve dissent, follow the assigned workspace and task scope. Use the supplied Converoom MCP tools for public room context and directed replies. Do not commit, push, deploy or use a separately billed API provider. Native tools are trusted local; no containment promise.',
      });
      const model = typeof result.model === 'string' ? result.model : undefined;
      if (named && model !== modelName(named)) throw unsupported(`Codex started ${model ?? 'an unnamed model'} instead of ${modelName(named)}`);
      if (profile?.effort && !effort) {
        if (!model) throw unsupported('Codex did not say which model it started, so the effort cannot be checked');
        effort = codexEffort(models, model, profile.effort);
      }
      const applied: AppliedProfile = { ...(model ? { model } : {}), ...(effort ? { effort } : {}) };
      const thread = result.thread as ToolArgs,
        id = String(thread.id);
      let turnId = '', interrupt = false;
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
        else fail?.(t.status === 'interrupted' ? new ConveroomError('cancelled', 'Vendor confirmed cancellation')
          : new ConveroomError('vendor_turn_failed', 'Vendor turn ' + String(t.status)));
        finish = undefined;
        fail = undefined;
      });
      rpc.events.on('disconnected', (e: Error) => fail?.(e));
      return {
        id,
        product,
        ...(model ? { profile: applied } : {}),
        capabilities: ['prompt', 'cancel'],
        prompt: async (text) => {
          publicReply = '';
          turnId = '';
          interrupt = false;
          const completed = new Promise<string>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          });
          try {
            const response = await rpc.request('turn/start', {
              threadId: id,
              cwd,
              input: [{ type: 'text', text, text_elements: [] }],
              ...(effort ? { effort } : {}),
            });
            turnId = String((response.turn as ToolArgs).id);
            // A cancel requested before the turn had an ID still has to reach it.
            if (interrupt) void rpc.request('turn/interrupt', { threadId: id, turnId }).catch(() => {});
            return completed;
          } catch (e) {
            finish = undefined;
            fail = undefined;
            // An error response is app-server refusing to start the turn; a timeout or disconnect proves nothing.
            throw e instanceof ConveroomError && e.code === 'vendor_error' ? notStarted(e) : e;
          }
        },
        cancel: async () => {
          interrupt = true;
          if (turnId) await rpc.request('turn/interrupt', { threadId: id, turnId });
        },
        close: async () => {
          child.kill();
          return exited(child);
        },
      };
    } catch (e) {
      child.kill();
      throw stopped(e, await exited(child));
    }
  }
  return startAcp(product, entry, cwd, onPermission, env, readOnly, mcp, profile);
}
