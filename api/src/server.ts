import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool, waitForDb } from './db/pool.js';
import { startWorker } from './jobs/runner.js';
import { liveHub } from './lib/live.js';

await waitForDb();
await migrate(pool);

// Hosted demo: load demo data into an empty database on first boot.
if (process.env.SEED_DEMO_DATA === '1') {
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM users');
  if (rows[0].n === 0) {
    const { seedDatabase } = await import('./db/seed.js');
    console.log('[api] empty database — seeding demo data…');
    await seedDatabase(pool);
  }
}

await liveHub.start();
const stopWorker = process.env.WORKER_IN_PROCESS === '1' ? await startWorker() : null;

const app = await buildApp({ serveWeb: true });
await app.listen({ port: config.port, host: config.host });

async function shutdown() {
  await stopWorker?.();
  await liveHub.stop();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
