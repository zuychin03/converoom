import { it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { streamWriter } from '../apps/daemon/src/shared-stream.js';
it('resumes event delivery after a heartbeat or event fills the writable buffer', async () => {
  const output = new PassThrough({ highWaterMark: 8 });
  let drains = 0, text = '';
  const writer = streamWriter(output, () => { drains++; });
  expect(writer.write(': heartbeat fills the buffer\n\n')).toBe(false);
  expect(writer.blocked()).toBe(true);
  expect(writer.write('must not be queued while blocked')).toBe(false);
  output.on('data', (chunk) => { text += chunk; });
  await expect.poll(() => drains).toBe(1);
  expect(writer.blocked()).toBe(false);
  writer.write('data: resumed\n\n');
  await expect.poll(() => text.includes('data: resumed')).toBe(true);
  expect(text).not.toContain('must not be queued');
  output.destroy();
});
