import { readFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { discover, polling, type Discovery } from '../../../packages/adapters/src/discover.js';
import { PRODUCT_PROFILES, type Product } from '../../../packages/shared/src/products.js';
import { connectionReport, privateJson } from './support.js';
import { defaultConfig } from './connect.js';

export const discoveryFile = (dataDir: string) => join(dataDir, 'discovery.json');
export const isConnected = async (dataDir: string, product: Product, home = homedir()) =>
  (await connectionReport(product, dataDir, defaultConfig(product, home))).registration === 'registered';

// The CLI and the runtime both write the latest result, and agents read it, so it is replaced whole.
async function record(dataDir: string, discovery: Discovery): Promise<Discovery> {
  const temporary = discoveryFile(dataDir) + '.tmp';
  await privateJson(temporary, discovery);
  await rename(temporary, discoveryFile(dataDir));
  return discovery;
}
export const runDiscovery = async (dataDir: string, home = homedir()) =>
  record(dataDir, await discover(dataDir, (product) => isConnected(dataDir, product, home)));
export function latestDiscovery(dataDir: string): Discovery | null {
  try { return JSON.parse(readFileSync(discoveryFile(dataDir), 'utf8')) as Discovery; } catch { return null; }
}
export const autoConnectable = (discovery: Discovery) => discovery.harnesses.filter((h) => h.installed && !h.registered).map((h) => h.product);
export const markConnected = (dataDir: string, discovery: Discovery, products: Product[]) => record(dataDir, {
  ...discovery, harnesses: discovery.harnesses.map((h) => !products.includes(h.product) || h.registered ? h
    : h.status === 'needs_mcp_registration' ? polling({ ...h, registered: true }) : { ...h, registered: true }),
});
export const discoveryLines = (discovery: Discovery) =>
  discovery.harnesses.map((h) => `${PRODUCT_PROFILES[h.product].label}: ${h.status.replaceAll('_', ' ')}. ${h.detail}`);
