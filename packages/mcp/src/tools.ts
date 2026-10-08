import { ConveroomError } from '../../shared/src/contracts.js';
type Schema = {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  items?: unknown;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
};
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Schema;
}
const string = { type: 'string', minLength: 1, maxLength: 65536 },
  small = { ...string, maxLength: 256 },
  strings = { type: 'array', items: small, maxItems: 100 };
const common: Record<string, unknown> = {
  roomId: small,
  clientKey: small,
  seatId: small,
  turnId: small,
  taskId: small,
  attemptId: small,
  manifestId: small,
  candidateId: small,
  repoId: small,
  profileId: small,
  requestId: small,
  interactionId: small,
};
const mutationNames = new Set([
  'room_create',
  'room_join',
  'room_leave',
  'room_post',
  'interaction_resolve',
  'turn_request',
  'room_set_agenda',
  'room_propose_decision',
  'host_transfer_request',
  'room_pause',
  'room_resume',
  'turn_cancel',
  'room_close',
  'task_plan',
  'task_claim',
  'task_heartbeat',
  'task_submit',
  'verification_request',
  'review_submit',
  'integration_prepare',
  'permission_request',
]);
const corpus: Record<string, { required: string[]; fields?: Record<string, unknown> }> = {
  room_create: {
    required: ['title', 'objective'],
    fields: {
      title: small,
      objective: string,
      workflow: { type: 'string', enum: ['discussion', 'coding'] },
      product: { type: 'string', enum: ['claude', 'codex', 'cursor', 'opencode'] },
      name: small,
    },
  },
  room_get: { required: ['roomId'] },
  room_list: { required: [] },
  room_join: { required: ['roomId'], fields: { name: small, product: small } },
  room_leave: { required: ['roomId'] },
  room_post: {
    required: ['roomId', 'text'],
    fields: {
      text: string,
      replyToId: small,
      mentions: {
        type: 'array',
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['seatId', 'intent'],
          properties: {
            seatId: small,
            intent: { type: 'string', enum: ['question', 'review', 'challenge'] },
          },
        },
      },
    },
  },
  room_read: {
    required: ['roomId'],
    fields: {
      cursor: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 100 },
    },
  },
  room_wait: {
    required: ['roomId'],
    fields: {
      cursor: { type: 'integer', minimum: 0 },
      timeoutMs: { type: 'integer', minimum: 0, maximum: 30000 },
    },
  },
  room_inbox: { required: ['roomId'] },
  interaction_resolve: {
    required: ['roomId', 'interactionId', 'reason'],
    fields: { reason: string },
  },
  turn_request: {
    required: ['roomId', 'seatId', 'prompt'],
    fields: { prompt: string, attemptId: small, interactionId: small },
  },
  room_set_agenda: { required: ['roomId', 'agenda'], fields: { agenda: string } },
  room_propose_decision: {
    required: ['roomId', 'decision'],
    fields: {
      decision: string,
      positions: { type: 'array', maxItems: 5 },
      dissent: strings,
      evidence: strings,
      unresolved: strings,
    },
  },
  host_transfer_request: { required: ['roomId', 'seatId'] },
  room_pause: { required: ['roomId'] },
  room_resume: { required: ['roomId'] },
  turn_cancel: { required: ['roomId', 'turnId'] },
  room_close: { required: ['roomId'] },
  task_plan: {
    required: ['roomId', 'repoId', 'tasks'],
    fields: {
      tasks: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['id', 'title', 'acceptance', 'scopePaths', 'dependsOn', 'profileId'],
          properties: {
            id: small,
            title: small,
            acceptance: string,
            scopePaths: strings,
            dependsOn: strings,
            profileId: small,
          },
        },
      },
    },
  },
  task_get: { required: ['roomId', 'taskId'] },
  task_claim: { required: ['roomId', 'taskId'], fields: { seatId: small } },
  task_heartbeat: { required: ['roomId', 'attemptId'] },
  task_submit: { required: ['roomId', 'attemptId'] },
  artefact_get: { required: ['roomId', 'manifestId'] },
  verification_request: { required: ['roomId', 'manifestId'] },
  review_submit: {
    required: ['roomId', 'manifestId', 'verdict', 'reason'],
    fields: { verdict: { type: 'string', enum: ['accept', 'reject'] }, reason: string },
  },
  integration_prepare: {
    required: ['roomId', 'repoId', 'manifestIds', 'profileId'],
    fields: { manifestIds: strings },
  },
  permission_request: {
    required: ['roomId', 'action', 'scope', 'summary'],
    fields: { action: small, scope: { type: 'object' }, summary: string },
  },
  runtime_capabilities: { required: [] },
  room_usage: { required: ['roomId'] },
};
export const TOOL_DEFINITIONS: ToolDefinition[] = Object.entries(corpus).map(([name, def]) => {
  const keys = [...def.required, 'clientKey', ...Object.keys(def.fields ?? {})],
    properties = Object.fromEntries(keys.map((k) => [k, def.fields?.[k] ?? common[k] ?? small]));
  return {
    name,
    description:
      name.replaceAll('_', ' ') +
      '. Connection identity is authoritative. Public answers only. Human grants are required for execution.',
    inputSchema: {
      type: 'object',
      properties,
      required: [...def.required, ...(mutationNames.has(name) ? ['clientKey'] : [])],
      additionalProperties: false,
    },
  };
});
export function validateToolArgs(name: string, args: Record<string, unknown>): void {
  const schema = TOOL_DEFINITIONS.find((t) => t.name === name)?.inputSchema;
  if (!schema) throw new ConveroomError('unknown_command', 'Unknown room tool');
  const validate = (s: Record<string, unknown>, value: unknown, path: string): void => {
    if (s.enum && !(s.enum as unknown[]).includes(value))
      throw new ConveroomError('invalid_argument', 'Invalid ' + path);
    if (
      s.type === 'string' &&
      (typeof value !== 'string' ||
        value.length < Number(s.minLength ?? 0) ||
        Buffer.byteLength(value) > Number(s.maxLength ?? 65536))
    )
      throw new ConveroomError('invalid_argument', 'Invalid ' + path);
    if (
      s.type === 'integer' &&
      (typeof value !== 'number' ||
        !Number.isInteger(value) ||
        value < Number(s.minimum ?? 0) ||
        value > Number(s.maximum ?? Number.MAX_SAFE_INTEGER))
    )
      throw new ConveroomError('invalid_argument', 'Invalid ' + path);
    if (s.type === 'array') {
      if (
        !Array.isArray(value) ||
        value.length < Number(s.minItems ?? 0) ||
        value.length > Number(s.maxItems ?? 100)
      )
        throw new ConveroomError('invalid_argument', 'Invalid ' + path);
      if (s.items)
        for (const item of value) validate(s.items as Record<string, unknown>, item, path + '[]');
    }
    if (s.type === 'object') {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ConveroomError('invalid_argument', 'Invalid ' + path);
      const o = value as Record<string, unknown>;
      for (const k of (s.required as string[]) ?? [])
        if (!(k in o)) throw new ConveroomError('invalid_argument', 'Missing ' + k);
      for (const [k, v] of Object.entries(o)) {
        const p = (s.properties as Record<string, Record<string, unknown>> | undefined)?.[k];
        if (p) validate(p, v, path + '.' + k);
        else if (s.additionalProperties === false)
          throw new ConveroomError('invalid_argument', 'Unexpected ' + k);
      }
    }
  };
  validate(schema as unknown as Record<string, unknown>, args, name);
}
