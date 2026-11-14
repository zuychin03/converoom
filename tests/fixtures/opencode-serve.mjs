// Stands in for OpenCode 2's `opencode serve` and for `opencode --server URL` (the TUI), with the /api routes the push bridge uses.
// FAKE_OPENCODE_LOG receives one JSON line per request; FAKE_OPENCODE_VERSION and FAKE_OPENCODE_SESSIONS shape the server.
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2), arg = (name) => argv[argv.indexOf(name) + 1];
const log = (entry) => process.env.FAKE_OPENCODE_LOG && appendFileSync(process.env.FAKE_OPENCODE_LOG, JSON.stringify(entry) + '\n');
const version = process.env.FAKE_OPENCODE_VERSION ?? '2.1.4';
if (argv.includes('--version')) {
  console.log(version);
  process.exit(0);
}
if (argv[0] !== 'serve') {
  const url = arg('--server'), basic = 'Basic ' + Buffer.from('opencode:' + (process.env.OPENCODE_PASSWORD ?? '')).toString('base64');
  const status = await fetch(url + '/api/session', { headers: { authorization: basic } }).then((r) => r.status, () => 0);
  log({ event: 'client', args: argv, status });
  process.exit(0);
}
const password = process.env.OPENCODE_PASSWORD, sessions = new Map(), inbox = new Map();
for (const id of (process.env.FAKE_OPENCODE_SESSIONS ?? 'ses_fakeSessionAAAA1111').split(',')) { sessions.set(id, { id }); inbox.set(id, []); }
let seq = 0;
log({ event: 'started', nonce: process.env.CONVEROOM_OPENCODE_SERVER ?? null, password: Boolean(password),
  autoupdate: process.env.OPENCODE_DISABLE_AUTOUPDATE === '1' ? 'off' : 'on' });
// npm's opencode.ps1 shim starts the real server only once a piped stdin ends.
process.stdin.on('end', () => log({ event: 'stdin_ended' })).resume();
createServer(async (req, res) => {
  const body = await new Promise((done) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => done(b)); });
  const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(value === undefined ? '' : JSON.stringify(value)); };
  if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + password).toString('base64'))
    return json(401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
  const url = new URL(req.url, 'http://fake'), input = body ? JSON.parse(body) : undefined;
  log({ event: 'request', method: req.method, path: url.pathname, body: input ?? null });
  const m = /^\/api\/session\/([^/]+)(?:\/(synthetic|inbox)(?:\/([^/]+))?)?$/.exec(url.pathname);
  if (url.pathname === '/api/info') return json(200, { version, pid: process.pid });
  if (url.pathname === '/api/session') return json(200, { data: [...sessions.values()], cursor: {} });
  if (url.pathname === '/fake/deliver') { inbox.set(input.sessionID, []); return json(200, { delivered: true }); }
  if (url.pathname === '/fake/delete') { sessions.delete(input.sessionID); inbox.delete(input.sessionID); return json(200, { deleted: true }); }
  if (!m) return json(404, { _tag: 'NotFound' });
  const [, id, route, inboxID] = m;
  if (!sessions.has(id)) return json(404, { _tag: 'Session.NotFoundError', message: 'Session not found' });
  if (route === 'synthetic' && req.method === 'POST') {
    const item = { id: 'msg_fake' + ++seq, sessionID: id, type: 'synthetic', payload: { text: input.text, description: input.description,
      metadata: input.metadata }, delivery: input.delivery ?? 'steer' };
    inbox.get(id).push(item);
    return json(200, { data: item });
  }
  if (route === 'inbox' && !inboxID) return json(200, { data: inbox.get(id) });
  if (route === 'inbox' && req.method === 'DELETE') { inbox.set(id, inbox.get(id).filter((i) => i.id !== inboxID)); return json(204); }
  if (!route) return json(200, { data: sessions.get(id) });
  json(404, { _tag: 'NotFound' });
}).listen(Number(arg('--port')), arg('--hostname'), () => console.log('server listening on http://' + arg('--hostname') + ':' + arg('--port')));
