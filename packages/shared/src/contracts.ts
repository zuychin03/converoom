export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type ToolArgs = Record<string, unknown>;
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
  attemptId?: string;
  interactionId?: string;
  permissionRequestId?: string;
  error?: string;
}
export interface Store {
  get<T>(kind: string, id: string): T | undefined;
  list<T>(kind: string): T[];
  put<T>(kind: string, id: string, value: T): void;
  remove(kind: string, id: string): void;
  transaction<T>(fn: () => T): T;
  append(roomId: string, type: string, actorId: string, data: ToolArgs): Event;
  events(roomId: string, after?: number, limit?: number): Event[];
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
