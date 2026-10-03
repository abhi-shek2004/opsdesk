import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './db/migrate.js';
import { pool, waitForDb } from './db/pool.js';
import { liveHub } from './lib/live.js';

await waitForDb();
await migrate(pool);
await liveHub.start();

const app = await buildApp({ serveWeb: true });
await app.listen({ port: config.port, host: config.host });

async function shutdown() {
  await liveHub.stop();
  await app.close();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
