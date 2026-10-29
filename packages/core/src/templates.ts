import { randomUUID } from 'node:crypto';
import {
  ConveroomError as E,
  EFFORTS,
  type Effort,
  type Room,
  type RoomTemplate,
  type RoundRobinPlan,
  type Seat,
  type SeatProfile,
  type Store,
  type ToolArgs,
} from '../../shared/src/contracts.js';

// FR-56: the adapter checks a profile against what the vendor advertises at each launch; this only bounds its shape.
export function seatProfile(value: unknown, mode: Seat['mode']): SeatProfile | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw new E('invalid_argument', 'A profile names a model, an effort or both');
  const { model, effort, ...rest } = value as ToolArgs;
  if (Object.keys(rest).length) throw new E('invalid_argument', 'A profile names only a model and an effort');
  if (model !== undefined && (typeof model !== 'string' || !/^[^\p{Cc}]{1,128}$/u.test(model) || model.trim() !== model))
    throw new E('invalid_argument', 'A model name is 1 to 128 characters on one line');
  if (effort !== undefined && !EFFORTS.includes(effort as Effort)) throw new E('invalid_argument', 'Effort is low, medium, high or max');
  if (model === undefined && effort === undefined) return undefined;
  if (mode !== 'managed')
    throw new E('profile_unsupported', 'Only a managed seat takes a model and effort; an agent in its own conversation keeps its own settings', 409);
  return { ...(model !== undefined ? { model: model as string } : {}), ...(effort !== undefined ? { effort: effort as Effort } : {}) };
}

// No built-in slot names a product or a profile, so each works with whichever agents are ready.
export const BUILT_IN_TEMPLATES: readonly RoomTemplate[] = [
  {
    id: 'builtin:second-opinion', builtIn: true, name: 'Second opinion', workflow: 'discussion',
    description: 'Two agents answer the same question on their own, then compare where they differ.',
    agenda: '1. State the question and what a good answer needs.\n2. Each agent answers before reading the other.\n3. Compare the answers and name each disagreement.\n4. The owner decides.',
    slots: [{ name: 'First opinion', role: 'member', mode: 'managed' }, { name: 'Second opinion', role: 'member', mode: 'managed' }],
    policy: { peerWake: false }, roundRobin: { rounds: 1 },
  },
  {
    id: 'builtin:design-review', builtIn: true, name: 'Design review', workflow: 'discussion',
    description: 'One agent proposes a design, two review and challenge it, and the proposer revises.',
    agenda: '1. The proposer sets out the design and its trade-offs.\n2. The reviewer checks it against the objective.\n3. The challenger argues the strongest alternative.\n4. The proposer revises and records the decision with any dissent.',
    slots: [{ name: 'Proposer', role: 'member', mode: 'managed' }, { name: 'Reviewer', role: 'member', mode: 'managed' },
      { name: 'Challenger', role: 'member', mode: 'managed' }],
    policy: { peerWake: true }, roundRobin: { rounds: 2 },
  },
  {
    id: 'builtin:build-and-review', builtIn: true, name: 'Build and review', workflow: 'coding',
    description: 'One agent builds the change in its own clone, and another reviews it before you apply it.',
    agenda: '1. Agree the change and its acceptance checks.\n2. The builder works in its own attempt.\n3. The reviewer checks the result independently.\n4. The owner applies the verified candidate.',
    slots: [{ name: 'Builder', role: 'member', mode: 'managed' }, { name: 'Reviewer', role: 'member', mode: 'managed' }],
    policy: { peerWake: true },
  },
];
export const MAX_SAVED_TEMPLATES = 100;
const BUDGETS = ['maxRounds', 'maxMessages', 'maxDurationMs', 'maxTurnMs'] as const;

export const templatesFor = (store: Store, ownerId: string): RoomTemplate[] => [...BUILT_IN_TEMPLATES,
  ...store.list<RoomTemplate>('template').filter((t) => t.ownerId === ownerId).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))];
export function findTemplate(store: Store, ownerId: string, id: string) {
  const t = templatesFor(store, ownerId).find((v) => v.id === id);
  if (!t) throw new E('template_not_found', 'Template not found', 404);
  return t;
}
export const templatePolicy = (t: RoomTemplate, defaults: Record<string, number>): ToolArgs => ({
  ...defaults, peerWake: t.policy.peerWake,
  ...Object.fromEntries(BUDGETS.flatMap((k) => typeof t.policy[k] === 'number' ? [[k, Math.min(t.policy[k]!, defaults[k]!)]] : [])),
});

// The owner's own seats become role slots that keep their product and profile; the policy keeps only the budgets lowered.
export function templateFromRoom(store: Store, r: Room, x: { name: string; description: string }, defaults: Record<string, number>): RoomTemplate {
  const seats = store.list<Seat>('seat', { roomId: r.id }).filter((s) => s.status !== 'left' && s.ownerId === r.ownerId).slice(0, 10);
  const agenda = store.lastEvent(r.id, 'agenda')?.data.agenda;
  const plan = store.list<RoundRobinPlan>('round_robin', { roomId: r.id }).sort((a, b) => a.createdAt - b.createdAt).at(-1);
  return {
    id: randomUUID(), name: x.name, description: x.description, workflow: r.workflow, ownerId: r.ownerId, createdAt: Date.now(),
    agenda: typeof agenda === 'string' ? agenda : '',
    slots: seats.map((s) => ({ name: s.name, role: s.role, mode: s.mode, product: s.product, ...(s.profile ? { profile: s.profile } : {}) })),
    policy: { peerWake: r.policy.peerWake === true,
      ...Object.fromEntries(BUDGETS.flatMap((k) => Number(r.policy[k]) < defaults[k]! ? [[k, Number(r.policy[k])]] : [])) },
    ...(plan ? { roundRobin: { rounds: plan.rounds } } : {}),
  };
}
