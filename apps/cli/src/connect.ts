import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PRODUCT_PROFILES, type Product } from '../../../packages/shared/src/products.js';
import { ensureInstalled } from './lifecycle.js';
import { CLIENT_SECRETS, writeCredential } from './credentials.js';
import { editConfig, installSkill, json, mcpArgs } from './support.js';

export interface Bridges {
  issue: (product: Product) => Promise<Record<string, unknown>>;
  revoke: (principalId: string) => Promise<unknown>;
}
export const defaultConfig = (product: Product, home = homedir()) => join(home, ...PRODUCT_PROFILES[product].config);
export const defaultSkills = (product: Product, home = homedir()) => join(home, ...PRODUCT_PROFILES[product].skills);

// Shared by connect, onboarding and the browser's one-step connection. Neighbouring settings and servers are preserved,
// and a reconnect revokes the product's previous bridge credential.
export async function connectProduct(dataDir: string, product: Product, bridges: Bridges,
  { config = defaultConfig(product), skills = defaultSkills(product), autoStart = false } = {}) {
  const stable = await ensureInstalled(dataDir);
  const skill = await installSkill(skills);
  const clientFile = join(dataDir, 'clients', product + '.json');
  if (existsSync(clientFile)) await bridges.revoke((await json<{ principalId: string }>(clientFile)).principalId);
  const stored = await writeCredential(clientFile, { ...(await bridges.issue(product)), skill, config }, CLIENT_SECRETS);
  await editConfig(config, product, { command: process.execPath, args: mcpArgs(stable, product, dataDir, autoStart) });
  return stored;
}
