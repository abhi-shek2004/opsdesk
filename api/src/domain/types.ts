export const STATUSES = [
  'OPEN',
  'IN_PROGRESS',
  'BLOCKED',
  'PENDING_APPROVAL',
  'RESOLVED',
  'CLOSED',
  'CANCELLED',
] as const;
export type Status = (typeof STATUSES)[number];

export const ACTIVE_STATUSES: readonly Status[] = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'PENDING_APPROVAL'];
export const TERMINAL_STATUSES: readonly Status[] = ['CLOSED', 'CANCELLED'];

export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const ITEM_TYPES = ['INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'ENGINEERING', 'COMPLIANCE', 'TASK'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** Types that require sign-off by default (can be changed by a lead). */
export const APPROVAL_TYPES_DEFAULT: readonly ItemType[] = ['PAYMENT', 'COMPLIANCE'];

export const ROLES = ['VIEWER', 'MEMBER', 'LEAD'] as const;
export type Role = (typeof ROLES)[number];

export interface Actor {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  /** teamId -> role */
  memberships: Map<string, Role>;
}

/** The subset of an item that authorization and workflow decisions depend on. */
export interface ItemState {
  id: string;
  teamId: string;
  status: Status;
  ownerId: string | null;
  createdBy: string;
  requiresApproval: boolean;
  approvedAt: Date | null;
  version: number;
}
