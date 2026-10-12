import type { Writable } from 'node:stream';
export function streamWriter(output: Writable, drained: () => void) {
  let blocked = false;
  return {
    blocked: () => blocked,
    write: (frame: string) => {
      if (blocked || output.destroyed || output.writableEnded) return false;
      const accepted = output.write(frame);
      if (!accepted) {
        blocked = true;
        output.once('drain', () => { blocked = false; drained(); });
      }
      return accepted;
    },
  };
}
// A heartbeat can block the writer while the page is read; a refused frame must not advance the cursor.
export function deliver<T extends { seq?: unknown }>(writer: ReturnType<typeof streamWriter>, page: { events: T[]; cursor: number },
  cursor: number, check: () => void): number {
  for (const event of page.events) {
    check();
    if (writer.blocked()) return cursor;
    const accepted = writer.write('id: ' + event.seq + '\nevent: room\ndata: ' + JSON.stringify(event) + '\n\n');
    cursor = Number(event.seq);
    if (!accepted) return cursor;
  }
  return writer.blocked() ? cursor : page.cursor;
}
