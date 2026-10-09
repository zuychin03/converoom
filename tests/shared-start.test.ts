import { it, expect } from 'vitest';
import { sharedStartOptions } from '../apps/cli/src/shared.js';
it('requires complete explicit private listener options and defaults to disabled', () => {
  expect(sharedStartOptions(['start'])).toBeUndefined();
  for (const args of [['--shared-origin', 'https://room.example.ts.net'], ['--shared-port', '43224'],
    ['--shared-origin', 'http://room.example.ts.net', '--shared-port', '43224'], ['--shared-origin', 'https://public.example.com', '--shared-port', '43224'],
    ['--shared-origin', 'https://room.example.ts.net', '--shared-port', '0'], ['--shared-origin', 'https://room.example.ts.net', '--shared-port', '43224junk'],
    ['--shared-origin', 'https://room.example.ts.net', '--shared-port', '43224', '--shared-port', '43225']])
    expect(() => sharedStartOptions(['start', ...args])).toThrow();
  expect(sharedStartOptions(['start', '--shared-origin', 'https://room.example.ts.net', '--shared-port', '43224'])).toMatchObject({ enabled: true, origin: 'https://room.example.ts.net', port: 43224, roomTools: true });
});
