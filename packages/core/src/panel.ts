import type { HumanMembership, Room, Seat, Store, ToolArgs, Turn } from '../../shared/src/contracts.js';
import type { Attachment } from './attachments.js';
import type { Directive } from './directives.js';
import type { Permission } from './index.js';

type Request = ToolArgs & { id: string; roomId: string; senderId: string; recipientId: string; messageId: string; intent: string; status: string; createdAt: number };
const OPEN = ['stored', 'delivered', 'read'];
const ENDED_TURNS = ['completed', 'failed', 'cancelled'];

// FR-67: everything here is a read. Message text stays out so room_inbox remains the one read that acknowledges work.
export function roomPanel(store: Store, r: Room | undefined, s: Seat | undefined, ownerId: string, rooms: Room[]) {
  const list = rooms.map((x) => ({ id: x.id, title: x.title, lifecycle: x.lifecycle }));
  if (!r || !s) return { room: null, seat: null, rooms: list };
  const seats = store.list<Seat>('seat', { roomId: r.id }).filter((x) => x.status !== 'left');
  // A human sender is the room owner unless a shared room lists them as a member.
  const named = (id: string) => store.get<Seat>('seat', id)?.name ??
    store.list<HumanMembership>('human_membership', { roomId: r.id }).find((m) => m.principalId === id)?.displayName ?? 'Owner';
  const requests = store.list<Request>('interaction', { roomId: r.id });
  const now = Date.now();
  return {
    room: { id: r.id, title: r.title, objective: r.objective, workflow: r.workflow, lifecycle: r.lifecycle, phase: r.phase },
    seat: { id: s.id, name: s.name, role: s.role, mode: s.mode },
    roster: seats.map((x) => {
      const a = store.get<Attachment>('attachment', x.id);
      return {
        id: x.id, name: x.name, product: x.product, role: x.role, mode: x.mode, status: x.status, you: x.id === s.id,
        ...(a ? { push: { status: a.status, tested: a.tested, attempts: a.wake?.attempts ?? 0, ...(a.reason ? { reason: a.reason } : {}) } } : {}),
      };
    }),
    waiting: {
      requests: requests.filter((i) => i.recipientId === s.id && OPEN.includes(i.status))
        .map((i) => ({ id: i.id, messageId: i.messageId, from: named(i.senderId), intent: i.intent, status: i.status, createdAt: i.createdAt })),
      turns: store.list<Turn>('turn', { seatId: s.id }).filter((t) => t.roomId === r.id && !ENDED_TURNS.includes(t.status))
        .map((t) => ({ id: t.id, status: t.status, createdAt: t.createdAt })),
      directives: store.list<Directive>('directive', { roomId: r.id, status: ['active'] }).filter((d) => d.delivery[s.id]?.state === 'queued').length,
    },
    asked: requests.filter((i) => i.senderId === s.id && OPEN.includes(i.status))
      .map((i) => ({ id: i.id, to: named(i.recipientId), intent: i.intent, status: i.status, createdAt: i.createdAt })),
    approvals: store.list<Permission>('permission', { roomId: r.id })
      .filter((p) => p.ownerId === ownerId && p.status === 'pending' && p.expiresAt > now)
      .map((p) => ({ id: p.id, action: p.action, summary: p.summary, expiresAt: p.expiresAt })),
    budgets: {
      messages: { used: store.eventCount(r.id, 'message'), limit: Number(r.policy.maxMessages) },
      turns: { used: store.count('turn', { roomId: r.id }) },
    },
    rooms: list,
  };
}
