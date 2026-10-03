import { createHash } from 'node:crypto';
import type { Tx } from '../db/pool.js';
import { AppError } from './errors.js';

export interface IdempotentResult<T> {
  status: number;
  body: T;
  replayed: boolean;
}

/**
 * Exactly-once execution of a mutating request identified by a client-chosen key.
 *
 * The key row is inserted in the SAME transaction as the operation:
 *  - First request: insert succeeds, operation runs, response is stored, all commit together.
 *  - Retry after success: insert conflicts → stored response is replayed.
 *  - Concurrent duplicate: the second INSERT blocks on the first transaction's
 *    uncommitted row; once that commits it sees the conflict and replays.
 *    If the first rolls back, the second proceeds as the first attempt.
 *  - Same key, different payload: rejected (client bug, not a retry).
 */
export async function runIdempotent<T>(
  tx: Tx,
  userId: string,
  key: string | undefined,
  scope: string,
  request: unknown,
  fn: () => Promise<{ status: number; body: T }>,
): Promise<IdempotentResult<T>> {
  if (!key) return { ...(await fn()), replayed: false };
  if (key.length > 200) throw new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key is too long.');

  const requestHash = createHash('sha256').update(scope).update(JSON.stringify(request)).digest('hex');
  const inserted = await tx.query(
    `INSERT INTO idempotency_keys(user_id, key, request_hash) VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING RETURNING key`,
    [userId, key, requestHash],
  );

  if (inserted.rowCount === 0) {
    const { rows } = await tx.query(
      'SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE user_id = $1 AND key = $2',
      [userId, key],
    );
    const prev = rows[0];
    if (!prev || prev.request_hash !== requestHash) {
      throw new AppError(
        422,
        'IDEMPOTENCY_KEY_REUSED',
        'This Idempotency-Key was already used for a different request.',
      );
    }
    return { status: prev.response_status, body: prev.response_body as T, replayed: true };
  }

  const result = await fn();
  await tx.query(
    'UPDATE idempotency_keys SET response_status = $3, response_body = $4 WHERE user_id = $1 AND key = $2',
    [userId, key, result.status, JSON.stringify(result.body)],
  );
  return { ...result, replayed: false };
}
