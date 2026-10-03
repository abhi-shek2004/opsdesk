import pg from 'pg';
import { config } from '../config.js';
import { JOBS_CHANNEL } from '../lib/outbox.js';
import { cleanup, processJobs, scanSla } from './worker.js';

/**
 * Start the background job loop. Runs as its own process locally (`npm run worker`)
 * or inside the API process on single-service hosting (WORKER_IN_PROCESS=1).
 * Both are safe to run at once: jobs are claimed with FOR UPDATE SKIP LOCKED.
 * Returns a function that stops the loop and waits for the current batch to finish.
 */
export async function startWorker(): Promise<() => Promise<void>> {
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
  console.log('[worker] started');

  return async () => {
    stopping = true;
    wake?.();
    clearInterval(slaTimer);
    clearInterval(cleanupTimer);
    await done;
    await listener.end().catch(() => {});
    console.log('[worker] stopped');
  };
}
