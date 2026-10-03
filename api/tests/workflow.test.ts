import { beforeEach, describe, expect, it } from 'vitest';
import { planTransition, TRANSITIONS } from '../src/domain/workflow.js';
import type { ItemState, Status } from '../src/domain/types.js';
import { STATUSES } from '../src/domain/types.js';
import { createItem, eventsFor, login, pool, resetDb } from './helpers.js';

const base: ItemState = {
  id: 'x',
  teamId: 't',
  status: 'IN_PROGRESS',
  ownerId: 'u1',
  createdBy: 'u2',
  requiresApproval: false,
  approvedAt: null,
  version: 1,
};

describe('state machine (pure)', () => {
  it('rejects every transition not in the map', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (TRANSITIONS[from].includes(to)) continue;
        expect(() =>
          planTransition({ ...base, status: from }, to as Status, { reason: 'r', resolution: 'r' }),
        ).toThrow();
      }
    }
  });

  it('closed and cancelled are terminal', () => {
    expect(TRANSITIONS.CLOSED).toHaveLength(0);
    expect(TRANSITIONS.CANCELLED).toHaveLength(0);
  });

  it('cannot resolve approval-gated work without an approval', () => {
    expect(() => planTransition({ ...base, requiresApproval: true }, 'RESOLVED', { resolution: 'done' })).toThrow(
      /requires approval/,
    );
    expect(() =>
      planTransition({ ...base, requiresApproval: true, approvedAt: new Date() }, 'RESOLVED', { resolution: 'done' }),
    ).not.toThrow();
  });

  it('requires an owner for active states', () => {
    expect(() => planTransition({ ...base, status: 'OPEN', ownerId: null }, 'IN_PROGRESS')).toThrow(/owner/);
  });

  it('requires reasons for blocking, cancelling and reopening, and a resolution for resolving', () => {
    expect(() => planTransition(base, 'BLOCKED')).toThrow(/reason/);
    expect(() => planTransition(base, 'CANCELLED', { reason: '  ' })).toThrow(/reason/);
    expect(() => planTransition({ ...base, status: 'RESOLVED' }, 'IN_PROGRESS')).toThrow(/reason/);
    expect(() => planTransition(base, 'RESOLVED')).toThrow(/resolved/);
  });

  it('reopening clears a previous approval', () => {
    const plan = planTransition(
      { ...base, status: 'RESOLVED', requiresApproval: true, approvedAt: new Date() },
      'IN_PROGRESS',
      { reason: 'Customer still affected' },
    );
    expect(plan.clearApproval).toBe(true);
  });
});

describe('workflow through the API', () => {
  beforeEach(resetDb);

  it('full payment lifecycle: request → approve → resolve → close, with complete history', async () => {
    const [rahul, priya] = await Promise.all([login('rahul'), login('priya')]);
    const item = await createItem(rahul, { type: 'PAYMENT', title: 'Refund ₹500' });
    expect(item.requiresApproval).toBe(true);

    await rahul.request('POST', `/api/items/${item.id}/claim`);
    const early = await rahul.request('POST', `/api/items/${item.id}/transition`, {
      to: 'RESOLVED',
      resolution: 'Paid',
    });
    expect(early.status).toBe(422);
    expect(early.body.error.code).toBe('APPROVAL_REQUIRED');

    const pending = await rahul.request('POST', `/api/items/${item.id}/transition`, {
      to: 'PENDING_APPROVAL',
      reason: 'Finance confirmed',
    });
    expect(pending.body.status).toBe('PENDING_APPROVAL');
    expect(pending.body.pendingApproval.requestedBy.id).toBe(rahul.userId);

    // Owner cannot resolve while pending.
    expect(
      (await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'RESOLVED', resolution: 'x' })).status,
    ).toBe(422);

    const approved = await priya.request('POST', `/api/items/${item.id}/approval`, { decision: 'APPROVED' });
    expect(approved.status).toBe(200);
    expect(approved.body.status).toBe('IN_PROGRESS');
    expect(approved.body.approvedBy.id).toBe(priya.userId);

    // Deciding twice is rejected (already decided).
    expect((await priya.request('POST', `/api/items/${item.id}/approval`, { decision: 'APPROVED' })).status).toBe(409);

    const resolved = await rahul.request('POST', `/api/items/${item.id}/transition`, {
      to: 'RESOLVED',
      resolution: 'Refund sent',
    });
    expect(resolved.body.status).toBe('RESOLVED');
    const closed = await priya.request('POST', `/api/items/${item.id}/transition`, { to: 'CLOSED' });
    expect(closed.body.status).toBe('CLOSED');

    // Closed items are read-only.
    expect(
      (await priya.request('PATCH', `/api/items/${item.id}`, { version: closed.body.version, title: 'x' })).status,
    ).toBe(422);

    const types = (await eventsFor(item.id)).map((e) => e.type);
    expect(types).toEqual([
      'CREATED',
      'ASSIGNED',
      'STATUS_CHANGED',
      'APPROVAL_REQUESTED',
      'APPROVED',
      'STATUS_CHANGED',
      'STATUS_CHANGED',
    ]);
  });

  it('rejection requires a reason and sends work back', async () => {
    const [rahul, priya] = await Promise.all([login('rahul'), login('priya')]);
    const item = await createItem(rahul, { type: 'PAYMENT', assignToMe: true });
    await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'IN_PROGRESS' });
    await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'PENDING_APPROVAL' });
    expect((await priya.request('POST', `/api/items/${item.id}/approval`, { decision: 'REJECTED' })).status).toBe(422);
    const res = await priya.request('POST', `/api/items/${item.id}/approval`, {
      decision: 'REJECTED',
      reason: 'Wrong amount',
    });
    expect(res.body.status).toBe('IN_PROGRESS');
    expect(res.body.approvedAt).toBeNull();
  });

  it('reopening a resolved item revokes its approval', async () => {
    const [rahul, priya] = await Promise.all([login('rahul'), login('priya')]);
    const item = await createItem(rahul, { type: 'PAYMENT', assignToMe: true });
    await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'IN_PROGRESS' });
    await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'PENDING_APPROVAL' });
    await priya.request('POST', `/api/items/${item.id}/approval`, { decision: 'APPROVED' });
    await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'RESOLVED', resolution: 'done' });
    const reopened = await rahul.request('POST', `/api/items/${item.id}/transition`, {
      to: 'IN_PROGRESS',
      reason: 'Bounced',
    });
    expect(reopened.body.approvedAt).toBeNull();
    expect(reopened.body.permissions.transitions).not.toContain('RESOLVED');
  });

  it('every change appends history in the same transaction, and failed changes leave no trace', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul);
    const before = (await eventsFor(item.id)).length;
    await rahul.request('PATCH', `/api/items/${item.id}`, { version: item.version, priority: 'P1', title: 'Renamed' });
    const after = await eventsFor(item.id);
    expect(after.length).toBe(before + 2);
    expect(after.find((e) => e.type === 'PRIORITY_CHANGED')?.payload).toEqual({ from: 'P3', to: 'P1' });
    expect(after.find((e) => e.type === 'EDITED')?.payload.changes.title).toEqual({ from: 'Test item', to: 'Renamed' });

    // A rejected change writes no event and no job.
    const jobsBefore = (await pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n;
    await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'BLOCKED' }); // no owner → 422
    expect((await eventsFor(item.id)).length).toBe(after.length);
    expect((await pool.query('SELECT count(*) AS n FROM jobs')).rows[0].n).toBe(jobsBefore);
  });

  it('releasing ownership returns active work to OPEN (DB invariant: active work has an owner)', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul);
    const claimed = await rahul.request('POST', `/api/items/${item.id}/claim`);
    const released = await rahul.request('POST', `/api/items/${item.id}/assign`, {
      userId: null,
      version: claimed.body.version,
    });
    expect(released.body.status).toBe('OPEN');
    expect(released.body.owner).toBeNull();
    await expect(
      pool.query(`UPDATE work_items SET status = 'IN_PROGRESS', owner_id = NULL WHERE id = $1`, [item.id]),
    ).rejects.toThrow(/owned_when_active/);
  });
});

describe('listing at scale', () => {
  beforeEach(resetDb);

  it('cursor pagination visits every visible item exactly once', async () => {
    const admin = await login('admin');
    const seen = new Set<string>();
    let cursor: string | null = null;
    let total = 0;
    do {
      const res: any = await admin.request(
        'GET',
        `/api/items?sort=priority&limit=7${cursor ? `&cursor=${cursor}` : ''}`,
      );
      if (!cursor) total = res.body.total;
      for (const i of res.body.items) {
        expect(seen.has(i.id)).toBe(false);
        seen.add(i.id);
      }
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen.size).toBe(total);
    expect(total).toBe(60);
  });

  it('seeded demo data never marks work as overdue before its due date', async () => {
    const future = await pool.query(
      `SELECT (SELECT count(*) FROM work_items WHERE sla_breached_at > now() OR (sla_breached_at IS NOT NULL AND due_at > now())) AS items,
              (SELECT count(*) FROM activity_events WHERE created_at > now()) AS events`,
    );
    expect(future.rows[0]).toEqual({ items: 0, events: 0 });
  });

  it('search: an item key is an exact lookup; words match by prefix', async () => {
    const rahul = await login('rahul');
    const created = await createItem(rahul, { title: 'Reconcile settlement batch for Zenith' });
    const byKey = await rahul.request('GET', `/api/items?q=${created.key.toLowerCase()}`);
    expect(byKey.body.items.map((i: any) => i.key)).toEqual([created.key]);
    const byPrefix = await rahul.request('GET', '/api/items?q=reconc%20zeni');
    expect(byPrefix.body.items.map((i: any) => i.id)).toContain(created.id);
    const sam = await login('sam'); // not in Payments
    expect((await sam.request('GET', '/api/items?q=reconc%20zeni')).body.items).toHaveLength(0);
  });
});
