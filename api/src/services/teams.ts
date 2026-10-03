import { pool } from '../db/pool.js';
import { can } from '../domain/policy.js';
import type { Actor, Role } from '../domain/types.js';
import { forbidden, notFound, ruleViolation } from '../lib/errors.js';
import { publish } from '../lib/outbox.js';
import { invalidateUser } from './auth.js';

export async function listTeams(actor: Actor) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.key, my.role AS my_role,
            (SELECT count(*) FROM team_members m WHERE m.team_id = t.id) AS member_count,
            (SELECT count(*) FROM work_items i WHERE i.team_id = t.id
               AND i.status IN ('OPEN','IN_PROGRESS','BLOCKED','PENDING_APPROVAL')) AS active_items
     FROM teams t LEFT JOIN team_members my ON my.team_id = t.id AND my.user_id = $1
     WHERE my.user_id IS NOT NULL OR $2
     ORDER BY t.name`,
    [actor.id, actor.isAdmin],
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    key: r.key,
    myRole: r.my_role as Role | null,
    memberCount: r.member_count as number,
    activeItems: r.active_items as number,
  }));
}

export async function listMembers(actor: Actor, teamId: string) {
  if (!can.viewTeam(actor, teamId)) throw notFound('Team');
  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, m.role,
            (SELECT count(*) FROM work_items i WHERE i.owner_id = u.id AND i.team_id = $1
               AND i.status IN ('OPEN','IN_PROGRESS','BLOCKED','PENDING_APPROVAL')) AS open_items
     FROM team_members m JOIN users u ON u.id = m.user_id
     WHERE m.team_id = $1 ORDER BY m.role DESC, u.name`,
    [teamId],
  );
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, role: r.role as Role, openItems: r.open_items }));
}

export async function setMemberRole(actor: Actor, teamId: string, userId: string, role: Role) {
  if (!can.manageTeams(actor)) throw forbidden('Only admins can manage team membership.');
  const team = await pool.query('SELECT 1 FROM teams WHERE id = $1', [teamId]);
  if (!team.rowCount) throw notFound('Team');
  const user = await pool.query('SELECT 1 FROM users WHERE id = $1', [userId]);
  if (!user.rowCount) throw notFound('User');
  await pool.query(
    `INSERT INTO team_members(team_id, user_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
    [teamId, userId, role],
  );
  invalidateUser(userId); // this instance: immediately; others: via NOTIFY
  await publish(pool, { kind: 'membership', userId });
}

export async function removeMember(actor: Actor, teamId: string, userId: string) {
  if (!can.manageTeams(actor)) throw forbidden('Only admins can manage team membership.');
  const owned = await pool.query(
    `SELECT count(*) AS n FROM work_items WHERE team_id = $1 AND owner_id = $2
     AND status IN ('IN_PROGRESS','BLOCKED','PENDING_APPROVAL')`,
    [teamId, userId],
  );
  if (owned.rows[0].n > 0) {
    throw ruleViolation('MEMBER_OWNS_WORK', `This user still owns ${owned.rows[0].n} active item(s) in the team. Reassign them first.`);
  }
  await pool.query('DELETE FROM team_members WHERE team_id = $1 AND user_id = $2', [teamId, userId]);
  invalidateUser(userId); // this instance: immediately; others: via NOTIFY
  await publish(pool, { kind: 'membership', userId });
}

export async function searchUsers(actor: Actor, q: string) {
  if (!can.manageTeams(actor)) throw forbidden();
  const { rows } = await pool.query(
    `SELECT id, name, email FROM users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT 20`,
    [`%${q.replace(/[%_]/g, '\\$&')}%`],
  );
  return rows;
}
