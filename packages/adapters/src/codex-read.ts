import { launch } from './process.js';
import { RpcPeer } from './rpc.js';
import { managedEntry } from './index.js';
import { ConveroomError as E, type ToolArgs } from '../../shared/src/contracts.js';

// SPEC FR-63 allows reading Codex history only once confirmed as a read. Live check 07/11/2026, codex-cli 0.164.0: thread/read and
// thread/items/list returned history while thread/loaded/list stayed empty and no turn or item notification arrived.
export const CODEX_THREAD_READ_VERIFIED = true;
const CLIENT = { name: 'converoom', version: '0.3.2' };
const WAIT = 30000, PAGES = 20;
// Only initialize, thread/list, thread/read and thread/items/list are sent; nothing starts, resumes, forks or prompts a thread.
async function withCodex<T>(cwd: string, env: NodeJS.ProcessEnv, fn: (rpc: RpcPeer) => Promise<T>): Promise<T> {
  const entry = await managedEntry('codex', env);
  const child = launch(entry.command, [...entry.args, 'app-server', '--stdio'], cwd, env), rpc = new RpcPeer(child);
  child.stderr.resume();
  rpc.requestHandler = async () => { throw new E('unsupported_request', 'Context reads answer no vendor requests'); };
  try {
    await rpc.request('initialize', { clientInfo: CLIENT, capabilities: { experimentalApi: false } }, WAIT);
    rpc.notify('initialized');
    return await fn(rpc);
  } finally {
    child.kill();
  }
}
export function codexThreads(cwd: string, env: NodeJS.ProcessEnv = {}) {
  return withCodex(cwd, env, async (rpc) => {
    const list = await rpc.request('thread/list', { limit: 20 }, WAIT);
    return (Array.isArray(list.data) ? list.data as ToolArgs[] : []).map((t) => ({
      id: String(t.id), preview: String(t.preview ?? '').slice(0, 200), updatedAt: Number(t.updatedAt ?? t.createdAt ?? 0),
    }));
  });
}
const userText = (content: unknown) => (Array.isArray(content) ? content as ToolArgs[] : [])
  .filter((c) => c.type === 'text').map((c) => String(c.text ?? '')).join('\n');
// Keeps the newest user and Codex messages that fit, oldest first; reasoning and tool activity are left out.
export function codexThreadExcerpt(threadId: string, cwd: string, env: NodeJS.ProcessEnv = {}, maxBytes = 262144) {
  return withCodex(cwd, env, async (rpc) => {
    const thread = (await rpc.request('thread/read', { threadId, includeTurns: false }, WAIT)).thread as ToolArgs | undefined;
    if (!thread || thread.id !== threadId) throw new E('not_found', 'Codex thread not found', 404);
    const lines: string[] = [];
    let bytes = 0, cursor: string | null = null, pages = 0, full = false;
    do {
      const page = await rpc.request('thread/items/list', { threadId, limit: 100, sortDirection: 'desc', ...(cursor ? { cursor } : {}) }, WAIT);
      for (const entry of Array.isArray(page.data) ? page.data as ToolArgs[] : []) {
        const item = (entry.item ?? {}) as ToolArgs;
        const text = item.type === 'userMessage' ? userText(item.content) : item.type === 'agentMessage' ? String(item.text ?? '') : '';
        if (!text.trim()) continue;
        const line = (item.type === 'userMessage' ? 'User: ' : 'Codex: ') + text.trim();
        if (bytes + Buffer.byteLength(line) + 2 > maxBytes) { full = true; break; }
        lines.push(line);
        bytes += Buffer.byteLength(line) + 2;
      }
      cursor = !full && typeof page.nextCursor === 'string' ? page.nextCursor : null;
    } while (cursor && ++pages < PAGES);
    return { threadId, title: String(thread.preview ?? '').slice(0, 120) || 'Codex thread', excerpt: lines.reverse().join('\n\n') };
  });
}
