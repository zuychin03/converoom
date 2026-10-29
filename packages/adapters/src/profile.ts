import { ConveroomError, type Effort } from '../../shared/src/contracts.js';
import { notStarted } from './acp.js';

export interface Offered { value: string; name?: string }
// Level names vendors use, lowest first.
const RANK = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const rank = (o: Offered) => Math.max(RANK.indexOf(o.value.toLowerCase()), RANK.indexOf(o.name?.toLowerCase() ?? ''));
// FR-56: low, medium and high must match a value exactly; max is the highest known level offered, never a guess among unknown names.
export function resolveEffort(level: Effort, offered: Offered[]): string | undefined {
  if (level !== 'max') return offered.find((o) => o.value.toLowerCase() === level || o.name?.toLowerCase() === level)?.value;
  return offered.filter((o) => rank(o) >= 0).reduce<Offered | undefined>((top, o) => !top || rank(o) > rank(top) ? o : top, undefined)?.value;
}
export const offers = (values: string[]) => values.slice(0, 20).join(', ') || 'nothing';
export const unsupported = (message: string) => notStarted(new ConveroomError('profile_unsupported', message, 409));
