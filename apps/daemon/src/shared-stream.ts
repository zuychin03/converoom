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
