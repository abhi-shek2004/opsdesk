/**
 * Work item state machine. Pure functions: given the current state and a
 * requested move, either describe the side effects or throw a 422.
 *
 *   OPEN ──start──► IN_PROGRESS ◄──► BLOCKED
 *                     │    ▲
 *      request approval    │ approve / reject / withdraw
 *                     ▼    │
 *               PENDING_APPROVAL
 *   IN_PROGRESS ──resolve──► RESOLVED ──► CLOSED
 *                              └─reopen─► IN_PROGRESS
 *   Any non-terminal state ──► CANCELLED (leads only)
 */
import { ruleViolation } from '../lib/errors.js';
import type { ItemState, Status } from './types.js';

export const TRANSITIONS: Record<Status, readonly Status[]> = {
  OPEN: ['IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['BLOCKED', 'PENDING_APPROVAL', 'RESOLVED', 'CANCELLED'],
  BLOCKED: ['IN_PROGRESS', 'CANCELLED'],
  // Leaving PENDING_APPROVAL for IN_PROGRESS here means "withdraw the request";
  // approve/reject go through the dedicated approval endpoint.
  PENDING_APPROVAL: ['IN_PROGRESS', 'CANCELLED'],
  RESOLVED: ['CLOSED', 'IN_PROGRESS'],
  CLOSED: [],
  CANCELLED: [],
};

const NEEDS_OWNER: readonly Status[] = ['IN_PROGRESS', 'BLOCKED', 'PENDING_APPROVAL'];

export interface TransitionInput {
  reason?: string;
  resolution?: string;
}

export interface TransitionPlan {
  from: Status;
  to: Status;
  /** Reopening clears a previous approval: changed work must be re-approved. */
  clearApproval: boolean;
  setResolvedAt: boolean;
  clearResolvedAt: boolean;
  openApprovalRequest: boolean;
  withdrawApprovalRequest: boolean;
}

/** Problems that make a move impossible regardless of user input. */
export function structuralBlocker(item: ItemState, to: Status): { code: string; message: string } | null {
  if (!TRANSITIONS[item.status].includes(to)) {
    return { code: 'INVALID_TRANSITION', message: `Cannot move from ${item.status} to ${to}.` };
  }
  if (NEEDS_OWNER.includes(to) && !item.ownerId) {
    return { code: 'OWNER_REQUIRED', message: `An item must have an owner before it can be ${label(to)}.` };
  }
  if (to === 'PENDING_APPROVAL') {
    if (!item.requiresApproval)
      return { code: 'APPROVAL_NOT_REQUIRED', message: 'This item does not require approval.' };
    if (item.approvedAt) return { code: 'ALREADY_APPROVED', message: 'This item is already approved.' };
  }
  if (to === 'RESOLVED' && item.requiresApproval && !item.approvedAt) {
    return {
      code: 'APPROVAL_REQUIRED',
      message: 'This item requires approval before it can be resolved. Request approval first.',
    };
  }
  return null;
}

export function planTransition(item: ItemState, to: Status, input: TransitionInput = {}): TransitionPlan {
  const blocker = structuralBlocker(item, to);
  if (blocker) throw ruleViolation(blocker.code, blocker.message);

  const reopening = item.status === 'RESOLVED' && to === 'IN_PROGRESS';
  if ((to === 'BLOCKED' || to === 'CANCELLED' || reopening) && !input.reason?.trim()) {
    throw ruleViolation('REASON_REQUIRED', `A reason is required to ${reopening ? 'reopen' : label(to)} this item.`);
  }
  if (to === 'RESOLVED' && !input.resolution?.trim()) {
    throw ruleViolation('RESOLUTION_REQUIRED', 'Describe how the item was resolved.');
  }

  return {
    from: item.status,
    to,
    clearApproval: reopening,
    setResolvedAt: to === 'RESOLVED',
    clearResolvedAt: reopening,
    openApprovalRequest: to === 'PENDING_APPROVAL',
    withdrawApprovalRequest: item.status === 'PENDING_APPROVAL',
  };
}

function label(s: Status): string {
  switch (s) {
    case 'IN_PROGRESS':
      return 'started';
    case 'BLOCKED':
      return 'blocked';
    case 'PENDING_APPROVAL':
      return 'sent for approval';
    case 'CANCELLED':
      return 'cancelled';
    default:
      return s.toLowerCase();
  }
}
