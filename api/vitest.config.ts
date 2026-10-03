import { defineConfig } from 'vitest/config';

const TEST_PG_PORT = 54339;

// By default the tests boot their own throwaway PostgreSQL (see tests/global-setup.ts).
// Set TEST_DATABASE_URL to run them against an existing, dedicated database instead
// (CI does this with a Postgres service container). Tests TRUNCATE it: never point it at real data.
const external = process.env.TEST_DATABASE_URL;

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: external ?? `postgres://postgres:postgres@localhost:${TEST_PG_PORT}/opsdesk_test`,
      TEST_PG_PORT: String(TEST_PG_PORT),
      DB_POOL_SIZE: '30',
    },
    // All test files share one database; run them one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
