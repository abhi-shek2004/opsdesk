import pg from 'pg';
import { config } from '../config.js';
import { pool, waitForDb } from '../db/pool.js';
import { JOBS_CHANNEL } from '../lib/outbox.js';
import { cleanup, processJobs, scanSla } from './worker.js';

await waitForDb();
console.log('[worker] started');

let stopping = false;
let wake: (() => void) | null = null;

// LISTEN for new jobs so notifications go out immediately; polling is the fallback.
const listener = new pg.Client({ connectionString: config.databaseUrl });
await listener.connect();
await listener.query(`LISTEN ${JOBS_CHANNEL}`);
listener.on('notification', () => wake?.());
listener.on('error', (err) => console.error('[worker] listener error', err));

async function loop() {
  while (!stopping) {
    try {
      const n = await processJobs();
      if (n > 0) continue; // drain quickly while there is work
    } catch (err) {
      console.error('[worker] batch failed', err);
    }
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, config.job.pollMs);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
    wake = null;
  }
}

const slaTimer = setInterval(() => {
  scanSla()
    .then((n) => n && console.log(`[worker] flagged ${n} overdue item(s)`))
    .catch((err) => console.error('[worker] SLA scan failed', err));
}, config.job.slaScanMs);
const cleanupTimer = setInterval(() => cleanup().catch(() => {}), 60 * 60_000);
scanSla().catch(() => {});

const done = loop();

async function shutdown() {
  if (stopping) return;
  stopping = true;
  wake?.();
  clearInterval(slaTimer);
  clearInterval(cleanupTimer);
  await done;
  await listener.end();
  await pool.end();
  console.log('[worker] stopped');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
