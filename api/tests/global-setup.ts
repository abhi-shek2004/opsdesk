/**
 * Prepares a real PostgreSQL for the test run. Concurrency guarantees (row locks,
 * unique indexes, SKIP LOCKED) can only be verified against a real database.
 *
 * - Default: boots a throwaway embedded PostgreSQL and deletes it afterwards.
 * - TEST_DATABASE_URL set: uses that (dedicated, disposable) database as-is.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import pg from 'pg';

async function migrateDatabase(connectionString: string) {
  const { migrate } = await import('../src/db/migrate.js');
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await migrate(client);
  } finally {
    await client.end();
  }
}

export default async function setup() {
  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    await migrateDatabase(external);
    return async () => {};
  }

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

  await migrateDatabase(`postgres://postgres:postgres@localhost:${port}/opsdesk_test`);

  return async () => {
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  };
}
