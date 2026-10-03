import type { Db } from '../db/pool.js';

export const LIVE_CHANNEL = 'opsdesk_live';
export const JOBS_CHANNEL = 'opsdesk_jobs';

export type LiveMessage =
  | { kind: 'item'; itemId: string; teamId: string; version: number; actorId: string | null; event: string }
  | { kind: 'notification'; userId: string }
  /** A user's team roles changed: drop cached identities, refresh open SSE connections. */
  | { kind: 'membership'; userId: string }
  /** A session ended (logout): drop it from every API instance's cache. */
  | { kind: 'session'; tokenHash: string };

/**
 * Queue a background job. Must be called with the same transaction as the
 * change that caused it (transactional outbox): if the change rolls back,
 * the job never exists; if it commits, the job is guaranteed to exist.
 */
export async function enqueue(tx: Db, type: string, payload: unknown): Promise<void> {
  await tx.query('INSERT INTO jobs(type, payload) VALUES ($1, $2)', [type, JSON.stringify(payload)]);
  await tx.query('SELECT pg_notify($1, $2)', [JOBS_CHANNEL, type]);
}

/**
 * Broadcast a live-update hint. Postgres delivers NOTIFY only when the
 * transaction commits, so clients never hear about changes that rolled back.
 * Payloads carry ids only — clients refetch through the authorized API.
 */
export async function publish(tx: Db, msg: LiveMessage): Promise<void> {
  await tx.query('SELECT pg_notify($1, $2)', [LIVE_CHANNEL, JSON.stringify(msg)]);
}
