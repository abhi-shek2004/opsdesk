/**
 * Authorization policy — the single source of truth for "who may do what".
 *
 * Every function is pure (no I/O) so it can be exhaustively unit-tested.
 * Roles are per team: a user may be LEAD in one team and VIEWER in another.
 * Global admins may do anything except approve their own work.
 */
import type { Actor, ItemState, Role } from './types.js';

export function roleIn(actor: Actor, teamId: string): Role | null {
  return actor.memberships.get(teamId) ?? null;
}

const atLeast = (role: Role | null, min: Role): boolean => {
  const rank: Record<Role, number> = { VIEWER: 1, MEMBER: 2, LEAD: 3 };
  return role !== null && rank[role] >= rank[min];
};

export const can = {
  viewTeam(actor: Actor, teamId: string) {
    return actor.isAdmin || roleIn(actor, teamId) !== null;
  },

  viewItem(actor: Actor, item: Pick<ItemState, 'teamId'>) {
    return can.viewTeam(actor, item.teamId);
  },

  comment(actor: Actor, item: ItemState) {
    return can.viewItem(actor, item);
  },

  createItem(actor: Actor, teamId: string) {
    return actor.isAdmin || atLeast(roleIn(actor, teamId), 'MEMBER');
  },

  /** Edit title/description/priority/due date/type. */
  editItem(actor: Actor, item: ItemState) {
    if (actor.isAdmin || atLeast(roleIn(actor, item.teamId), 'LEAD')) return true;
    return atLeast(roleIn(actor, item.teamId), 'MEMBER') && (item.ownerId === actor.id || item.createdBy === actor.id);
  },

  /** Toggling "requires approval" weakens a control, so it is lead-only. */
  changeApprovalRequirement(actor: Actor, item: ItemState) {
    return actor.isAdmin || atLeast(roleIn(actor, item.teamId), 'LEAD');
  },

  claim(actor: Actor, item: ItemState) {
    return actor.isAdmin || atLeast(roleIn(actor, item.teamId), 'MEMBER');
  },

  /** Assign the item to someone else. */
  assign(actor: Actor, item: ItemState) {
    return actor.isAdmin || atLeast(roleIn(actor, item.teamId), 'LEAD');
  },

  /** Release ownership. Owners can let go of their own work. */
  unassign(actor: Actor, item: ItemState) {
    return can.assign(actor, item) || (item.ownerId === actor.id && atLeast(roleIn(actor, item.teamId), 'MEMBER'));
  },

  /** Move through the workflow (start, block, resolve, …). */
  transition(actor: Actor, item: ItemState) {
    if (actor.isAdmin || atLeast(roleIn(actor, item.teamId), 'LEAD')) return true;
    return item.ownerId === actor.id && atLeast(roleIn(actor, item.teamId), 'MEMBER');
  },

  cancel(actor: Actor, item: ItemState) {
    return actor.isAdmin || atLeast(roleIn(actor, item.teamId), 'LEAD');
  },

  /**
   * Approve or reject. Separation of duties: nobody — not even an admin —
   * may approve work they own or created.
   */
  decideApproval(actor: Actor, item: ItemState, requestedBy?: string) {
    if (item.ownerId === actor.id || item.createdBy === actor.id || requestedBy === actor.id) return false;
    return actor.isAdmin || atLeast(roleIn(actor, item.teamId), 'LEAD');
  },

  manageTeams(actor: Actor) {
    return actor.isAdmin;
  },
};

/** Is `role` allowed to own work in a team (used to validate assignees)? */
export function canOwnWork(role: Role | null): boolean {
  return atLeast(role, 'MEMBER');
}
