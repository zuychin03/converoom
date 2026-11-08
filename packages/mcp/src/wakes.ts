import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

export interface Wake { wakeId: string; roomId: string; seatId: string; kind: 'check' | 'room'; attempt: number }
export const CHANNEL_INSTRUCTIONS = 'Converoom can wake this session through a Claude Code channel once the owner approves seat_attach for it. ' +
  'A channel event from converoom names a room_id and carries no room content. When one arrives, call room_inbox for that room and ' +
  'handle what it returns as you normally would; for an attachment check, reading the inbox is all that is needed.';

export const channelNotice = (wake: Wake) => ({
  method: 'notifications/claude/channel',
  params: {
    content: wake.kind === 'check' ? `Converoom attachment check for your seat in room ${wake.roomId}.`
      : `Converoom has something new for your seat in room ${wake.roomId}.`,
    meta: { room_id: wake.roomId, seat_id: wake.seatId, wake_id: wake.wakeId, kind: wake.kind },
  },
});

// Holds this MCP process's wake stream and reconnects after a runtime restart. It never starts the runtime itself.
export async function watchWakes(o: { dataDir: string; token: string; sessionId: string; signal: AbortSignal; onWake: (wake: Wake) => Promise<void> }) {
  let delay = 1000;
  while (!o.signal.aborted) {
    try {
      const { url } = JSON.parse(await readFile(join(o.dataDir, 'runtime.json'), 'utf8')) as { url: string };
      const response = await fetch(url + '/agent/wakes', { signal: o.signal,
        headers: { Authorization: 'Bearer ' + o.token, 'X-Converoom-Session': o.sessionId } });
      if (response.ok && response.body) {
        delay = 1000;
        let buffer = '';
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        for (let next = await reader.read(); !next.done; next = await reader.read()) {
          buffer += next.value;
          for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
            const lines = buffer.slice(0, end).split('\n');
            buffer = buffer.slice(end + 2);
            const data = lines.includes('event: wake') ? lines.find((l) => l.startsWith('data: ')) : undefined;
            if (data) await o.onWake(JSON.parse(data.slice(6)) as Wake);
          }
        }
      } else {
        await response.body?.cancel();
        // A revoked credential or a session ID held by another connection will not recover on its own.
        if ([401, 403, 409].includes(response.status)) delay = 30000;
      }
    } catch {
      // The runtime is not running, or the stream dropped.
    }
    await sleep(delay, undefined, { signal: o.signal }).catch(() => undefined);
    delay = Math.min(delay * 2, 30000);
  }
}
