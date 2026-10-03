/**
 * Background worker: consumes the `jobs` table (transactional outbox).
 *
 * Delivery semantics
 *  - Claiming: SELECT … FOR UPDATE SKIP LOCKED, so any number of worker
 *    processes can run without picking the same job.
 *  - At-least-once: a job is marked DONE in the same transaction as its effects.
 *    If the worker crashes mid-job, the transaction rolls back and the job is retried.
 *  - Duplicates are harmless: handlers are idempotent (e.g. UNIQUE(user_id, event_id)
 *    on notifications), so running a job twice cannot double-notify.
 *  - Failures: exponential backoff (2s, 4s, 8s…); after `maxAttempts` the job is
 *    parked as DEAD for an admin to inspect and retry. One bad job never blocks others.
 *  - Delays: nothing user-facing waits for jobs; the primary action already committed.
 */
import { config } from '../config.js';
import { pool, withTx, type Tx } from '../db/pool.js';
import { ACTIVE_STATUSES } from '../domain/types.js';
import { enqueue, publish } from '../lib/outbox.js';

export type JobHandler = (tx: Tx, payload: any) => Promise<void>;

export const handlers: Record<string, JobHandler> = {
  /** Fan out an activity event to the people who should hear about it. */
  async notify(tx, { eventId }: { eventId: number }) {
    const { rows } = await tx.query(
      `SELECT e.id, e.type, e.actor_id, e.payload, e.work_item_id, i.team_id, i.owner_id
       FROM activity_events e JOIN work_items i ON i.id = e.work_item_id WHERE e.id = $1`,
      [eventId],
    );
    const ev = rows[0];
    if (!ev) return; // item deleted since — nothing to do

    const recipients = new Set<string>();
    const watchers = await tx.query('SELECT user_id FROM watchers WHERE work_item_id = $1', [ev.work_item_id]);
    watchers.rows.forEach((w) => recipients.add(w.user_id));
    if (ev.owner_id) recipients.add(ev.owner_id);
    if (ev.type === 'ASSIGNED' && ev.payload?.to?.id) recipients.add(ev.payload.to.id);
    if (ev.type === 'APPROVAL_REQUESTED') {
      const leads = await tx.query(`SELECT user_id FROM team_members WHERE team_id = $1 AND role = 'LEAD'`, [ev.team_id]);
      leads.rows.forEach((l) => recipients.add(l.user_id));
    }
    if (ev.actor_id) recipients.delete(ev.actor_id); // don't notify people about their own actions
    if (!recipients.size) return;

    const inserted = await tx.query(
      `INSERT INTO notifications(user_id, work_item_id, event_id)
       SELECT unnest($1::uuid[]), $2, $3
       ON CONFLICT (user_id, event_id) DO NOTHING
       RETURNING user_id`,
      [[...recipients], ev.work_item_id, ev.id],
    );
    for (const r of inserted.rows) await publish(tx, { kind: 'notification', userId: r.user_id });
  },
};

export function backoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1000, 5 * 60_000);
}

/** Process up to `limit` due jobs. Returns how many were attempted. */
export async function processJobs(limit = 20): Promise<number> {
  return withTx(async (tx) => {
    const { rows: jobs } = await tx.query(
      `SELECT id, type, payload, attempts FROM jobs
       WHERE status = 'PENDING' AND run_at <= now()
       ORDER BY run_at, id LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const job of jobs) {
      await tx.query('SAVEPOINT job');
      try {
        const handler = handlers[job.type];
        if (!handler) throw new Error(`No handler for job type "${job.type}"`);
        await handler(tx, job.payload);
        await tx.query('RELEASE SAVEPOINT job');
        await tx.query(`UPDATE jobs SET status = 'DONE', processed_at = now(), attempts = attempts + 1 WHERE id = $1`, [
          job.id,
        ]);
      } catch (err) {
        // Undo this job's partial effects only; other jobs in the batch are unaffected.
        await tx.query('ROLLBACK TO SAVEPOINT job');
        const attempts = job.attempts + 1;
        const dead = attempts >= config.job.maxAttempts;
        await tx.query(
          `UPDATE jobs SET attempts = $2, last_error = $3,
             status = CASE WHEN $4 THEN 'DEAD' ELSE 'PENDING' END,
             run_at = now() + ($5 || ' milliseconds')::interval,
             processed_at = CASE WHEN $4 THEN now() ELSE NULL END
           WHERE id = $1`,
          [job.id, attempts, String((err as Error)?.message ?? err).slice(0, 1000), dead, String(backoffMs(attempts))],
        );
        if (!process.env.VITEST) console.error(`[worker] job ${job.id} (${job.type}) failed (attempt ${attempts}):`, err);
      }
    }
    return jobs.length;
  });
}

/**
 * Flag overdue work. The UPDATE … WHERE sla_breached_at IS NULL is the
 * idempotency guard: running the scan twice (or on two workers) flags each item once.
 */
export async function scanSla(): Promise<number> {
  return withTx(async (tx) => {
    const { rows } = await tx.query(
      `UPDATE work_items SET sla_breached_at = now()
       WHERE due_at < now() AND sla_breached_at IS NULL AND status = ANY($1::item_status[])
       RETURNING id, team_id, version, due_at`,
      [ACTIVE_STATUSES],
    );
    for (const r of rows) {
      const ev = await tx.query(
        `INSERT INTO activity_events(work_item_id, actor_id, type, payload)
         VALUES ($1, NULL, 'SLA_BREACHED', $2) RETURNING id`,
        [r.id, JSON.stringify({ dueAt: r.due_at })],
      );
      await enqueue(tx, 'notify', { eventId: ev.rows[0].id });
      await publish(tx, { kind: 'item', itemId: r.id, teamId: r.team_id, version: r.version, actorId: null, event: 'SLA_BREACHED' });
    }
    return rows.length;
  });
}

export async function cleanup(): Promise<void> {
  await pool.query(`DELETE FROM idempotency_keys WHERE created_at < now() - interval '24 hours'`);
  await pool.query(`DELETE FROM sessions WHERE expires_at < now()`);
  await pool.query(`DELETE FROM jobs WHERE status = 'DONE' AND processed_at < now() - interval '7 days'`);
}
