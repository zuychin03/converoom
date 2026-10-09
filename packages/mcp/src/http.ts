import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ConveroomError as E, type Actor, type Core, type ToolArgs } from '../../shared/src/contracts.js';
import { SHARED_READS, SHARED_WRITES, sharedCommand } from '../../core/src/membership.js';
import { TOOL_DEFINITIONS, validateToolArgs } from './tools.js';
import { mountReadServices } from './read-services.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SHARED_PROTOCOL = '2025-11-25';
export async function handleSharedMcp(request: IncomingMessage, response: ServerResponse, body: unknown,
  context?: { core: Core; actor: Actor; roomId: string; generation: number }) {
  const message = body as { method?: string; params?: { protocolVersion?: string } };
  if (request.headers['mcp-session-id'] ||
    (request.headers['mcp-protocol-version'] && request.headers['mcp-protocol-version'] !== SHARED_PROTOCOL) ||
    (message?.method === 'initialize' && message.params?.protocolVersion !== SHARED_PROTOCOL))
    throw new E('protocol', 'Use the tested stateless MCP protocol ' + SHARED_PROTOCOL, 400);
  const server = new Server({ name: 'converoom-shared', version: '0.2.0' }, { capabilities: { tools: {}, ...(context ? { resources: {}, prompts: {} } : {}) } });
  if (context) mountReadServices(server, (name, args) => sharedCommand(context.core, context.actor, context.roomId, context.generation, name, args), context.roomId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: context ? TOOL_DEFINITIONS
    .filter((t) => SHARED_READS.has(t.name) || SHARED_WRITES.has(t.name) || t.name === 'runtime_capabilities')
    .map((t) => ({ ...t, inputSchema: { ...t.inputSchema, type: 'object' as const,
      properties: { ...t.inputSchema.properties, expectedGeneration: { type: 'integer', minimum: 1 }, expectedPolicyVersion: { type: 'integer', minimum: 1 } },
      required: [...t.inputSchema.required ?? [], ...(SHARED_WRITES.has(t.name) ? ['expectedGeneration', 'expectedPolicyVersion'] : [])] } })) :
    [{ name: 'runtime_capabilities', description: 'Show the tested shared transport capabilities.', inputSchema: { type: 'object', additionalProperties: false } }] }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const name = request.params.name, args: ToolArgs = request.params.arguments ?? {};
      if (name === 'runtime_capabilities') {
        if (Object.keys(args).length) throw new E('invalid_argument', 'Empty capability arguments required');
        const value = { protocol: SHARED_PROTOCOL, sharedWrites: !!context, containment: 'trusted-local advisory' };
        return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
      }
      if (!context) throw new E('shared_tool', 'Shared room tools are not enabled', 403);
      const validated = { ...args }; delete validated.expectedGeneration; delete validated.expectedPolicyVersion;
      validateToolArgs(name, validated);
      const result = await sharedCommand(context.core, context.actor, context.roomId, context.generation, name, args);
      const value = { result, committed: SHARED_WRITES.has(name), retrySafe: true };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
    } catch (error) {
      const value = { error: { code: error instanceof E ? error.code : 'shared_error', message: error instanceof E ? error.message : 'Shared command failed',
        committed: error instanceof E ? false : null, retrySafe: error instanceof E } };
      return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, isError: true };
    }
  });
  await server.connect(transport);
  try { await transport.handleRequest(request, response, body); }
  finally { await transport.close(); await server.close(); }
}
