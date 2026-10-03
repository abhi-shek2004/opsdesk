export type Status = 'OPEN' | 'IN_PROGRESS' | 'BLOCKED' | 'PENDING_APPROVAL' | 'RESOLVED' | 'CLOSED' | 'CANCELLED';
export type Priority = 'P1' | 'P2' | 'P3' | 'P4';
export type ItemType = 'INCIDENT' | 'CUSTOMER_ISSUE' | 'PAYMENT' | 'ENGINEERING' | 'COMPLIANCE' | 'TASK';
export type Role = 'VIEWER' | 'MEMBER' | 'LEAD';

export const STATUSES: Status[] = [
  'OPEN',
  'IN_PROGRESS',
  'BLOCKED',
  'PENDING_APPROVAL',
  'RESOLVED',
  'CLOSED',
  'CANCELLED',
];
export const ACTIVE_STATUSES: Status[] = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'PENDING_APPROVAL'];
export const PRIORITIES: Priority[] = ['P1', 'P2', 'P3', 'P4'];
export const ITEM_TYPES: ItemType[] = ['INCIDENT', 'CUSTOMER_ISSUE', 'PAYMENT', 'ENGINEERING', 'COMPLIANCE', 'TASK'];
export const APPROVAL_TYPES_DEFAULT: ItemType[] = ['PAYMENT', 'COMPLIANCE'];

export interface UserRef {
  id: string;
  name: string;
}

export interface Me {
  id: string;
  name: string;
  email: string;
  isAdmin: boolean;
  teams: { id: string; name: string; key: string; role: Role | null }[];
}

export interface Permissions {
  edit: boolean;
  changeApprovalRequirement: boolean;
  claim: boolean;
  assign: boolean;
  unassign: boolean;
  comment: boolean;
  transitions: Status[];
  decideApproval: boolean;
}

export interface Item {
  id: string;
  key: string;
  team: { id: string; name: string; key: string };
  type: ItemType;
  title: string;
  description: string;
  status: Status;
  priority: Priority;
  owner: UserRef | null;
  createdBy: UserRef;
  requiresApproval: boolean;
  approvedAt: string | null;
  approvedBy: UserRef | null;
  resolution: string | null;
  dueAt: string | null;
  slaBreachedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  permissions: Permissions;
}

export interface ItemDetail extends Item {
  pendingApproval: { id: string; requestedBy: UserRef; requestedAt: string; note: string | null } | null;
  watcherCount: number;
  watching: boolean;
}

export interface ActivityEvent {
  id: number;
  type: string;
  actor: UserRef | null;
  payload: Record<string, any>;
  createdAt: string;
}

export interface ItemPage {
  items: Item[];
  nextCursor: string | null;
  total?: number;
  totalCapped?: boolean;
}

export interface Dashboard {
  counts: { myOpen: number; awaitingMyApproval: number; overdue: number; unassignedUrgent: number; blocked: number };
  myWork: Item[];
  awaitingApproval: Item[];
  overdue: Item[];
  unassignedUrgent: Item[];
  recentActivity: (ActivityEvent & { item: { id: string; key: string; title: string } })[];
}

export interface NotificationEntry {
  id: number;
  read: boolean;
  createdAt: string;
  type: string;
  payload: Record<string, any>;
  actorName: string | null;
  item: { id: string; key: string; title: string };
}

export interface Team {
  id: string;
  name: string;
  key: string;
  myRole: Role | null;
  memberCount: number;
  activeItems: number;
}

export interface Member {
  id: string;
  name: string;
  email: string;
  role: Role;
  openItems: number;
}

export interface ApprovalEntry {
  item: {
    id: string;
    key: string;
    title: string;
    priority: Priority;
    type: ItemType;
    dueAt: string | null;
    version: number;
    team: { key: string; name: string };
    ownerName: string | null;
  };
  requestedBy: UserRef;
  requestedAt: string;
  note: string | null;
  canDecide: boolean;
}
