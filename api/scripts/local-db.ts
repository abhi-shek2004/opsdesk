/**
 * Zero-install local PostgreSQL for development (no Docker required).
 * Uses the `embedded-postgres` package, which ships real Postgres binaries.
 * Data persists in <repo>/.pgdata. Skip this entirely by setting DATABASE_URL
 * to your own Postgres (or `docker compose up db`).
 */
import EmbeddedPostgres from 'embedded-postgres';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const databaseDir = path.join(root, '.pgdata');
const port = Number(process.env.LOCAL_PG_PORT ?? 54329);
const dbName = process.argv[2] ?? 'opsdesk';

const pg = new EmbeddedPostgres({
  databaseDir,
  user: 'postgres',
  password: 'postgres',
  port,
  persistent: true,
  onLog: () => {},
});

if (!existsSync(path.join(databaseDir, 'PG_VERSION'))) {
  console.log(`[db] initialising cluster in ${databaseDir}`);
  await pg.initialise();
}
await pg.start();

const client = pg.getPgClient();
await client.connect();
const exists = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
if (exists.rowCount === 0) await client.query(`CREATE DATABASE ${dbName}`);
await client.end();

const url = `postgres://postgres:postgres@localhost:${port}/${dbName}`;
console.log(`[db] PostgreSQL ready at ${url}`);

// First run: create the schema and load demo data so `npm run dev` is one command.
if (!process.env.DATABASE_URL || process.env.DATABASE_URL === url) {
  process.env.DATABASE_URL = url;
  const { pool } = await import('../src/db/pool.js');
  const { migrate } = await import('../src/db/migrate.js');
  await migrate(pool);
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    console.log('[db] empty database — seeding demo data…');
    const { seedDatabase } = await import('../src/db/seed.js');
    await seedDatabase(pool);
  }
  await pool.end();
}

const shutdown = async () => {
  console.log('[db] stopping…');
  await pg.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
setInterval(() => {}, 1 << 30); // keep process alive
