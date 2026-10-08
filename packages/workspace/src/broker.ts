import { createServer, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ConveroomError } from '../../shared/src/contracts.js';
export interface FixtureProfile {
  provider: 'local-kv';
  seed: Record<string, string>;
}
export interface FixtureBroker {
  url: string;
  namespace: string;
  token: string;
  requests: number;
  close(): Promise<void>;
}
export async function provisionFixture(
  namespace: string,
  profile: FixtureProfile,
): Promise<FixtureBroker> {
  const token = randomBytes(32).toString('base64url'),
    data = new Map(Object.entries(profile.seed));
  let requests = 0,
    closed = false;
  const server: Server = createServer(async (req, res) => {
    const send = (code: number, value: unknown) => {
      res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(value));
    };
    if (closed || req.headers.host !== new URL(broker.url).host)
      return send(403, { error: 'fixture_unavailable' });
    const auth = String(req.headers.authorization ?? '');
    const expected = 'Bearer ' + token;
    if (
      auth.length !== expected.length ||
      !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))
    )
      return send(401, { error: 'scoped_fixture_credential_required' });
    const match = /^\/namespace\/([^/]+)\/([^/?]+)$/.exec(req.url ?? '');
    if (!match || match[1] !== namespace) return send(403, { error: 'namespace_denied' });
    if (req.method === 'GET') {
      requests++;
      return send(200, { value: data.get(decodeURIComponent(match[2])) ?? null, namespace });
    }
    if (req.method === 'PUT') {
      let body = '';
      for await (const chunk of req) {
        body += String(chunk);
        if (body.length > 65536) return send(413, { error: 'fixture_limit' });
      }
      try {
        const value = JSON.parse(body) as { value: string };
        if (typeof value.value !== 'string') return send(400, { error: 'invalid_value' });
        data.set(decodeURIComponent(match[2]), value.value);
        requests++;
        return send(200, { stored: true, namespace });
      } catch {
        return send(400, { error: 'invalid_json' });
      }
    }
    send(405, { error: 'unsupported_method' });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new ConveroomError('fixture_provisioning', 'Fixture binding failed');
  const broker: FixtureBroker = {
    url: 'http://127.0.0.1:' + address.port,
    namespace,
    token,
    get requests() {
      return requests;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
  return broker;
}
