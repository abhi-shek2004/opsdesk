import { pool } from '../db/pool.js';
import type { Actor } from '../domain/types.js';
import { forbidden } from '../lib/errors.js';

export async function listNotifications(actor: Actor, before: number | undefined, limit: number) {
  const { rows } = await pool.query(
    `SELECT n.id, n.read_at, n.created_at, e.type, e.payload, u.name AS actor_name,
            i.id AS item_id, i.key, i.title
     FROM notifications n
     JOIN activity_events e ON e.id = n.event_id
     JOIN work_items i ON i.id = n.work_item_id
     LEFT JOIN users u ON u.id = e.actor_id
     WHERE n.user_id = $1 ${before ? 'AND n.id < $3' : ''}
     ORDER BY n.id DESC LIMIT $2`,
    before ? [actor.id, limit + 1, before] : [actor.id, limit + 1],
  );
  const unread = await pool.query('SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [
    actor.id,
  ]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    unreadCount: unread.rows[0].n as number,
    notifications: page.map((r) => ({
      id: r.id as number,
      read: r.read_at !== null,
      createdAt: r.created_at,
      type: r.type as string,
      payload: r.payload,
      actorName: r.actor_name as string | null,
      item: { id: r.item_id, key: r.key, title: r.title },
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}

export async function markRead(actor: Actor, ids: number[] | 'all') {
  if (ids === 'all') {
    await pool.query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [actor.id]);
  } else if (ids.length) {
    // user_id in the predicate = resource-level authorization: you can only mark your own.
    await pool.query(
      'UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2::bigint[]) AND read_at IS NULL',
      [actor.id, ids],
    );
  }
}

export async function listJobs(actor: Actor, status: string) {
  if (!actor.isAdmin) throw forbidden();
  const { rows } = await pool.query(
    `SELECT id, type, payload, status, attempts, run_at, last_error, created_at, processed_at
     FROM jobs WHERE status = $1 ORDER BY id DESC LIMIT 100`,
    [status],
  );
  const stats = await pool.query(`SELECT status, count(*) AS n FROM jobs GROUP BY status`);
  return {
    stats: Object.fromEntries(stats.rows.map((r) => [r.status, r.n])),
    jobs: rows.map((r) => ({
      id: r.id,
      type: r.type,
      payload: r.payload,
      status: r.status,
      attempts: r.attempts,
      runAt: r.run_at,
      lastError: r.last_error,
      createdAt: r.created_at,
      processedAt: r.processed_at,
    })),
  };
}

export async function retryJob(actor: Actor, id: number) {
  if (!actor.isAdmin) throw forbidden();
  await pool.query(
    `UPDATE jobs SET status = 'PENDING', attempts = 0, run_at = now(), last_error = NULL WHERE id = $1 AND status = 'DEAD'`,
    [id],
  );
  await pool.query(`SELECT pg_notify('opsdesk_jobs', 'retry')`);
}
