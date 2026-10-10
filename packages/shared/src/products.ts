export const PRODUCT_IDS = ['codex', 'cursor', 'claude', 'opencode', 'antigravity', 'kiro', 'qoder', 'grok'] as const;
export type Product = typeof PRODUCT_IDS[number];
interface ProductProfile {
  label: string;
  command: string;
  protocol: 'app-server' | 'acp' | 'polling';
  managedCommand?: string;
  managedArgs: readonly string[];
  config: readonly string[];
  skills: readonly string[];
}
export const PRODUCT_PROFILES: Record<Product, ProductProfile> = {
  codex: { label: 'Codex', command: 'codex', protocol: 'app-server', managedArgs: [],
    config: ['.codex', 'config.toml'], skills: ['.codex', 'skills', 'converoom-room'] },
  cursor: { label: 'Cursor', command: 'agent', protocol: 'acp', managedArgs: ['acp'],
    config: ['.cursor', 'mcp.json'], skills: ['.cursor', 'skills', 'converoom-room'] },
  claude: { label: 'Claude Code', command: 'claude', protocol: 'polling', managedArgs: [],
    config: ['.claude.json'], skills: ['.claude', 'skills', 'converoom-room'] },
  opencode: { label: 'OpenCode', command: 'opencode', protocol: 'polling', managedArgs: [],
    config: ['.config', 'opencode', 'opencode.json'], skills: ['.config', 'opencode', 'skills', 'converoom-room'] },
  antigravity: { label: 'Antigravity', command: 'agy', protocol: 'acp', managedCommand: 'agy_acp_server', managedArgs: [],
    config: ['.gemini', 'config', 'mcp_config.json'], skills: ['.gemini', 'antigravity-cli', 'skills', 'converoom-room'] },
  kiro: { label: 'Kiro', command: 'kiro-cli', protocol: 'acp', managedArgs: ['acp', '--agent-engine=v3', '--auth-method=cli'],
    config: ['.kiro', 'settings', 'mcp.json'], skills: ['.kiro', 'skills', 'converoom-room'] },
  qoder: { label: 'Qoder', command: 'qoder', protocol: 'acp', managedArgs: ['--acp'],
    config: ['.qoder', 'settings.json'], skills: ['.qoder', 'skills', 'converoom-room'] },
  grok: { label: 'Grok Build', command: 'grok', protocol: 'acp', managedArgs: ['--no-auto-update', 'agent', 'stdio'],
    config: ['.grok', 'config.toml'], skills: ['.grok', 'skills', 'converoom-room'] },
};
export function isProduct(value: string): value is Product {
  return (PRODUCT_IDS as readonly string[]).includes(value);
}
export function isManagedProduct(value: string): value is Product {
  return isProduct(value) && PRODUCT_PROFILES[value].protocol !== 'polling';
}
