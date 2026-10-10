import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isProduct, PRODUCT_IDS, type Product } from '../../../packages/shared/src/products.js';

interface LocalRuntime { url: string; pid: number; controlToken: string; sharedOrigin?: string }
export function parseOnboardProducts(value: string): Product[] {
  const products = [...new Set(value.split(',').map((p) => p.trim()).filter(Boolean))];
  if (!products.every(isProduct)) throw new Error('Choose a supported product: ' + PRODUCT_IDS.join(', '));
  return products as Product[];
}
async function localRuntime(dataDir: string): Promise<LocalRuntime | undefined> {
  try {
    const meta = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')) as LocalRuntime;
    const url = new URL(meta.url);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/') return;
    const health = await fetch(new URL('/health', url), { signal: AbortSignal.timeout(1000) });
    const identity = await health.json() as { name: string; pid: number };
    if (health.ok && identity.name === 'converoom' && identity.pid === meta.pid) return meta;
  } catch { /* Wait for an owned local runtime to become ready. */ }
}

export async function onboard(cli: string, dataDir: string, products: Product[], openBrowser: boolean): Promise<void> {
  let child: ChildProcess | undefined;
  let closed: Promise<void> | undefined;
  let startupError: Error | undefined;
  let stopping = false;
  const stop = async () => {
    if (!child || child.exitCode !== null || stopping) return;
    stopping = true;
    const meta = await localRuntime(dataDir);
    if (meta && meta.pid === child.pid) {
      try {
        await fetch(meta.url + '/local/stop', { method: 'POST', headers: {
          Authorization: 'Bearer ' + meta.controlToken, 'Content-Type': 'application/json',
        }, body: '{}', signal: AbortSignal.timeout(5000) });
      } catch { /* Terminate only this launch if graceful shutdown is unavailable. */ }
    }
    const timer = setTimeout(() => child?.kill(), 5000);
    try { await closed; } finally { clearTimeout(timer); }
  };
  const onSignal = () => { void stop(); };
  try {
    let meta = await localRuntime(dataDir);
    if (!meta) {
      child = spawn(process.execPath, [cli, 'start', '--data-dir', dataDir], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'], shell: false });
      child.stdout?.pipe(process.stdout, { end: false });
      closed = new Promise((resolve) => {
        child!.once('exit', () => resolve());
        child!.once('error', (error) => { startupError = error; resolve(); });
      });
      process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (startupError) throw startupError;
        if (child.exitCode !== null) throw new Error('Converoom exited during onboarding. Resolve the displayed issue and rerun.');
        meta = await localRuntime(dataDir);
        if (meta?.pid === child.pid) break;
        meta = undefined;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!meta) throw new Error('Converoom did not become ready within 15 seconds');
    }
    for (const product of products) {
      const connected = await promisify(execFile)(process.execPath, [cli, 'connect', product, '--data-dir', dataDir],
        { windowsHide: true, timeout: 180000, maxBuffer: 262144 });
      process.stdout.write(connected.stdout);
    }
    console.log('Local runtime ready at ' + meta.url + '\nSelected MCP registrations and room skills are installed. Restart the native clients to load them.');
    console.log('Use the pairing code in this terminal. Native agent sign-in, account entitlement and Tailscale sign-in remain with their own clients.');
    console.log(meta.sharedOrigin ? 'Shared listener configured at ' + meta.sharedOrigin + '. Verify Tailscale routing separately.' : 'Shared access is disabled.');
    if (openBrowser) {
      try { await promisify(execFile)('explorer.exe', [meta.url], { windowsHide: true, timeout: 10000 }); }
      catch { console.log('Open the printed local URL in your browser.'); }
    }
    if (!child) { console.log('The existing runtime was reused. Run converoom pair if you need a fresh code.'); return; }
    console.log('Ctrl+C stops this local runtime.');
    await closed;
    if (child.exitCode && !stopping) throw new Error('Converoom stopped with exit code ' + child.exitCode);
  } catch (error) {
    await stop();
    throw error;
  } finally {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal);
  }
}
