import type { Product } from './products.js';
export type { Product } from './products.js';
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ToolArgs = Record<string, unknown>;
export interface CommandResult<T = unknown> { result: T; committed: boolean | null; retrySafe: boolean }
export interface CommandFailure { error: { code?: string; message: string; committed: boolean | null; retrySafe: boolean } }
export interface Actor {
  kind: 'human' | 'agent';
  principalId: string;
  ownerId: string;
  seatId?: string;
}
export interface Event {
  id: string;
  roomId: string;
  seq: number;
  type: string;
  actorId: string;
  at: number;
  data: ToolArgs;
}
export type RoomBudget = 'message' | 'turn' | 'time';
export type RoomLifecycle = 'draft' | 'active' | 'pausing' | 'paused' | 'completed' | 'cancelled' | 'archived';
export type RoomPhase = 'deliberation' | 'decision_proposed' | 'owner_review' | 'execution' | 'verification' | 'handoff';
export const ENDED_ROOMS: readonly RoomLifecycle[] = ['completed', 'cancelled', 'archived'];
export const PHASES: readonly RoomPhase[] = ['deliberation', 'decision_proposed', 'owner_review', 'execution', 'verification', 'handoff'];
// Spec: deliberation → decision proposed → owner review → execution → verification → handoff. Only the owner approves
// a decision or returns it to deliberation; room_propose_decision is the only way into decision_proposed.
export const PHASE_STEPS: Record<RoomPhase, Partial<Record<RoomPhase, 'host' | 'owner'>>> = {
  deliberation: {},
  decision_proposed: { owner_review: 'host', deliberation: 'owner' },
  owner_review: { execution: 'owner', handoff: 'owner', deliberation: 'owner' },
  execution: { verification: 'host' },
  verification: { execution: 'host', handoff: 'host' },
  handoff: {},
};
export interface Room {
  id: string;
  title: string;
  objective: string;
  ownerId: string;
  hostSeatId: string | null;
  lifecycle: RoomLifecycle;
  phase: RoomPhase;
  workflow: 'discussion' | 'coding';
  createdAt: number;
  startedAt?: number;
  policy: ToolArgs;
  policyVersion: number;
  seq: number;
  rounds?: number;
  remoteConnectionId?: string;
  exhaustedBudgets?: RoomBudget[];
  template?: { id: string; name: string; rounds?: number };
}
// FR-56: SPEC's levels; each adapter maps them onto the values the vendor advertises and refuses any it cannot match.
export type Effort = 'low' | 'medium' | 'high' | 'max';
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'max'];
export interface SeatProfile { model?: string; effort?: Effort }
// The vendor's own values, as the adapter set them.
export interface AppliedProfile { model?: string; effort?: string }
export interface TemplateSlot {
  name: string;
  role: 'host' | 'member' | 'observer';
  mode: 'managed' | 'polling';
  product?: Product;
  profile?: SeatProfile;
}
export interface RoomTemplate {
  id: string;
  name: string;
  description: string;
  workflow: 'discussion' | 'coding';
  agenda: string;
  slots: TemplateSlot[];
  // Budgets only ever lower the defaults.
  policy: { peerWake: boolean } & Partial<Record<'maxRounds' | 'maxMessages' | 'maxDurationMs' | 'maxTurnMs', number>>;
  // Suggested for the owner to start; a template never starts a plan itself.
  roundRobin?: { rounds: number };
  builtIn?: true;
  ownerId?: string;
  createdAt?: number;
}
export interface Seat {
  id: string;
  roomId: string;
  principalId: string;
  ownerId: string;
  name: string;
  product: Product;
  mode: 'polling' | 'managed';
  role: 'host' | 'member' | 'observer';
  status: string;
  consent: boolean;
  capabilities: { declared: string[]; probed: string[]; tested: string[] };
  sessionId?: string;
  membershipGeneration?: number;
  profile?: SeatProfile;
}
export interface HumanMembership {
  id: string;
  roomId: string;
  principalId: string;
  ownerId: string;
  displayName: string;
  role: 'participant' | 'observer';
  status: 'pending' | 'active' | 'revoked';
  generation: number;
  invitedBy: string;
  createdAt: number;
  updatedAt: number;
  pendingExpiresAt?: number;
}
export interface Invitation {
  id: string;
  roomId: string;
  invitedBy: string;
  displayName: string;
  role: HumanMembership['role'];
  codeHash: string;
  status: 'available' | 'redeemed' | 'revoked';
  createdAt: number;
  expiresAt: number;
  memberId?: string;
  recoverMemberId?: string;
  expectedGeneration?: number;
}
export interface OwnerConsent {
  id: string;
  roomId: string;
  seatId: string;
  ownerId: string;
  membershipGeneration?: number;
  allowedSenderOwnerIds: string[];
  maxTurns: number;
  maxTurnMs: number;
  status: 'active' | 'revoked';
  updatedAt: number;
}
export interface Turn {
  id: string;
  roomId: string;
  seatId: string;
  prompt: string;
  requestedBy?: string;
  status:
    | 'queued'
    | 'dispatching'
    | 'running'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'cancelling'
    | 'uncertain';
  createdAt: number;
  policyVersion: number;
  startedAt?: number;
  completedAt?: number;
  cancelRequestedAt?: number;
  senderOwnerId?: string;
  requesterMembershipGeneration?: number;
  ownerConsentDigest?: string;
  membershipGeneration?: number;
  maxTurnMs?: number;
  remoteProposalId?: string;
  responseEventId?: string;
  attemptId?: string;
  interactionId?: string;
  permissionRequestId?: string;
  roundRobinId?: string;
  roundRobinIndex?: number;
  peerWake?: boolean;
  // Frozen from the seat when requested, so the grant covers it.
  profile?: SeatProfile;
  applied?: AppliedProfile;
  error?: string;
  inspection?: { finding: 'acted' | 'not_acted' | 'unclear'; note: string; at: number; by: string };
}
export interface RoundRobinPlan {
  id: string;
  roomId: string;
  seatIds: string[];
  rounds: number;
  prompt: string;
  digest: string;
  status: 'proposed' | 'running' | 'completed' | 'stopped' | 'declined';
  proposedBy: string;
  createdAt: number;
  turnIds: string[];
  requestId?: string;
  approvedBy?: string;
  approvedAt?: number;
  endedAt?: number;
  reason?: string;
}
export const OPEN_PLANS: RoundRobinPlan['status'][] = ['proposed', 'running'];
export interface RecordFilter {
  roomId?: string;
  seatId?: string;
  requestId?: string;
  status?: string[];
}
export interface RemoteConnection {
  id: string;
  origin: string;
  remoteRoomId: string;
  localOwnerId: string;
  remoteOwnerId: string;
  generation: number;
  status: 'authorizing' | 'connected' | 'disconnected' | 'revoked' | 'uncertain';
  clientId: string;
  product: Product;
  mode: 'polling' | 'managed';
  credentialRef: string;
  remoteSeatId?: string;
  localRoomId?: string;
  localSeatId?: string;
  maxTurns: number;
  maxTurnMs: number;
  cursor: number;
  updatedAt: number;
}
export interface RemoteProposal {
  id: string;
  connectionId: string;
  remoteTurnId: string;
  remoteSeatId: string;
  senderOwnerId: string;
  generation: number;
  policyVersion: number;
  prompt: string;
  publicContext: string;
  maxTurnMs: number;
  deadline: number;
  digest: string;
  status: 'pending' | 'accepted' | 'declined' | 'claimed' | 'completed' | 'failed' | 'cancelled' | 'uncertain';
  localTurnId?: string;
  claimedAt?: number;
  ownerConsentDigest: string;
  authorityDigest: string;
  createdAt: number;
}
export interface SharedArtefact {
  id: string;
  roomId: string;
  ownerId: string;
  name: string;
  mimeType: string;
  content: string;
  digest: string;
  bytes: number;
  visibility: 'room';
  sharedAt: number;
  provenance: { ownerId: string; sourceDigest: string };
}
export interface Store {
  get<T>(kind: string, id: string): T | undefined;
  list<T>(kind: string, filter?: RecordFilter): T[];
  entries<T>(kind: string, filter?: RecordFilter): { id: string; value: T }[];
  count(kind: string, filter?: RecordFilter): number;
  put<T>(kind: string, id: string, value: T): void;
  remove(kind: string, id: string): void;
  transaction<T>(fn: () => T): T;
  append(roomId: string, type: string, actorId: string, data: ToolArgs): Event;
  events(roomId: string, after?: number, limit?: number): Event[];
  eventCount(roomId: string, type: string): number;
  lastEvent(roomId: string, type: string): Event | undefined;
  recentEvents(limit?: number): Event[];
  eventsAfter(cursor: string, limit?: number): Event[];
  onAppend(listener: () => void): () => void;
  importEvents(events: Event[]): void;
  idempotent<T>(actorId: string, command: string, key: string, payload: unknown, fn: () => T): T;
  forgetResults(commands: readonly string[]): number;
  expireResults(before: number, limit: number): number;
  expireRecords(kind: string, statuses: readonly string[], before: number, limit: number): number;
  backup(path: string): Promise<void>;
  close(): void;
}
export type CommandHandler = (actor: Actor, args: ToolArgs) => unknown | Promise<unknown>;
export interface Core {
  store: Store;
  dispatch(actor: Actor, name: string, args: ToolArgs): Promise<unknown>;
  register(name: string, handler: CommandHandler): void;
  requireRoom(actor: Actor, roomId: string): Room;
  requireSeat(actor: Actor, roomId: string): Seat;
  requireOwner(actor: Actor, roomId?: string): void;
}
export interface Runtime {
  core: Core;
  dataDir: string;
  stop(): Promise<void>;
}
export class ConveroomError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = 'ConveroomError';
  }
}
export function requiredString(args: ToolArgs, key: string, max = 65536): string {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max)
    throw new ConveroomError('invalid_argument', `Invalid ${key}`);
  return value;
}
export function uuid(): string {
  return crypto.randomUUID();
}
