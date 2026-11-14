import { planPushes, type OpenCodeAction, type OpenCodeServerState } from '../../../packages/core/src/attachments.js';
import type { Store } from '../../../packages/shared/src/contracts.js';

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
interface Stream { principalId: string; write(text: string): void; close(): void }
interface OpenCodeBridge { state(): OpenCodeServerState; perform(actions: OpenCodeAction[]): void; sync(): void }

// FR-40: each Claude Code MCP process holds one wake stream; wakes go only to the session an owner attached.
// OpenCode wakes are posted to Converoom's own OpenCode server instead.
export function createWakeHub(store: Store, tickMs = 250, opencode?: OpenCodeBridge) {
  const streams = new Map<string, Stream>(), principals = new Map<string, string>(), seen = new Map<string, number>(), since = Date.now();
  const tick = () => {
    for (const s of streams.values()) if (store.get('revoked', s.principalId)) s.close();
    opencode?.sync();
    const { notices, actions } = store.transaction(() => planPushes(store, Date.now(), {
      connected: (id) => streams.has(id), lastSeen: (id) => seen.get(id), since }, opencode?.state()));
    for (const { sessionId, ...wake } of notices) streams.get(sessionId)?.write(`event: wake\ndata: ${JSON.stringify(wake)}\n\n`);
    if (actions.length) opencode?.perform(actions);
  };
  // A session ID stays with the first principal that used it; the same principal reconnecting replaces its old stream.
  const belongs = (sessionId: string, principalId: string) => (principals.get(sessionId) ?? principalId) === principalId;
  const timer = tickMs > 0 ? setInterval(tick, tickMs) : undefined;
  return {
    tick,
    belongs,
    owns: (sessionId: string, principalId: string) => streams.get(sessionId)?.principalId === principalId,
    open(sessionId: string, principalId: string, stream: Omit<Stream, 'principalId'>): (() => void) | undefined {
      if (!belongs(sessionId, principalId)) return undefined;
      principals.set(sessionId, principalId);
      streams.get(sessionId)?.close();
      const entry = { ...stream, principalId };
      streams.set(sessionId, entry);
      return () => {
        if (streams.get(sessionId) !== entry) return;
        streams.delete(sessionId);
        seen.set(sessionId, Date.now());
      };
    },
    close() {
      clearInterval(timer);
      for (const s of streams.values()) s.close();
    },
  };
}
