import { privateOrigin } from '../../../packages/mcp/src/shared-auth.js';
import type { SharedServerOptions } from '../../daemon/src/shared-server.js';
export function sharedStartOptions(argv: string[]): SharedServerOptions | undefined {
  const read = (name: string) => {
    const positions = argv.map((v, i) => v === name ? i : -1).filter((i) => i >= 0);
    if (positions.length > 1) throw new Error('Duplicate shared option: ' + name);
    return positions.length ? argv[positions[0] + 1] : undefined;
  };
  if (!argv.some((v) => v === '--shared-origin' || v === '--shared-port')) return;
  const origin = read('--shared-origin'), port = read('--shared-port');
  if (!origin || !port || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535)
    throw new Error('Shared access requires an exact private HTTPS origin and explicit loopback port (1 to 65535).');
  return { enabled: true, origin: privateOrigin(origin), port: Number(port), roomTools: true,
    clients: [{ client_id: 'participant-bridge', redirect_uris: ['http://127.0.0.1:50181/oauth/callback'], token_endpoint_auth_method: 'none' }] };
}
