/**
 * Boots a throwaway real PostgreSQL for the test run. Concurrency guarantees
 * (row locks, unique indexes, SKIP LOCKED) can only be verified against a real database.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

export default async function setup() {
  const port = Number(process.env.TEST_PG_PORT ?? 54339);
  const dir = mkdtempSync(path.join(tmpdir(), 'opsdesk-test-pg-'));
  const server = new EmbeddedPostgres({
    databaseDir: dir,
    user: 'postgres',
    password: 'postgres',
    port,
    persistent: false,
    onLog: () => {},
  });
  await server.initialise();
  await server.start();
  const admin = server.getPgClient();
  await admin.connect();
  await admin.query('CREATE DATABASE opsdesk_test');
  await admin.end();

  const { migrate } = await import('../src/db/migrate.js');
  const client = new pg.Client({ connectionString: `postgres://postgres:postgres@localhost:${port}/opsdesk_test` });
  await client.connect();
  await migrate(client);
  await client.end();

  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
