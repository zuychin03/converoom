import { isRecord, string, type RecordData } from './api.js';
import { discoveredModels, num, phaseLabel, rosterOptions, slotChoices, slotSeat } from './model.js';
import { PRODUCT_IDS, PRODUCT_PROFILES } from '../../../packages/shared/src/products.js';
import { PHASE_STEPS, type RoomPhase } from '../../../packages/shared/src/contracts.js';
import type { Action, Field } from './components.js';

export const PRODUCTS = PRODUCT_IDS.map((value) => ({ value, label: PRODUCT_PROFILES[value].label }));
const POLLING_ONLY = PRODUCT_IDS.filter((value) => PRODUCT_PROFILES[value].protocol === 'polling').map((value) => PRODUCT_PROFILES[value].label).join(' and ');

const roomIdOf = (result: unknown) => (isRecord(result) ? string(result, 'id') : '');

// FR-62: a new room offers the agents the latest discovery found ready, and seats the chosen ones with the room.
function seatField(discovery: RecordData | null): Field[] {
  const ready = rosterOptions(discovery);
  return ready.length ? [{
    key: 'seats', label: 'Agents to seat', type: 'choices', options: ready, value: ready.slice(0, 5).map((o) => o.value).join('\n'),
    hint: 'Your last discovery found these ready. A room seats up to five, and each managed turn still needs your consent and grant.',
  }] : [];
}
const seatsOf = (args: RecordData) => Array.isArray(args.seats)
  ? { seats: args.seats.map((value) => { const [product, mode] = String(value).split(':'); return { product, mode }; }) } : {};

export const createRoomAction = (onCreated: (id: string) => void, discovery: RecordData | null = null): Action => ({
  title: 'Create room',
  command: 'room_create',
  label: 'Create room',
  description: 'Give the agents one clear objective. You keep authority over every execution.',
  fields: [
    { key: 'title', label: 'Room name', required: true },
    { key: 'objective', label: 'Objective', required: true, type: 'textarea' },
    {
      key: 'workflow',
      label: 'Workflow',
      type: 'select',
      required: true,
      value: 'discussion',
      options: [
        { value: 'discussion', label: 'Discussion and decisions' },
        { value: 'coding', label: 'Coding and verification' },
      ],
    },
    { key: 'draft', label: 'Create as a draft: add seats and limits, then start it', type: 'checkbox' },
    ...seatField(discovery),
  ],
  prepare: (args) => ({ ...args, ...seatsOf(args) }),
  onSuccess: (result) => onCreated(roomIdOf(result)),
});

const ROLES: Record<string, string> = { host: 'host', member: 'member', observer: 'observer' };
// FR-56: each role slot becomes one seat chosen from the agents the last discovery found ready.
export function templateRoomAction(template: RecordData, onCreated: (id: string) => void, discovery: RecordData | null = null): Action {
  const ready = rosterOptions(discovery), slots = slotChoices(template, discovery), templateId = string(template, 'id');
  return {
    title: 'Create room from ' + string(template, 'name'),
    command: 'room_create',
    label: 'Create room',
    description: [string(template, 'description'), 'The template sets the starter agenda, agent wakes and any lowered budgets.']
      .filter(Boolean).map((s) => (/[.!?]$/.test(s) ? s : s + '.')).join(' '),
    fields: [
      { key: 'title', label: 'Room name', required: true },
      { key: 'objective', label: 'Objective', required: true, type: 'textarea' },
      { key: 'draft', label: 'Create as a draft: add seats and limits, then start it', type: 'checkbox' },
      ...slots.map(({ slot, value }, i): Field => ({
        key: 'slot' + i, label: string(slot, 'name') + ' · ' + (ROLES[string(slot, 'role')] ?? 'member'), type: 'select', placeholder: 'Leave empty',
        options: ready, value,
        ...(i === slots.length - 1 ? { hint: ready.length
          ? 'Filled from the agents your last discovery found ready. Each managed turn still needs your consent and grant.'
          : 'Discover agents on the Work page to fill these, or add seats to the room later.' } : {}),
      })),
    ],
    prepare: (args) => {
      const seats = slots.flatMap(({ slot }, i) => typeof args['slot' + i] === 'string' && args['slot' + i] ? [slotSeat(slot, String(args['slot' + i]))] : []);
      const rest = Object.fromEntries(Object.entries(args).filter(([key]) => !/^slot\d+$/.test(key)));
      return { ...rest, templateId, ...(seats.length ? { seats } : {}) };
    },
    onSuccess: (result) => onCreated(roomIdOf(result)),
  };
}

export const saveTemplateAction = (roomId: string): Action => ({
  title: 'Save as template',
  command: 'template_save',
  args: { roomId },
  label: 'Save template',
  description: 'Saves this room’s seats as role slots with their products, models and efforts, its latest agenda, agent wakes and any budgets you lowered. Messages and turns stay in this room.',
  fields: [
    { key: 'name', label: 'Template name', required: true },
    { key: 'description', label: 'Description', type: 'textarea', hint: 'Optional. Shown when you choose a template.' },
  ],
});

export const deleteTemplateAction = (template: RecordData): Action => ({
  title: 'Delete template',
  command: 'template_delete',
  args: { templateId: template.id },
  label: 'Delete template',
  confirm: `Delete the saved template “${string(template, 'name')}”. Rooms already created from it keep their seats, agenda and limits.`,
  danger: true,
});

const EFFORTS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'max', label: 'Max: the highest level the model offers' },
];
export function seatProfileAction(seat: RecordData, discovery: RecordData | null): Action {
  const product = string(seat, 'product'), profile = isRecord(seat.profile) ? seat.profile : {}, current = string(profile, 'model');
  const models = discoveredModels(discovery, product), label = PRODUCT_PROFILES[product as keyof typeof PRODUCT_PROFILES]?.label ?? product;
  const options = [...new Set([...models, ...(current ? [current] : [])])].map((m) => ({ value: m, label: m }));
  return {
    title: 'Model and effort',
    command: 'seat_profile_set',
    args: { roomId: seat.roomId, seatId: seat.id },
    label: 'Save',
    description: `Applies to turns requested from now on. ${label} is asked for exactly this before each turn; if it does not offer them, the turn fails and nothing is sent. Leave both empty for ${label}’s own defaults.`,
    fields: [
      models.length
        ? { key: 'model', label: 'Model', type: 'select', placeholder: 'Agent default', options, value: current, hint: 'From your last discovery.' }
        : { key: 'model', label: 'Model', value: current, hint: 'The name the agent uses for the model. Leave empty for its default.' },
      { key: 'effort', label: 'Effort', type: 'select', placeholder: 'Agent default', options: EFFORTS, value: string(profile, 'effort') },
    ],
    prepare: ({ model, effort, ...rest }) => ({ ...rest, profile: { ...(model ? { model } : {}), ...(effort ? { effort } : {}) } }),
  };
}

export const joinRoomAction = (onJoined: (id: string) => void): Action => ({
  title: 'Join room',
  command: 'room_join',
  label: 'Open room',
  description: 'Enter a room ID shared with you. The local server checks ownership and membership.',
  fields: [{ key: 'roomId', label: 'Room ID', required: true }],
  onSuccess: (result) => onJoined(roomIdOf(result)),
});

export const closeRoomAction = (roomId: string): Action => ({
  title: 'Close room',
  command: 'room_close',
  args: { roomId },
  label: 'Close room',
  confirm:
    'Close this room and stop new dispatch. Queued turns are cancelled; started work stays visible until cancellation is confirmed. A closed room cannot reopen.',
  fields: [
    {
      key: 'outcome',
      label: 'Outcome',
      type: 'select',
      required: true,
      value: 'completed',
      options: [
        { value: 'completed', label: 'Completed: the objective is met' },
        { value: 'cancelled', label: 'Cancelled: stop here and record a handoff' },
      ],
    },
    { key: 'reason', label: 'Reason', hint: 'Optional. Recorded in the room history.', type: 'textarea' },
  ],
  danger: true,
});

export const archiveRoomAction = (roomId: string): Action => ({
  title: 'Archive room',
  command: 'room_archive',
  args: { roomId },
  label: 'Archive room',
  confirm: 'Archive this completed room. Its history stays readable and exportable, and it moves to the end of the room list.',
});

const PHASE_MOVES: Record<string, string> = {
  'decision_proposed>owner_review': 'Start owner review',
  'decision_proposed>deliberation': 'Return to deliberation',
  'owner_review>execution': 'Approve for execution',
  'owner_review>handoff': 'Approve and hand off',
  'owner_review>deliberation': 'Return to deliberation',
  'execution>verification': 'Start verification',
  'verification>execution': 'Return to execution for rework',
  'verification>handoff': 'Hand off',
};
export const phaseAction = (roomId: string, phase: RoomPhase): Action => {
  const options = Object.keys(PHASE_STEPS[phase]).map((next) => ({ value: next, label: PHASE_MOVES[phase + '>' + next] ?? phaseLabel(next) }));
  return {
    title: 'Change phase',
    command: 'room_set_phase',
    args: { roomId },
    label: 'Change phase',
    description: `The room is in ${phaseLabel(phase).toLowerCase()}. Approving a decision authorises no execution: every managed turn still needs its own grant.`,
    fields: [
      { key: 'phase', label: 'Next phase', type: 'select', required: true, value: options[0]?.value, options },
      { key: 'reason', label: 'Reason', hint: 'Optional. Recorded in the room history.', type: 'textarea' },
    ],
  };
};

// A template's suggested plan only fills the form; the owner still starts it.
export const roundRobinAction = (roomId: string, seats: RecordData[], maxRounds: number, suggested?: unknown): Action => {
  const speakers = seats.filter((s) => s.role !== 'observer' && s.status !== 'left');
  const rounds = isRecord(suggested) ? num(suggested, 'rounds') : undefined;
  return {
    title: 'Start round robin',
    command: 'round_robin_propose',
    args: { roomId },
    label: 'Approve and start',
    description: 'Each speaker takes one turn per round, one at a time, and the plan keeps going if the host disconnects. Room budgets still apply.',
    confirm: 'Starting the plan approves each managed turn in it. It stops at the first turn that does not complete, and you can stop it at any time.',
    fields: [
      {
        key: 'seatIds',
        label: 'Speakers',
        hint: 'Tick them in speaking order.',
        type: 'choices',
        required: true,
        options: speakers.map((s) => ({ value: string(s, 'id'), label: string(s, 'name') })),
        ...(rounds ? { value: speakers.map((s) => string(s, 'id')).join('\n') } : {}),
      },
      { key: 'rounds', label: 'Rounds', type: 'number', required: true, value: String(Math.min(rounds ?? 1, maxRounds)), min: 1, max: maxRounds },
      { key: 'prompt', label: 'Prompt for every turn', type: 'textarea', required: true },
    ],
  };
};

export const stopRoundRobinAction = (roomId: string): Action => ({
  title: 'Stop round robin',
  command: 'round_robin_stop',
  args: { roomId },
  label: 'Stop plan',
  confirm: 'No further turns are queued, and a queued turn from the plan is cancelled. A turn already running carries on until it ends or you cancel it.',
  fields: [{ key: 'reason', label: 'Reason', hint: 'Optional. Recorded in the room history.', type: 'textarea' }],
  danger: true,
});

export const peerWakeAction = (roomId: string, on: boolean): Action => ({
  title: on ? 'Stop agent wakes' : 'Let agents wake each other',
  command: 'policy_update',
  args: { roomId, policy: { peerWake: !on } },
  label: on ? 'Stop agent wakes' : 'Allow agent wakes',
  confirm: on
    ? 'Agents’ questions stay in the recipient’s inbox until the host or you request a turn. This creates a new policy version.'
    : 'When an agent asks, reviews or challenges a managed agent, the runtime queues a turn for it, one at a time per agent. ' +
      'Each turn still needs its owner’s grant, and hop limits and budgets apply. This creates a new policy version.',
});

export const requestTurnAction = (roomId: string, seatId: unknown, interactionId?: string, remote = false): Action => ({
  title: interactionId ? 'Request linked reply' : remote ? 'Request participant turn' : 'Request managed turn',
  command: 'turn_request',
  args: { roomId, seatId, ...(interactionId ? { interactionId } : {}) },
  description:
    remote ? 'This queues a public request for the participant. Their local Converoom requires their separate acceptance and execution grant.' : 'This creates an execution request. Grant it from the pinned slip or the Approvals queue before the new session runs.',
  fields: [
    {
      key: 'prompt',
      label: interactionId ? 'Reply instructions' : 'Assigned prompt',
      type: 'textarea',
      required: true,
    },
  ],
});

export const addAgentAction = (roomId: string): Action => ({
  title: 'Add agent',
  command: 'seat_add',
  args: { roomId },
  description: `${POLLING_ONLY} join only through an existing MCP conversation. The other products can also start a new managed session for each turn. Observers read the room but never take turns or coding work.`,
  fields: [
    { key: 'name', label: 'Agent name', required: true },
    { key: 'product', label: 'Product', type: 'select', options: PRODUCTS, required: true, value: 'codex' },
    {
      key: 'mode',
      label: 'Connection',
      type: 'select',
      options: [
        { value: 'managed', label: 'New managed session' },
        { value: 'polling', label: 'Existing MCP conversation' },
      ],
      value: 'managed',
      required: true,
    },
    {
      key: 'role',
      label: 'Role',
      type: 'select',
      options: [
        { value: 'member', label: 'Member' },
        { value: 'host', label: 'Host' },
        { value: 'observer', label: 'Observer' },
      ],
      value: 'member',
    },
  ],
});

export const grantAction = (permission: RecordData): Action => {
  const action = string(permission, 'action').replaceAll('_', ' '),
    digest = string(permission, 'scopeDigest'),
    expiry = new Date(num(permission, 'expiresAt') ?? 0).toLocaleString('en-AU'),
    args = { requestId: permission.id, scopeDigest: digest };
  if (permission.action === 'host_transfer')
    return {
      title: 'Confirm host transfer',
      command: 'host_transfer_confirm',
      args,
      label: 'Transfer host',
      confirm: `Make the requested seat this room's host for scope digest ${digest}. Its agent can then set the agenda, propose decisions, request and cancel turns, and pause, resume or close the room. This authorises no local execution: every turn still needs its own grant. The current host becomes a member.`,
    };
  if (permission.action === 'round_robin')
    return {
      title: 'Approve round robin',
      command: 'permission_grant',
      args,
      label: 'Approve plan',
      confirm: `Approve the round-robin plan with scope digest ${digest}. This approves each managed turn in the plan, one at a time in the listed order. Room budgets still apply, the plan stops at the first turn that does not complete, and you can stop it at any time.`,
    };
  return {
    title: 'Grant this exact request',
    command: 'permission_grant',
    args,
    label: 'Grant permission',
    confirm: `Grant “${action}” only for scope digest ${digest}. This authorises local execution until ${expiry}. Review any commands and paths in the scope first.`,
  };
};

export const inspectTurnAction = (roomId: string, turnId: unknown): Action => ({
  title: 'Record inspection',
  command: 'turn_inspect',
  args: { roomId, turnId },
  label: 'Record inspection',
  description:
    'Check the room, the workspace and the native session first. Recording a finding changes nothing else and reruns nothing; request the work again yourself if it is still needed.',
  fields: [
    {
      key: 'finding',
      label: 'Finding',
      type: 'select',
      required: true,
      value: 'unclear',
      options: [
        { value: 'acted', label: 'The agent acted' },
        { value: 'not_acted', label: 'The agent did not act' },
        { value: 'unclear', label: 'Still unclear' },
      ],
    },
    { key: 'note', label: 'Note for the record', type: 'textarea' },
  ],
});
