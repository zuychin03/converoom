import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: 'tests',
  testMatch: 'ui-e2e.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60000,
  use: { baseURL: 'http://127.0.0.1:43317', trace: 'retain-on-failure', actionTimeout: 10000 },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    {
      name: 'mobile',
      use: { ...devices['Desktop Chrome'], viewport: { width: 360, height: 800 } },
    },
  ],
  webServer: {
    command: '"' + process.execPath + '" node_modules/tsx/dist/cli.mjs tests/browser-server.ts',
    url: 'http://127.0.0.1:43317/health',
    reuseExistingServer: false,
    timeout: 30000,
  },
});
