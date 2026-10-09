import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, validateToolArgs } from './tools.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { MANAGED_TOOLS, type ManagedScope } from './managed.js';
import { SHARED_READS, SHARED_WRITES } from '../../core/src/membership.js';
import { mountReadServices } from './read-services.js';
export async function serveMcp(
  dataDir: string,
  client: string,
  credentialFile?: string,
): Promise<void> {
  const credential = JSON.parse(
    await readFile(credentialFile ?? join(dataDir, 'clients', client + '.json'), 'utf8'),
  ) as { token: string; principalId: string; scope?: ManagedScope; remoteConnectionId?: string };
  const server = new Server(
    { name: 'converoom', version: '0.2.0' },
    { capabilities: { tools: {}, resources: {}, prompts: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.filter((t) => (!credential.scope || MANAGED_TOOLS.has(t.name)) &&
      (!(credential.remoteConnectionId || credential.scope?.remoteConnectionId) || SHARED_READS.has(t.name) || SHARED_WRITES.has(t.name) || t.name === 'runtime_capabilities')).map((t) => ({
      ...t,
      inputSchema: { ...t.inputSchema, type: 'object' as const },
    })),
  }));
  const command = async (name: string, args: Record<string, unknown>) => {
    validateToolArgs(name, args);
    const runtime = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')) as { url: string };
    const response = await fetch(runtime.url + '/agent/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential.token },
      body: JSON.stringify({ name, args }), signal: AbortSignal.timeout(35000) });
    return { response, value: await response.json() as { result?: unknown; error?: { message?: string }; committed?: boolean; retrySafe?: boolean } };
  };
  mountReadServices(server, async (name, args) => {
    const { response, value } = await command(name, args);
    if (!response.ok) throw new Error(value.error?.message ?? 'Room resource unavailable');
    return value.result;
  }, credential.scope?.roomId);
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments ?? {};
      const { response, value } = await command(request.params.name, args);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
        structuredContent: value,
        isError: !response.ok,
      };
    } catch (e) {
      const value = { error: { message: e instanceof Error ? e.message : 'Bridge unavailable', committed: null, retrySafe: false } };
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(value),
          },
        ],
        structuredContent: value,
        isError: true,
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
