import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const product = process.argv[2];
const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n');
let client, roomId;
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
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    send({ id: message.id, result: product === 'codex' ? {} : { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
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
    await bridge(message.params.mcpServers.find((server) => server.name === 'converoom'));
    send({ id: message.id, result: { sessionId: 'fixture-session' } });
  } else if (message.method === 'session/prompt') {
    await post();
    send({ method: 'session/update', params: { sessionId: 'fixture-session', update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Public protocol fixture answer' },
    } } });
    send({ id: message.id, result: { stopReason: 'end_turn' } });
  } else send({ id: message.id, result: {} });
}
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const message = JSON.parse(line);
  void request(message).catch(() => send({ id: message.id, error: { code: -32000, message: 'Protocol fixture failed' } }));
});
