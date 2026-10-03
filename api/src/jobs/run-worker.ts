import { pool, waitForDb } from '../db/pool.js';
import { startWorker } from './runner.js';

await waitForDb();
const stop = await startWorker();

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await stop();
  await pool.end();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
