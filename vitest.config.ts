import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 20000,
    // Polls wait on runtime ticks, which a loaded CI runner can delay past the 1 second default.
    expect: { poll: { timeout: 10000 } },
    maxWorkers: 2,
    isolate: true,
    // Fixture data folders must not write to the developer's Windows Credential Manager; tests/credentials.test.ts covers it.
    env: { CONVEROOM_CREDENTIAL_STORE: 'file' },
  },
});
