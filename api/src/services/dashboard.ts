import { pool } from '../db/pool.js';
import { ACTIVE_STATUSES, type Actor } from '../domain/types.js';
import { toItemDto } from './items.js';

const LIST_SELECT = `
  SELECT i.id, i.key, i.team_id, t.name AS team_name, t.key AS team_key, i.type, i.title,
         '' AS description, i.status, i.priority, i.owner_id, o.name AS owner_name,
         i.created_by, cb.name AS created_by_name, i.requires_approval, i.approved_at,
         i.approved_by, NULL AS approved_by_name, i.resolution, i.due_at, i.sla_breached_at,
         i.version, i.created_at, i.updated_at, i.resolved_at
  FROM work_items i
  JOIN teams t ON t.id = i.team_id
  JOIN users cb ON cb.id = i.created_by
  LEFT JOIN users o ON o.id = i.owner_id`;

/**
 * "What needs my attention?" — a handful of small, index-backed queries,
 * each capped, so the cost does not grow with the size of the dataset.
 */
export async function getDashboard(actor: Actor) {
  // Admins see every team; everyone else sees their memberships (leads decide approvals).
  const allTeams = actor.isAdmin ? (await pool.query('SELECT id FROM teams')).rows.map((r) => r.id as string) : [];
  const teamIds = actor.isAdmin ? allTeams : [...actor.memberships.keys()];
  const leadTeams = actor.isAdmin
    ? allTeams
    : [...actor.memberships].filter(([, r]) => r === 'LEAD').map(([t]) => t);
  const me = actor.id;

  const [counts, mine, approvals, overdue, unassigned, recent] = await Promise.all([
    // Every counter is about in-flight work, so scan only active rows. The literal status
    // list matches the partial index (work_items_active_dashboard_idx) so the planner can use it.
    pool.query(
      `SELECT
         count(*) FILTER (WHERE i.owner_id = $3) AS my_open,
         count(*) FILTER (WHERE i.status = 'PENDING_APPROVAL' AND i.team_id = ANY($2::uuid[])
                          AND i.owner_id <> $3 AND i.created_by <> $3) AS awaiting_my_approval,
         count(*) FILTER (WHERE i.due_at < now()) AS overdue,
         count(*) FILTER (WHERE i.owner_id IS NULL AND i.priority IN ('P1','P2')) AS unassigned_urgent,
         count(*) FILTER (WHERE i.status = 'BLOCKED') AS blocked
       FROM work_items i
       WHERE i.team_id = ANY($1::uuid[])
         AND i.status IN ('OPEN', 'IN_PROGRESS', 'BLOCKED', 'PENDING_APPROVAL')`,
      [teamIds, leadTeams, me],
    ),
    pool.query(
      `${LIST_SELECT} WHERE i.owner_id = $1 AND i.status = ANY($2::item_status[])
       ORDER BY i.priority, i.due_at NULLS LAST, i.updated_at DESC LIMIT 8`,
      [me, ACTIVE_STATUSES],
    ),
    pool.query(
      `${LIST_SELECT} WHERE i.status = 'PENDING_APPROVAL' AND i.team_id = ANY($1::uuid[])
       AND i.owner_id <> $2 AND i.created_by <> $2
       ORDER BY i.updated_at ASC LIMIT 8`,
      [leadTeams, me],
    ),
    pool.query(
      `${LIST_SELECT} WHERE i.due_at < now() AND i.status = ANY($2::item_status[]) AND i.team_id = ANY($1::uuid[])
       ORDER BY i.priority, i.due_at LIMIT 8`,
      [teamIds, ACTIVE_STATUSES],
    ),
    pool.query(
      `${LIST_SELECT} WHERE i.owner_id IS NULL AND i.priority IN ('P1','P2') AND i.status = ANY($2::item_status[])
       AND i.team_id = ANY($1::uuid[]) ORDER BY i.priority, i.created_at LIMIT 8`,
      [teamIds, ACTIVE_STATUSES],
    ),
    pool.query(
      `SELECT e.id, e.type, e.payload, e.created_at, u.name AS actor_name, e.actor_id,
              i.id AS item_id, i.key, i.title
       FROM watchers w
       JOIN LATERAL (SELECT * FROM activity_events e WHERE e.work_item_id = w.work_item_id
                     ORDER BY e.id DESC LIMIT 3) e ON TRUE
       JOIN work_items i ON i.id = w.work_item_id
       LEFT JOIN users u ON u.id = e.actor_id
       WHERE w.user_id = $1 AND (e.actor_id IS NULL OR e.actor_id <> $1)
       ORDER BY e.id DESC LIMIT 12`,
      [me],
    ),
  ]);

  const c = counts.rows[0];
  const dto = (rows: Record<string, unknown>[]) => rows.map((r) => toItemDto(r, actor));
  return {
    counts: {
      myOpen: c.my_open as number,
      awaitingMyApproval: c.awaiting_my_approval as number,
      overdue: c.overdue as number,
      unassignedUrgent: c.unassigned_urgent as number,
      blocked: c.blocked as number,
    },
    myWork: dto(mine.rows),
    awaitingApproval: dto(approvals.rows),
    overdue: dto(overdue.rows),
    unassignedUrgent: dto(unassigned.rows),
    recentActivity: recent.rows.map((r) => ({
      id: r.id,
      type: r.type,
      payload: r.payload,
      createdAt: r.created_at,
      actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null,
      item: { id: r.item_id, key: r.key, title: r.title },
    })),
  };
}

/** Approval queue for leads: every pending request they are allowed to decide. */
export async function listApprovalQueue(actor: Actor) {
  const leadTeams = [...actor.memberships].filter(([, r]) => r === 'LEAD').map(([t]) => t);
  const { rows } = await pool.query(
    `SELECT i.id, i.key, i.title, i.priority, i.type, i.due_at, i.version, t.key AS team_key, t.name AS team_name,
            o.name AS owner_name, a.requested_at, a.note, ru.id AS requested_by, ru.name AS requested_by_name,
            (i.owner_id = $2 OR i.created_by = $2 OR a.requested_by = $2) AS is_mine
     FROM approvals a
     JOIN work_items i ON i.id = a.work_item_id
     JOIN teams t ON t.id = i.team_id
     JOIN users ru ON ru.id = a.requested_by
     LEFT JOIN users o ON o.id = i.owner_id
     WHERE a.decided_at IS NULL AND ($3 OR i.team_id = ANY($1::uuid[]))
     ORDER BY a.requested_at ASC LIMIT 200`,
    [leadTeams, actor.id, actor.isAdmin],
  );
  return rows.map((r) => ({
    item: {
      id: r.id,
      key: r.key,
      title: r.title,
      priority: r.priority,
      type: r.type,
      dueAt: r.due_at,
      version: r.version,
      team: { key: r.team_key, name: r.team_name },
      ownerName: r.owner_name,
    },
    requestedBy: { id: r.requested_by, name: r.requested_by_name },
    requestedAt: r.requested_at,
    note: r.note,
    canDecide: !r.is_mine,
  }));
}
