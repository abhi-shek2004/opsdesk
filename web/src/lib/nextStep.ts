import type { ItemDetail } from '../api/types';
import { relativeTime } from './format';

export interface NextStep {
  tone: 'action' | 'waiting' | 'warning' | 'done';
  text: string;
}

/**
 * "What requires attention next?" for a single item, phrased for the person looking at it.
 * Derived only from server-provided state and permissions, so it can't suggest an action
 * the server would refuse.
 */
export function nextStep(item: ItemDetail, meId: string | undefined, now = Date.now()): NextStep | null {
  const p = item.permissions;
  const mine = !!item.owner && item.owner.id === meId;
  const owner = item.owner?.name ?? 'Someone';
  const active = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'PENDING_APPROVAL'].includes(item.status);
  const overdue = active && !!item.dueAt && new Date(item.dueAt).getTime() < now;

  let step: NextStep | null;
  switch (item.status) {
    case 'CLOSED':
    case 'CANCELLED':
      return null;
    case 'RESOLVED':
      step = p.transitions.includes('CLOSED')
        ? { tone: 'action', text: 'Resolved. Close it once the requester confirms, or reopen it if the problem is back.' }
        : { tone: 'done', text: 'Resolved. Waiting to be closed.' };
      break;
    case 'PENDING_APPROVAL':
      step = p.decideApproval
        ? { tone: 'action', text: 'Your decision is needed: approve or reject this request.' }
        : {
            tone: 'waiting',
            text: `Waiting for a team lead to approve${item.pendingApproval ? ` (requested by ${item.pendingApproval.requestedBy.name})` : ''}.`,
          };
      break;
    default:
      if (!item.owner) {
        step = p.claim
          ? { tone: 'action', text: 'Nobody owns this yet. Claim it, or assign it to someone.' }
          : { tone: 'warning', text: 'Nobody owns this yet. A team member needs to claim it.' };
      } else if (item.status === 'BLOCKED') {
        step = mine
          ? { tone: 'action', text: 'Blocked. Unblock it as soon as the dependency clears.' }
          : { tone: 'waiting', text: `Blocked. ${owner} will pick it up when the dependency clears.` };
      } else if (item.status === 'OPEN') {
        step = mine
          ? { tone: 'action', text: 'Assigned to you. Start work when you pick it up.' }
          : { tone: 'waiting', text: `Assigned to ${owner}, not started yet.` };
      } else if (item.requiresApproval && !item.approvedAt) {
        step = mine
          ? { tone: 'action', text: 'Request approval from a team lead before this can be resolved.' }
          : { tone: 'waiting', text: `${owner} is working on it. It needs a lead's approval before it can be resolved.` };
      } else if (item.requiresApproval && item.approvedAt) {
        step = mine
          ? { tone: 'action', text: 'Approved. Ready for you to resolve.' }
          : { tone: 'waiting', text: `Approved. ${owner} can resolve it.` };
      } else {
        step = mine
          ? { tone: 'action', text: 'In progress. Resolve it with a short note when done.' }
          : { tone: 'waiting', text: `${owner} is working on it.` };
      }
  }

  if (overdue && step) {
    const by = relativeTime(item.dueAt!, now).replace(' ago', '');
    step = { tone: 'warning', text: `Overdue by ${by}. ${step.text}` };
  }
  return step;
}
