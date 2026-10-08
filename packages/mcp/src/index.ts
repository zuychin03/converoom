import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { TOOL_DEFINITIONS, validateToolArgs } from './tools.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function serveMcp(
  dataDir: string,
  client: string,
  credentialFile?: string,
): Promise<void> {
  const credential = JSON.parse(
    await readFile(credentialFile ?? join(dataDir, 'clients', client + '.json'), 'utf8'),
  ) as { token: string; principalId: string };
  const server = new Server(
    { name: 'converoom', version: '0.1.0' },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((t) => ({
      ...t,
      inputSchema: { ...t.inputSchema, type: 'object' as const },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const args = request.params.arguments ?? {};
      validateToolArgs(request.params.name, args);
      const runtime = JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')) as {
        url: string;
      };
      const response = await fetch(runtime.url + '/agent/commands', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + credential.token,
        },
        body: JSON.stringify({ name: request.params.name, args }),
        signal: AbortSignal.timeout(35000),
      });
      const value = await response.json();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(value) }],
        isError: !response.ok,
      };
    } catch (e) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: e instanceof Error ? e.message : 'Bridge unavailable' }),
          },
        ],
        isError: true,
      };
    }
  });
  await server.connect(new StdioServerTransport());
}
