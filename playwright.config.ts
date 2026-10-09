import { defineConfig, devices } from '@playwright/test';
import { X509Certificate, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
const fixtureKey = new X509Certificate(readFileSync(new URL('./tests/fixtures/shared-tls-cert.pem', import.meta.url))).publicKey.export({ type: 'spki', format: 'der' });
export default defineConfig({
  testDir: 'tests',
  testMatch: 'ui-e2e.spec.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90000,
  use: { baseURL: 'http://127.0.0.1:43317', trace: 'retain-on-failure', actionTimeout: 10000,
    launchOptions: { args: ['--no-proxy-server', '--host-resolver-rules=MAP room.example.ts.net 127.0.0.1', '--ignore-certificate-errors-spki-list=' + createHash('sha256').update(fixtureKey).digest('base64')] } },
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
