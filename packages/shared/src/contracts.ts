export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ToolArgs = Record<string, unknown>;
export interface CommandResult<T = unknown> { result: T; committed: boolean | null; retrySafe: boolean }
export interface CommandFailure { error: { code?: string; message: string; committed: boolean | null; retrySafe: boolean } }
export type Product = 'codex' | 'claude' | 'cursor' | 'opencode';
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
export interface Room {
  id: string;
  title: string;
  objective: string;
  ownerId: string;
  hostSeatId: string | null;
  status: 'open' | 'paused' | 'closed';
  workflow: 'discussion' | 'coding';
  createdAt: number;
  policy: ToolArgs;
  policyVersion: number;
  seq: number;
  rounds?: number;
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
  error?: string;
}
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
  status: 'pending' | 'accepted' | 'declined' | 'claimed' | 'completed' | 'uncertain';
  localTurnId?: string;
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
  count(kind: string, filter?: RecordFilter): number;
  put<T>(kind: string, id: string, value: T): void;
  remove(kind: string, id: string): void;
  transaction<T>(fn: () => T): T;
  append(roomId: string, type: string, actorId: string, data: ToolArgs): Event;
  events(roomId: string, after?: number, limit?: number): Event[];
  eventCount(roomId: string, type: string): number;
  recentEvents(limit?: number): Event[];
  eventsAfter(cursor: string, limit?: number): Event[];
  importEvents(events: Event[]): void;
  idempotent<T>(actorId: string, command: string, key: string, payload: unknown, fn: () => T): T;
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
