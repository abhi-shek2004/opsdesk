import { defineConfig } from 'vitest/config';

const TEST_PG_PORT = 54339;

export default defineConfig({
  test: {
    globalSetup: ['./tests/global-setup.ts'],
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: `postgres://postgres:postgres@localhost:${TEST_PG_PORT}/opsdesk_test`,
      TEST_PG_PORT: String(TEST_PG_PORT),
      DB_POOL_SIZE: '30',
    },
    // All test files share one database; run them one after another.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
