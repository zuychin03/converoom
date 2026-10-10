import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const product = process.argv[2];
const scenario = process.env.CONVEROOM_VENDOR_FIXTURE;
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let client, roomId, pendingPrompt, clientCapabilities;
let authenticated = product !== 'grok' && product !== 'antigravity';
let nextId = 500;
const pending = new Map();
const ask = (method, params) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  send({ id, method, params });
});
async function bridge(config) {
  if (!config || typeof config.command !== 'string' || !Array.isArray(config.args))
    throw new Error('Missing managed MCP configuration');
  const path = config.args[config.args.indexOf('--credential-file') + 1];
  roomId = JSON.parse(await readFile(path, 'utf8')).scope.roomId;
  client = new Client({ name: 'native-protocol-fixture', version: '1' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: config.command, args: config.args, stderr: 'pipe' }));
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  if (!tools.includes('room_post') || tools.includes('room_create')) throw new Error('Wrong managed tool scope');
}
async function post() {
  const result = await client.callTool({ name: 'room_post', arguments: {
    roomId, text: product + ' protocol fixture MCP message', clientKey: 'protocol-post',
  } });
  if (result.isError) throw new Error('Managed MCP post rejected');
}
async function request(message) {
  if (!message.method && pending.has(message.id)) {
    const wait = pending.get(message.id); pending.delete(message.id);
    if (message.error) wait.reject(new Error(message.error.message)); else wait.resolve(message.result);
    return;
  }
  if (message.method === 'session/cancel') {
    if (pendingPrompt) send({ id: pendingPrompt, result: { stopReason: 'cancelled' } });
    pendingPrompt = undefined; return;
  }
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    clientCapabilities = message.params.clientCapabilities;
    const args = process.argv.slice(3);
    const expected = { cursor: ['acp'], kiro: ['acp', '--agent-engine=v3', '--auth-method=cli'],
      qoder: ['--acp'], grok: ['--no-auto-update', 'agent', 'stdio'], antigravity: [] }[product];
    if (expected && JSON.stringify(args) !== JSON.stringify(expected)) throw new Error('Wrong vendor launch arguments');
    send({ id: message.id, result: product === 'codex' ? {} : {
      protocolVersion: scenario === 'wrong-protocol' ? 999 : 1,
      agentCapabilities: {}, authMethods: product === 'grok'
        ? [{ id: scenario === 'api-only' ? 'xai.api_key' : 'cached_token', name: 'Cached native login' }]
        : product === 'antigravity' ? [{ id: 'oauth-personal', name: 'Google native login' }] : [],
    } });
  } else if (message.method === 'authenticate') {
    if (message.params.methodId !== (product === 'grok' ? 'cached_token' : 'oauth-personal'))
      throw new Error('Non-native authentication selected');
    authenticated = true; send({ id: message.id, result: {} });
  } else if (message.method === 'account/read') {
    send({ id: message.id, result: { account: { type: 'chatgpt' } } });
  } else if (message.method === 'thread/start') {
    const config = {};
    for (let i = 3; i < process.argv.length; i++) {
      if (process.argv[i] !== '-c') continue;
      const setting = process.argv[++i];
      const equal = setting.indexOf('=');
      config[setting.slice(0, equal)] = JSON.parse(setting.slice(equal + 1));
    }
    if (config['mcp_servers.converoom.required'] !== true) throw new Error('Bridge must be required');
    await bridge({ command: config['mcp_servers.converoom.command'], args: config['mcp_servers.converoom.args'] });
    send({ id: message.id, result: { thread: { id: 'fixture-thread' } } });
  } else if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'fixture-turn' } } });
    await post();
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'Public protocol fixture answer' } } });
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
  } else if (message.method === 'session/new') {
    if (!authenticated || scenario === 'auth-required') throw new Error('Native authentication required');
    if (!scenario) await bridge(message.params.mcpServers.find((server) => server.name === 'converoom'));
    send({ id: message.id, result: { sessionId: 'fixture-session' } });
  } else if (message.method === 'session/prompt') {
    if (scenario === 'live-terminal') {
      await ask('terminal/create', { sessionId: 'fixture-session', command: process.execPath,
        args: ['-e', "const{spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('fs').writeFileSync('descendant',String(c.pid));setInterval(()=>{},1000)"], cwd: process.cwd() });
      pendingPrompt = message.id; return;
    }
    if (scenario === 'terminal-resources') {
      const terminal = await ask('terminal/create', { sessionId: 'fixture-session', command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify(Object.fromEntries(["TEMP","TMP","TMPDIR","CONVEROOM_BUILD_DIR","CONVEROOM_TEST_DATA","CONVEROOM_FIXTURE_SAMPLE","CLIENT_SETTING"].map(k=>[k,process.env[k]]))))'],
        cwd: process.cwd(), env: [{ name: 'CLIENT_SETTING', value: 'approved' }, { name: 'TMP', value: 'unallocated' }] });
      await ask('terminal/wait_for_exit', { sessionId: 'fixture-session', terminalId: terminal.terminalId });
      const output = await ask('terminal/output', { sessionId: 'fixture-session', terminalId: terminal.terminalId });
      await ask('terminal/release', { sessionId: 'fixture-session', terminalId: terminal.terminalId });
      send({ method: 'session/update', params: { sessionId: 'fixture-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output.output.trim() },
      } } });
      send({ id: message.id, result: { stopReason: 'end_turn' } }); return;
    }
    if (scenario === 'terminal-output') {
      const terminal = await ask('terminal/create', { sessionId: 'fixture-session', command: process.execPath,
        args: ['-e', 'process.stdout.write("中abc中abc")'], cwd: process.cwd(), outputByteLimit: 7 });
      await ask('terminal/wait_for_exit', { sessionId: 'fixture-session', terminalId: terminal.terminalId });
      const output = await ask('terminal/output', { sessionId: 'fixture-session', terminalId: terminal.terminalId });
      await ask('terminal/release', { sessionId: 'fixture-session', terminalId: terminal.terminalId });
      send({ method: 'session/update', params: { sessionId: 'fixture-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: output.output + '|' + (output.truncated ? 'truncated' : 'unbounded') },
      } } });
      send({ id: message.id, result: { stopReason: 'end_turn' } }); return;
    }
    if (['client-tools', 'foreign-file', 'outside-file', 'outside-terminal', 'discussion-tools', 'denied-write', 'symlink-file'].includes(scenario)) {
      let answer;
      try {
        const sessionId = scenario === 'foreign-file' ? 'other-session' : 'fixture-session';
        const path = scenario === 'outside-file' ? join(dirname(process.cwd()), 'outside.txt')
          : scenario === 'symlink-file' ? join(process.cwd(), 'escape', 'approved.txt') : join(process.cwd(), 'approved.txt');
        if (scenario === 'client-tools') {
          if (!clientCapabilities.fs?.writeTextFile || !clientCapabilities.fs?.readTextFile || !clientCapabilities.terminal)
            throw new Error('Missing coding client capabilities');
          await ask('fs/write_text_file', { sessionId, path, content: 'Approved content' });
          const file = await ask('fs/read_text_file', { sessionId, path });
          const terminal = await ask('terminal/create', { sessionId, command: process.execPath,
            args: ['-e', 'console.log(process.argv[1])', 'literal $() "quoted" trailing\\'], cwd: process.cwd() });
          const exit = await ask('terminal/wait_for_exit', { sessionId, terminalId: terminal.terminalId });
          if (exit.exitCode !== 0) throw new Error('Terminal did not complete');
          const output = await ask('terminal/output', { sessionId, terminalId: terminal.terminalId });
          await ask('terminal/release', { sessionId, terminalId: terminal.terminalId });
          answer = file.content + '|' + output.output.trim();
        } else {
          if (scenario === 'outside-terminal') await ask('terminal/create', { sessionId, command: process.execPath,
            args: ['--version'], cwd: dirname(process.cwd()) });
          else if (scenario === 'denied-write') await ask('fs/write_text_file', { sessionId, path, content: 'Unapproved content' });
          else await ask('fs/read_text_file', { sessionId, path });
          throw new Error('Out-of-scope request accepted');
        }
      } catch (error) {
        if (scenario === 'client-tools' || error.message === 'Out-of-scope request accepted') throw error;
        answer = 'Client request denied';
      }
      send({ method: 'session/update', params: { sessionId: 'fixture-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer },
      } } });
      send({ id: message.id, result: { stopReason: 'end_turn' } }); return;
    }
    if (scenario === 'output-limit') {
      for (let n = 0; n < 5; n++) send({ method: 'session/update', params: { sessionId: 'fixture-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '中'.repeat(131072) },
      } } });
      send({ id: message.id, result: { stopReason: 'end_turn' } });
      return;
    }
    if (scenario === 'cancel') { pendingPrompt = message.id; return; }
    if (scenario === 'quota') throw new Error('Quota exhausted');
    if (scenario === 'permission') {
      const answer = await ask('session/request_permission', { sessionId: 'fixture-session',
        toolCall: { toolCallId: 'tool-1', title: 'Run approved check', kind: 'execute', rawInput: { command: 'node', args: ['--version'] } },
        options: [{ optionId: 'yes-once', name: 'Allow', kind: 'allow_once' }, { optionId: 'no-once', name: 'Deny', kind: 'reject_once' }],
        _meta: { kiro: { consent: { capability: 'shell', resource: 'node --version', workspaceRoot: process.cwd() } } },
      });
      send({ method: 'session/update', params: { sessionId: 'fixture-session', update: {
        sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: answer.outcome.optionId === 'yes-once' ? 'Permission allowed' : 'Permission denied' },
      } } });
      send({ id: message.id, result: { stopReason: 'end_turn' } }); return;
    }
    if (!scenario) await post();
    send({ method: 'session/update', params: { sessionId: 'other-session', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Another private session' },
    } } });
    send({ method: 'session/update', params: { sessionId: 'fixture-session', update: {
      sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Private reasoning' },
    } } });
    send({ method: 'session/update', params: { sessionId: 'fixture-session', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Public protocol fixture answer' },
    } } });
    send({ id: message.id, result: { stopReason: 'end_turn' } });
  } else send({ id: message.id, result: {} });
}
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  void request(message).catch((error) => send({ id: message.id, error: { code: -32000, message: error.message } }));
});
