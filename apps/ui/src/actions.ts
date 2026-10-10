import { isRecord, string } from './api.js';
import { PRODUCT_IDS, PRODUCT_PROFILES } from '../../../packages/shared/src/products.js';
import type { Action } from './components.js';

export const PRODUCTS = PRODUCT_IDS.map((value) => ({ value, label: PRODUCT_PROFILES[value].label }));

const roomIdOf = (result: unknown) => (isRecord(result) ? string(result, 'id') : '');

export const createRoomAction = (onCreated: (id: string) => void): Action => ({
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
  ],
  onSuccess: (result) => onCreated(roomIdOf(result)),
});

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
    'Close this room and stop new dispatch. Active work stays visible until cancellation is confirmed. A closed room cannot reopen.',
  danger: true,
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
