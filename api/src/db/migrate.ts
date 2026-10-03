import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

const MIGRATION_LOCK = 72_431_001;

/**
 * Apply pending migrations. Uses one dedicated connection (BEGIN/COMMIT must share it)
 * and a Postgres advisory lock, so several processes starting at once (API, db script,
 * a second API instance) cannot run the same migration twice.
 */
export async function migrate(db: pg.Pool | pg.Client): Promise<string[]> {
  const client = db instanceof pg.Pool ? await db.connect() : db;
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
    );
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        ran.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    }
    return ran;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    if (db instanceof pg.Pool) (client as pg.PoolClient).release();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool, waitForDb } = await import('./pool.js');
  await waitForDb();
  const ran = await migrate(pool);
  console.log(ran.length ? `Applied: ${ran.join(', ')}` : 'Database is up to date.');
  await pool.end();
}
