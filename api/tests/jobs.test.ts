/**
 * Asynchronous processing: what happens when jobs fail, run twice, or are delayed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handlers, processJobs, scanSla } from '../src/jobs/worker.js';
import { createItem, login, pool, resetDb } from './helpers.js';

beforeEach(resetDb);

const drain = async () => {
  while ((await processJobs(50)) > 0) {
    /* keep going */
  }
};

describe('notification fan-out', () => {
  it('notifies watchers and the new owner, but not the actor', async () => {
    const [rahul, priya] = await Promise.all([login('rahul'), login('priya')]);
    const item = await createItem(rahul);
    await drain();
    await priya.request('POST', `/api/items/${item.id}/assign`, { userId: rahul.userId });
    await drain();
    const notes = await pool.query('SELECT user_id FROM notifications WHERE work_item_id = $1', [item.id]);
    const users = notes.rows.map((r) => r.user_id);
    expect(users).toContain(rahul.userId);
    expect(users).not.toContain(priya.userId);
  });

  it('approval requests reach the team leads', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul, { type: 'PAYMENT', assignToMe: true });
    await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'IN_PROGRESS' });
    await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'PENDING_APPROVAL' });
    await drain();
    const priyaId = (await pool.query(`SELECT id FROM users WHERE email = 'priya@opsdesk.dev'`)).rows[0].id;
    const n = await pool.query(
      `SELECT count(*) AS n FROM notifications n JOIN activity_events e ON e.id = n.event_id
       WHERE n.user_id = $1 AND e.type = 'APPROVAL_REQUESTED'`,
      [priyaId],
    );
    expect(n.rows[0].n).toBe(1);
  });

  it('running the same job twice does not double-notify (idempotent handler)', async () => {
    const [rahul, priya] = await Promise.all([login('rahul'), login('priya')]);
    const item = await createItem(rahul);
    await priya.request('POST', `/api/items/${item.id}/comments`, { body: 'ping' });
    await drain();
    const before = (await pool.query('SELECT count(*) AS n FROM notifications')).rows[0].n;
    // Simulate redelivery: a worker crashed after doing the work but before acking.
    await pool.query(`UPDATE jobs SET status = 'PENDING', run_at = now() WHERE type = 'notify'`);
    await drain();
    expect((await pool.query('SELECT count(*) AS n FROM notifications')).rows[0].n).toBe(before);
  });
});

describe('failure handling', () => {
  const original = { ...handlers };
  afterEach(() => Object.assign(handlers, original));

  it('retries with backoff, then dead-letters without blocking other jobs', async () => {
    let calls = 0;
    handlers.flaky = async () => {
      calls++;
      throw new Error('downstream unavailable');
    };
    handlers.ok = async () => {};
    await pool.query(`INSERT INTO jobs(type, payload) VALUES ('flaky', '{}'), ('ok', '{}')`);

    await processJobs();
    let flaky = (await pool.query(`SELECT * FROM jobs WHERE type = 'flaky'`)).rows[0];
    expect(flaky.status).toBe('PENDING');
    expect(flaky.attempts).toBe(1);
    expect(new Date(flaky.run_at).getTime()).toBeGreaterThan(Date.now()); // backed off
    expect((await pool.query(`SELECT status FROM jobs WHERE type = 'ok'`)).rows[0].status).toBe('DONE');

    for (let i = 0; i < 10; i++) {
      await pool.query(`UPDATE jobs SET run_at = now() WHERE type = 'flaky' AND status = 'PENDING'`);
      await processJobs();
    }
    flaky = (await pool.query(`SELECT * FROM jobs WHERE type = 'flaky'`)).rows[0];
    expect(flaky.status).toBe('DEAD');
    expect(flaky.attempts).toBe(5);
    expect(calls).toBe(5);
    expect(flaky.last_error).toContain('downstream unavailable');
  });

  it('a failing job rolls back its own partial writes', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul);
    const ev = (await pool.query('SELECT id FROM activity_events WHERE work_item_id = $1', [item.id])).rows[0].id;
    handlers.half = async (tx) => {
      await tx.query(`INSERT INTO notifications(user_id, work_item_id, event_id) VALUES ($1, $2, $3)`, [
        rahul.userId,
        item.id,
        ev,
      ]);
      throw new Error('crash after partial write');
    };
    await pool.query(`DELETE FROM jobs`);
    await pool.query(`INSERT INTO jobs(type, payload) VALUES ('half', '{}')`);
    await processJobs();
    expect((await pool.query('SELECT count(*) AS n FROM notifications')).rows[0].n).toBe(0);
  });

  it('concurrent workers never process the same job twice (SKIP LOCKED)', async () => {
    let calls = 0;
    handlers.slow = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 20));
    };
    await pool.query(`DELETE FROM jobs`);
    await pool.query(`INSERT INTO jobs(type, payload) SELECT 'slow', '{}' FROM generate_series(1, 30)`);
    await Promise.all([processJobs(10), processJobs(10), processJobs(10), processJobs(10)]);
    await drain();
    expect(calls).toBe(30);
    expect((await pool.query(`SELECT count(*) AS n FROM jobs WHERE status = 'DONE'`)).rows[0].n).toBe(30);
  });
});

describe('SLA scan', () => {
  it('flags overdue items once, even if run repeatedly or concurrently', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul, { dueAt: new Date(Date.now() - 60_000).toISOString() });
    await pool.query('UPDATE work_items SET sla_breached_at = now() WHERE id <> $1', [item.id]);
    const counts = await Promise.all([scanSla(), scanSla(), scanSla()]);
    expect(counts.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await scanSla()).toBe(0);
    const evs = await pool.query(`SELECT count(*) AS n FROM activity_events WHERE work_item_id = $1 AND type = 'SLA_BREACHED'`, [
      item.id,
    ]);
    expect(evs.rows[0].n).toBe(1);
  });

  it('changing the due date re-arms the SLA flag', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul, { dueAt: new Date(Date.now() - 60_000).toISOString() });
    await scanSla();
    const fresh = await rahul.request('GET', `/api/items/${item.id}`);
    expect(fresh.body.slaBreachedAt).not.toBeNull();
    const res = await rahul.request('PATCH', `/api/items/${item.id}`, {
      version: fresh.body.version,
      dueAt: new Date(Date.now() + 3600_000).toISOString(),
    });
    expect(res.body.slaBreachedAt).toBeNull();
  });
});
