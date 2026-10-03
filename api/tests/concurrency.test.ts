/**
 * The behaviours that are most dangerous when wrong: several people acting on
 * the same work at the same moment, and clients retrying requests.
 * These run real parallel requests against a real PostgreSQL.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createItem, eventsFor, login, pool, resetDb, teamId } from './helpers.js';

beforeEach(resetDb);

describe('claiming work', () => {
  it('exactly one of many simultaneous claims wins; the rest get 409 ALREADY_CLAIMED', async () => {
    const priya = await login('priya');
    const item = await createItem(priya, { title: 'Hot potato' });
    const claimers = await Promise.all(['rahul', 'alex', 'priya'].map(login));

    // 3 users × 4 attempts each = 12 concurrent claim requests.
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) => claimers[i % 3].request('POST', `/api/items/${item.id}/claim`)),
    );

    const owners = new Set(results.filter((r) => r.status === 200).map((r) => r.body.owner.id));
    expect(owners.size).toBe(1); // a single owner, ever
    const winner = [...owners][0];
    for (const r of results) {
      if (r.status === 200)
        expect(r.body.owner.id).toBe(winner); // winner's own retries are no-ops
      else {
        expect(r.status).toBe(409);
        expect(r.body.error.code).toBe('ALREADY_CLAIMED');
      }
    }
    // History records the claim once, not once per attempt.
    const assigned = (await eventsFor(item.id)).filter((e) => e.type === 'ASSIGNED');
    expect(assigned).toHaveLength(1);
  });

  it('claiming an item you already own is a safe no-op (retry after timeout)', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul);
    const first = await rahul.request('POST', `/api/items/${item.id}/claim`);
    const retry = await rahul.request('POST', `/api/items/${item.id}/claim`);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.body.version).toBe(first.body.version);
  });
});

describe('optimistic concurrency (stale edits)', () => {
  it('rejects an edit based on an old version with 409 and returns the current item', async () => {
    const priya = await login('priya');
    const item = await createItem(priya, { title: 'Original' });

    const a = await priya.request('PATCH', `/api/items/${item.id}`, { version: item.version, priority: 'P1' });
    expect(a.status).toBe(200);

    const stale = await priya.request('PATCH', `/api/items/${item.id}`, { version: item.version, title: 'Overwrite' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('VERSION_CONFLICT');
    expect(stale.body.error.details.current.priority).toBe('P1');
    expect(stale.body.error.details.current.version).toBe(a.body.version);

    const row = (await pool.query('SELECT title FROM work_items WHERE id = $1', [item.id])).rows[0];
    expect(row.title).toBe('Original'); // lost update prevented
  });

  it('of N concurrent edits from the same version, exactly one is applied', async () => {
    const [priya, rahul] = await Promise.all([login('priya'), login('rahul')]);
    const item = await createItem(rahul);
    const editors = [priya, rahul, priya, rahul, priya, rahul];
    const results = await Promise.all(
      editors.map((c, i) => c.request('PATCH', `/api/items/${item.id}`, { version: item.version, title: `Edit ${i}` })),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(editors.length - 1);
    const row = (await pool.query('SELECT version FROM work_items WHERE id = $1', [item.id])).rows[0];
    expect(row.version).toBe(item.version + 1);
  });
});

describe('idempotent creation (double clicks & retries)', () => {
  it('the same Idempotency-Key sent concurrently creates exactly one item', async () => {
    const rahul = await login('rahul');
    const body = { teamId: await teamId('PAY'), type: 'TASK', title: 'Double-clicked create', priority: 'P2' };
    const results = await Promise.all(
      Array.from({ length: 8 }, () => rahul.request('POST', '/api/items', body, { 'idempotency-key': 'key-123' })),
    );
    expect(results.every((r) => r.status === 201)).toBe(true);
    expect(new Set(results.map((r) => r.body.id)).size).toBe(1);
    expect(results.filter((r) => r.headers['idempotent-replayed'] === 'true')).toHaveLength(7);
    const count = await pool.query(`SELECT count(*) AS n FROM work_items WHERE title = 'Double-clicked create'`);
    expect(count.rows[0].n).toBe(1);
  });

  it('reusing a key for a different payload is rejected', async () => {
    const rahul = await login('rahul');
    const base = { teamId: await teamId('PAY'), type: 'TASK', priority: 'P2' };
    await rahul.request('POST', '/api/items', { ...base, title: 'First' }, { 'idempotency-key': 'k' });
    const res = await rahul.request('POST', '/api/items', { ...base, title: 'Second' }, { 'idempotency-key': 'k' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
  });

  it('keys are scoped per user', async () => {
    const [rahul, alex] = await Promise.all([login('rahul'), login('alex')]);
    const body = { teamId: await teamId('PAY'), type: 'TASK', title: 'Same key', priority: 'P2' };
    const a = await rahul.request('POST', '/api/items', body, { 'idempotency-key': 'shared' });
    const b = await alex.request('POST', '/api/items', body, { 'idempotency-key': 'shared' });
    expect(a.body.id).not.toBe(b.body.id);
  });

  it('retried comments are not duplicated', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul);
    await Promise.all(
      [1, 2, 3].map(() =>
        rahul.request('POST', `/api/items/${item.id}/comments`, { body: 'Only once' }, { 'idempotency-key': 'c1' }),
      ),
    );
    expect((await eventsFor(item.id)).filter((e) => e.type === 'COMMENTED')).toHaveLength(1);
  });
});

describe('approval races', () => {
  it('two leads deciding at the same time: exactly one decision is recorded', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul, { type: 'PAYMENT', title: 'Refund', assignToMe: true });
    const started = await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'IN_PROGRESS' });
    expect(started.status).toBe(200);
    const req = await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'PENDING_APPROVAL' });
    expect(req.status).toBe(200);

    const [priya, admin] = await Promise.all([login('priya'), login('admin')]);
    const [p, a] = await Promise.all([
      priya.request('POST', `/api/items/${item.id}/approval`, { decision: 'APPROVED' }),
      admin.request('POST', `/api/items/${item.id}/approval`, { decision: 'REJECTED', reason: 'No' }),
    ]);
    const statuses = [p.status, a.status].sort();
    expect(statuses).toEqual([200, 409]);
    const decided = await pool.query(
      'SELECT count(*) AS n FROM approvals WHERE work_item_id = $1 AND decided_at IS NOT NULL',
      [item.id],
    );
    expect(decided.rows[0].n).toBe(1);
  });
});

describe('item numbering under load', () => {
  it('concurrent creates in one team get unique, gap-free keys', async () => {
    const rahul = await login('rahul');
    const results = await Promise.all(Array.from({ length: 15 }, (_, i) => createItem(rahul, { title: `Bulk ${i}` })));
    const numbers = results.map((r) => Number(r.key.split('-')[1])).sort((x, y) => x - y);
    expect(new Set(numbers).size).toBe(15);
    expect(numbers[14] - numbers[0]).toBe(14);
  });
});

describe('burst of mixed updates (many users, one item, same moment)', () => {
  it('serialises 50 concurrent operations with no lost update, no gap and no server error', async () => {
    const [rahul, priya, alex, vera] = await Promise.all(['rahul', 'priya', 'alex', 'vera'].map(login));
    const item = await createItem(priya, { title: 'Burst target' });
    const url = `/api/items/${item.id}`;

    const ops: Promise<{ status: number; body: any }>[] = [];
    // 15 comments from everyone (viewers may comment): never conflict, never bump the version.
    for (let i = 0; i < 15; i++) ops.push([rahul, priya, alex, vera][i % 4].request('POST', `${url}/comments`, { body: `c${i}` }));
    // 15 priority edits by the lead, all based on the version she loaded: at most one may win.
    for (let i = 0; i < 15; i++)
      ops.push(priya.request('PATCH', url, { version: item.version, priority: i % 2 ? 'P1' : 'P2' }));
    // 10 claims from two members: exactly one owner.
    for (let i = 0; i < 10; i++) ops.push((i % 2 ? rahul : alex).request('POST', `${url}/claim`));
    // 10 attempts by the lead to block it: legal only once it is in progress, and only once.
    for (let i = 0; i < 10; i++)
      ops.push(priya.request('POST', `${url}/transition`, { to: 'BLOCKED', reason: 'Waiting on bank' }));

    const results = await Promise.all(ops);

    // Every answer is a deliberate one: success, conflict or rule violation. Never a 5xx.
    expect(results.every((r) => [200, 201, 409, 422].includes(r.status))).toBe(true);

    // The versions handed back by successful item writes must form an unbroken sequence 1..final.
    // A lost update or a double-applied write would show up as a gap or a duplicate bump.
    const finalRow = (await pool.query('SELECT version, owner_id, status FROM work_items WHERE id = $1', [item.id]))
      .rows[0];
    const seen = new Set<number>([item.version]);
    for (const r of results) if (r.status === 200 && typeof r.body?.version === 'number') seen.add(r.body.version);
    expect([...seen].sort((a, b) => a - b)).toEqual(Array.from({ length: finalRow.version }, (_, i) => i + 1));

    // History matches what actually happened, exactly once each.
    const events = await eventsFor(item.id);
    const count = (t: string) => events.filter((e) => e.type === t).length;
    expect(count('COMMENTED')).toBe(15);
    expect(count('ASSIGNED')).toBe(1);
    expect(count('PRIORITY_CHANGED')).toBeLessThanOrEqual(1);
    expect(finalRow.owner_id).not.toBeNull();
    expect(['IN_PROGRESS', 'BLOCKED']).toContain(finalRow.status);
  });
});
