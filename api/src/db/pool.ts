import pg from 'pg';
import { config } from '../config.js';

// Return BIGINT/COUNT(*) values as JS numbers (safe for our ranges).
pg.types.setTypeParser(20, (v) => Number(v));

export const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.dbPoolSize });

export type Db = pg.Pool | pg.PoolClient;
export type Tx = pg.PoolClient;

/** Run fn inside a READ COMMITTED transaction; rolls back on any thrown error. */
export async function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export async function waitForDb(retries = 30, delayMs = 1000): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i >= retries) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
