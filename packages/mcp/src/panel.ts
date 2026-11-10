// FR-67: the MCP Apps room panel (UI resource contract 2026-01-26). It runs sandboxed in the host with no network of its own,
// reads only through the room_panel tool and sends every approval to the paired browser.
export const PANEL_URI = 'ui://converoom/room-panel.html';
export const PANEL_MIME = 'text/html;profile=mcp-app';
export const PANEL_TOOLS: ReadonlySet<string> = new Set(['room_create', 'room_join', 'room_panel']);

export function supportsPanel(capabilities: { extensions?: Record<string, unknown> } | undefined): boolean {
  const ui = capabilities?.extensions?.['io.modelcontextprotocol/ui'] as { mimeTypes?: unknown } | undefined;
  return Array.isArray(ui?.mimeTypes) && ui.mimeTypes.includes(PANEL_MIME);
}

// Serialised into the page with toString, so it must not reference anything outside its own body.
function panelMain(): void {
  type Json = Record<string, unknown>;
  const POLL_MS = 5000, BACKOFF_MS = [10000, 30000, 60000];
  const $ = (id: string) => document.getElementById(id) as HTMLElement;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  let nextId = 1, roomId: string | undefined, timer: number | undefined, failures = 0, started = false, closed = false;
  let appUrl: string | undefined, approvalsUrl: string | undefined, askedAt = 0;

  const send = (message: Json) => window.parent.postMessage(Object.assign({ jsonrpc: '2.0' }, message), '*');
  const request = (method: string, params: Json) => new Promise<unknown>((resolve, reject) => {
    const id = nextId++;
    const wait = window.setTimeout(() => { pending.delete(id); reject(new Error('The host did not answer')); }, 20000);
    pending.set(id, { resolve: (v) => { window.clearTimeout(wait); resolve(v); }, reject: (e) => { window.clearTimeout(wait); reject(e); } });
    send({ id, method, params });
  });
  const notify = (method: string, params?: Json) => send(params ? { method, params } : { method });
  const loopback = (url: unknown): url is string => typeof url === 'string' && /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(url);
  const words = (value: unknown) => {
    const text = String(value ?? '').replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  };
  const ago = (at: unknown) => {
    if (typeof at !== 'number') return '';
    const minutes = Math.floor((Date.now() - at) / 60000);
    return minutes < 1 ? 'just now' : minutes < 60 ? minutes + ' min ago' : Math.floor(minutes / 60) + ' h ago';
  };
  const item = (text: string, detail?: string) => {
    const li = document.createElement('li');
    const main = document.createElement('span');
    main.textContent = text;
    li.append(main);
    if (detail) {
      const small = document.createElement('span');
      small.className = 'detail';
      small.textContent = detail;
      li.append(small);
    }
    return li;
  };
  const fill = (id: string, items: HTMLElement[]) => { $(id).replaceChildren(...items); };
  const show = (id: string, visible: boolean) => { $(id).hidden = !visible; };
  const push = (p: Json | undefined) => {
    if (!p) return '';
    if (p.status === 'suspended') return 'Push paused, polling';
    if (Number(p.attempts) > 0) return 'Attached · wake sent';
    return p.tested ? 'Attached · wake tested' : 'Attached · wake untested';
  };

  const fail = (code: unknown, message: unknown) => {
    $('alert').textContent = code === 'runtime_unavailable'
      ? 'Converoom is not running. Ask the owner to start it; this panel retries on its own.'
      : String(message || 'Converoom could not load this room.');
    show('alert', true);
  };
  const render = (panel: Json) => {
    show('alert', false);
    const room = panel.room as Json | null, seat = panel.seat as Json | null, rooms = (panel.rooms as Json[] | undefined) ?? [];
    appUrl = loopback(panel.appUrl) ? panel.appUrl : undefined;
    approvalsUrl = loopback(panel.approvalsUrl) ? panel.approvalsUrl : undefined;
    show('open', !!appUrl);
    const select = $('switch') as HTMLSelectElement;
    select.replaceChildren(...rooms.map((r) => {
      const option = document.createElement('option');
      option.value = String(r.id);
      option.textContent = String(r.title) + (r.lifecycle === 'active' ? '' : ' (' + words(r.lifecycle).toLowerCase() + ')');
      return option;
    }));
    show('switch-wrap', rooms.length > 1);
    if (!room || !seat) {
      $('title').textContent = 'No room yet';
      $('meta').textContent = 'This connection has no seat in a room.';
      for (const id of ['waiting', 'approvals', 'asked', 'seats-section']) show(id, false);
      return;
    }
    roomId = String(room.id);
    select.value = roomId;
    closed = room.lifecycle === 'closed' || room.lifecycle === 'archived';
    $('title').textContent = String(room.title);
    $('meta').textContent = words(room.lifecycle) + ' · ' + words(room.phase) + ' · You are ' + String(seat.name) + ' (' + String(seat.role) + ', ' + String(seat.mode) + ')';

    const waiting = (panel.waiting as { requests?: Json[]; turns?: Json[]; directives?: number } | undefined) ?? {};
    const requests = waiting.requests ?? [], turns = waiting.turns ?? [], directives = Number(waiting.directives ?? 0);
    const due = requests.map((r) => item(words(r.intent) + ' from ' + String(r.from), ago(r.createdAt)))
      .concat(turns.map((t) => item('Turn ' + String(t.status), ago(t.createdAt))))
      .concat(directives ? [item(directives + ' owner directive' + (directives === 1 ? '' : 's'))] : []);
    show('waiting', true);
    fill('waiting-list', due);
    show('waiting-list', due.length > 0);
    show('waiting-empty', due.length === 0);
    show('ask', due.length > 0);
    $('waiting').classList.toggle('due', due.length > 0);

    const approvals = (panel.approvals as Json[] | undefined) ?? [];
    fill('approvals-list', approvals.map((p) => item(String(p.summary), words(p.action))));
    $('review').textContent = 'Review ' + approvals.length + ' approval' + (approvals.length === 1 ? '' : 's') + ' in browser';
    show('review', !!approvalsUrl);
    show('approvals', approvals.length > 0);

    const asked = (panel.asked as Json[] | undefined) ?? [];
    fill('asked-list', asked.map((r) => item(words(r.intent) + ' asked of ' + String(r.to), words(r.status) + ' · ' + ago(r.createdAt))));
    show('asked', asked.length > 0);

    show('seats-section', true);
    fill('seats', ((panel.roster as Json[] | undefined) ?? []).map((s) => {
      const li = item(String(s.name) + (s.you ? ' (you)' : ''), [s.product, s.role, s.mode].map(String).join(' · '));
      const state = push(s.push as Json | undefined);
      if (state) {
        const tag = document.createElement('span');
        tag.className = 'tag' + ((s.push as Json).status === 'suspended' ? ' warn' : '');
        tag.textContent = state;
        if ((s.push as Json).reason) tag.title = String((s.push as Json).reason);
        li.append(tag);
      }
      return li;
    }));
    const budgets = panel.budgets as { messages?: Json; turns?: Json } | undefined;
    $('budget').textContent = budgets ? 'Messages ' + String(budgets.messages?.used ?? 0) + '/' + String(budgets.messages?.limit ?? '?') +
      ' · Turns ' + String(budgets.turns?.used ?? 0) : '';
    $('updated').textContent = 'Updated ' + new Date().toLocaleTimeString();
  };

  const accept = (result: unknown) => {
    const r = (result ?? {}) as { isError?: boolean; structuredContent?: { result?: Json; error?: Json } };
    const value = r.structuredContent?.result;
    if (r.isError || !value) {
      fail(r.structuredContent?.error?.code, r.structuredContent?.error?.message);
      return false;
    }
    if ('roster' in value || ('rooms' in value && 'room' in value)) {
      failures = 0;
      render(value);
      return true;
    }
    const id = value.roomId ?? value.id;
    if (typeof id === 'string') roomId = id;
    return false;
  };
  const schedule = (ms: number) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = window.setTimeout(() => { void refresh(); }, ms);
  };
  const refresh = async () => {
    try {
      const ok = accept(await request('tools/call', { name: 'room_panel', arguments: roomId ? { roomId } : {} }));
      if (!ok) failures += 1;
    } catch (error) {
      failures += 1;
      fail('', error instanceof Error ? error.message : 'The host refused the room panel call');
    }
    schedule(failures ? BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1]! : closed ? 30000 : POLL_MS);
  };
  const start = () => {
    if (started) return;
    started = true;
    void refresh();
  };

  const theme = (context: Json | undefined) => {
    if (!context) return;
    if (context.theme === 'light' || context.theme === 'dark') document.documentElement.style.colorScheme = context.theme;
    const variables = (context.styles as { variables?: Record<string, string> } | undefined)?.variables;
    if (variables) for (const [name, value] of Object.entries(variables)) if (name.startsWith('--') && value) document.documentElement.style.setProperty(name, value);
  };
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data as Json | null;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.id !== undefined && message.method === undefined) {
      const waiting = pending.get(Number(message.id));
      if (!waiting) return;
      pending.delete(Number(message.id));
      if (message.error) waiting.reject(message.error); else waiting.resolve(message.result);
      return;
    }
    const params = (message.params ?? {}) as Json;
    if (message.method === 'ui/notifications/tool-input') {
      const args = (params.arguments ?? {}) as Json;
      if (typeof args.roomId === 'string') roomId = args.roomId;
    } else if (message.method === 'ui/notifications/tool-result') {
      if (accept(params)) { started = true; schedule(POLL_MS); } else start();
    } else if (message.method === 'ui/notifications/host-context-changed') {
      theme(params);
    } else if (message.method === 'ui/resource-teardown') {
      if (timer !== undefined) window.clearTimeout(timer);
      send({ id: message.id, result: {} });
    } else if (message.id !== undefined) {
      send({ id: message.id, error: { code: -32601, message: 'Method not found' } });
    }
  });
  const open = (url: string | undefined) => { if (url) void request('ui/open-link', { url }).catch(() => fail('', 'Open ' + url + ' in your browser.')); };
  $('open').addEventListener('click', () => open(appUrl));
  $('review').addEventListener('click', () => open(approvalsUrl));
  $('refresh').addEventListener('click', () => { void refresh(); });
  $('switch').addEventListener('change', () => { roomId = ($('switch') as HTMLSelectElement).value; void refresh(); });
  $('ask').addEventListener('click', () => {
    if (!roomId || Date.now() - askedAt < 15000) return;
    askedAt = Date.now();
    const title = $('title').textContent ?? '';
    void request('ui/message', { role: 'user', content: [{ type: 'text', text: 'Read room_inbox for Converoom room "' + title + '" (roomId ' + roomId + ') and handle what it returns.' }] })
      .then(() => { $('ask-status').textContent = 'Asked the agent to read its inbox.'; })
      .catch(() => { $('ask-status').textContent = 'The host did not pass the message on. Ask the agent to read its inbox.'; });
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && started) void refresh(); });
  new ResizeObserver(() => notify('ui/notifications/size-changed', { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }))
    .observe(document.body);

  void request('ui/initialize', {
    appInfo: { name: 'converoom-room-panel', version: '1' },
    appCapabilities: { availableDisplayModes: ['inline'] },
    protocolVersion: '2026-01-26',
  }).then((init) => {
    theme((init as Json | undefined)?.hostContext as Json | undefined);
    notify('ui/notifications/initialized');
    window.setTimeout(start, 3000);
  }).catch(() => fail('', 'This client did not start the room panel.'));
}

const STYLE = `
:root { color-scheme: light dark;
  --ground: var(--color-background-primary, light-dark(#f4f4f4, #0a0a0a)); --raised: var(--color-background-secondary, light-dark(#ebebeb, #1a1a1a));
  --ink: var(--color-text-primary, light-dark(#111111, #ececec)); --muted: var(--color-text-secondary, light-dark(#5e5e5e, #8c8c8c));
  --hairline: var(--color-border-primary, light-dark(#d2d2d2, #2f2f2f)); --red: light-dark(#c42c1f, #d43426); --red-ink: light-dark(#b5281c, #ff5d4f);
  --warn: light-dark(#7e5200, #efb23d); --font: var(--font-sans, 'Segoe UI', system-ui, sans-serif); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--ground); color: var(--ink); font: 13px/1.45 var(--font); }
main { padding: 12px 14px 14px; display: grid; gap: 12px; }
header { display: grid; gap: 2px; }
.eyebrow { margin: 0; color: var(--muted); font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
h1 { margin: 0; font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
h2 { margin: 0 0 6px; color: var(--muted); font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; }
.meta, .detail, #updated, #budget, .empty { color: var(--muted); }
.meta, #updated, #budget, .empty, [role="status"], [role="alert"] { margin: 0; }
section { border-top: 1px solid var(--hairline); padding-top: 10px; }
section.due h2 { color: var(--red-ink); }
section.due h2::before { content: ''; display: inline-block; width: 6px; height: 6px; margin-right: 6px; background: var(--red); vertical-align: 1px; }
ul { list-style: none; margin: 0 0 8px; padding: 0; display: grid; gap: 6px; }
li { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 8px; }
li > span:first-child { overflow-wrap: anywhere; }
.detail { font-size: 12px; }
.tag { font-size: 11px; padding: 0 6px; border: 1px solid var(--hairline); }
.tag.warn { color: var(--warn); border-color: currentColor; }
.actions, .row { display: flex; flex-wrap: wrap; gap: 6px; }
footer { display: grid; gap: 8px; border-top: 1px solid var(--hairline); padding-top: 10px; }
button, select { font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--hairline); padding: 4px 10px; min-height: 28px; }
button { cursor: pointer; }
button:hover { border-color: var(--ink); }
button.primary { background: var(--red); border-color: var(--red); color: #ffffff; }
button:focus-visible, select:focus-visible { outline: 2px solid var(--red-ink); outline-offset: 2px; }
.switch { display: flex; align-items: center; gap: 6px; margin-top: 6px; color: var(--muted); }
select { background: var(--raised); max-width: 100%; }
[role="alert"] { color: var(--red-ink); }
[hidden] { display: none !important; }
`;
const BODY = `<main>
<header>
  <p class="eyebrow">Converoom room</p>
  <h1 id="title">Loading the room</h1>
  <p id="meta" class="meta"></p>
  <div class="switch" id="switch-wrap" hidden><label for="switch">Room</label><select id="switch"></select></div>
</header>
<p id="alert" role="alert" hidden></p>
<section id="waiting" aria-labelledby="waiting-title" hidden>
  <h2 id="waiting-title">Waiting for you</h2>
  <ul id="waiting-list"></ul>
  <p id="waiting-empty" class="empty" hidden>Nothing is waiting for this seat.</p>
  <div class="row"><button type="button" id="ask" class="primary" hidden>Ask agent to check inbox</button></div>
  <p id="ask-status" role="status"></p>
</section>
<section id="approvals" aria-labelledby="approvals-title" hidden>
  <h2 id="approvals-title">Approvals</h2>
  <ul id="approvals-list"></ul>
  <div class="row"><button type="button" id="review">Review approvals in browser</button></div>
</section>
<section id="asked" aria-labelledby="asked-title" hidden>
  <h2 id="asked-title">Your open requests</h2>
  <ul id="asked-list"></ul>
</section>
<section id="seats-section" aria-labelledby="seats-title" hidden>
  <h2 id="seats-title">Seats</h2>
  <ul id="seats" aria-label="Seats"></ul>
</section>
<footer>
  <p id="budget"></p>
  <div class="actions"><button type="button" id="open" hidden>Open room in browser</button><button type="button" id="refresh">Refresh</button></div>
  <p id="updated"></p>
</footer>
</main>`;
// esbuild with keepNames (tsx uses it) wraps named functions in __name(), so the page defines it for the serialised script.
export const PANEL_HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<title>Converoom room</title><style>' + STYLE + '</style></head><body>' + BODY +
  '<script>var __name = function (target) { return target; };(' + panelMain.toString() + ')();</script></body></html>';
