/**
 * Authorization is enforced by the server, per resource — never by hiding buttons.
 * Every request here is one a malicious or curious user could send with curl.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { createItem, getApp, login, resetDb, teamId } from './helpers.js';

beforeEach(resetDb);

describe('authentication & CSRF', () => {
  it('rejects unauthenticated requests', async () => {
    const app = await getApp();
    const res = await app.inject({ method: 'GET', url: '/api/items' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects wrong passwords without revealing whether the user exists', async () => {
    const app = await getApp();
    const send = (email: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-requested-with': 'opsdesk' },
        payload: { email, password: 'wrong' },
      });
    const [known, unknown] = await Promise.all([send('rahul@opsdesk.dev'), send('nobody@opsdesk.dev')]);
    expect(known.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(known.json().error.code).toBe(unknown.json().error.code);
  });

  it('locks an account out after repeated wrong passwords, without affecting other accounts', async () => {
    const app = await getApp();
    const attempt = (email: string, password: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        headers: { 'x-requested-with': 'opsdesk' },
        payload: { email, password },
      });
    for (let i = 0; i < 8; i++) expect((await attempt('rahul@opsdesk.dev', 'guess')).statusCode).toBe(401);
    const blocked = await attempt('rahul@opsdesk.dev', 'password123'); // even the right password
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe('TOO_MANY_ATTEMPTS');
    expect((await attempt('priya@opsdesk.dev', 'password123')).statusCode).toBe(200);
  });

  it('rejects state-changing requests without the anti-CSRF header', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul);
    const res = await rahul.request('POST', `/api/items/${item.id}/claim`, undefined, { 'x-requested-with': '' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CSRF_CHECK_FAILED');
  });
});

describe('team-scoped access', () => {
  it('hides items from other teams entirely (404, not 403)', async () => {
    const sam = await login('sam'); // ENG lead, SUP member — not in Payments
    const rahul = await login('rahul');
    const item = await createItem(rahul); // PAY item
    expect((await sam.request('GET', `/api/items/${item.id}`)).status).toBe(404);
    expect((await sam.request('PATCH', `/api/items/${item.id}`, { version: 1, title: 'x' })).status).toBe(404);
    expect((await sam.request('POST', `/api/items/${item.id}/claim`)).status).toBe(404);
    expect((await sam.request('GET', `/api/items/${item.id}/activity`)).status).toBe(404);
  });

  it('list and search never return items from teams you are not in', async () => {
    const sam = await login('sam');
    const res = await sam.request('GET', '/api/items?limit=100');
    const payId = await teamId('PAY');
    expect(res.body.items.length).toBeGreaterThan(0);
    expect(res.body.items.every((i: any) => i.team.id !== payId)).toBe(true);
    const filtered = await sam.request('GET', `/api/items?team=${payId}`);
    expect(filtered.body.items).toHaveLength(0);
  });

  it('cannot create items in a team you do not belong to', async () => {
    const sam = await login('sam');
    const res = await sam.request('POST', '/api/items', {
      teamId: await teamId('PAY'),
      type: 'TASK',
      title: 'Sneaky',
      priority: 'P3',
    });
    expect(res.status).toBe(404);
  });
});

describe('role-based permissions', () => {
  it('viewers can read and comment but cannot create, edit or claim', async () => {
    const vera = await login('vera'); // PAY viewer
    const rahul = await login('rahul');
    const item = await createItem(rahul);

    expect((await vera.request('GET', `/api/items/${item.id}`)).status).toBe(200);
    expect((await vera.request('POST', `/api/items/${item.id}/comments`, { body: 'FYI' })).status).toBe(201);
    expect((await vera.request('PATCH', `/api/items/${item.id}`, { version: item.version, title: 'x' })).status).toBe(
      403,
    );
    expect((await vera.request('POST', `/api/items/${item.id}/claim`)).status).toBe(403);
    expect(
      (
        await vera.request('POST', '/api/items', {
          teamId: await teamId('PAY'),
          type: 'TASK',
          title: 'x',
          priority: 'P3',
        })
      ).status,
    ).toBe(403);
  });

  it('members cannot edit work they neither own nor created', async () => {
    const [priya, alex] = await Promise.all([login('priya'), login('alex')]); // alex: PAY member
    const item = await createItem(priya);
    const res = await alex.request('PATCH', `/api/items/${item.id}`, { version: item.version, title: 'Mine now' });
    expect(res.status).toBe(403);
  });

  it('only leads can assign work to someone else or cancel it', async () => {
    const [rahul, alex, priya] = await Promise.all([login('rahul'), login('alex'), login('priya')]);
    const item = await createItem(rahul);
    expect((await rahul.request('POST', `/api/items/${item.id}/assign`, { userId: alex.userId })).status).toBe(403);
    expect(
      (await rahul.request('POST', `/api/items/${item.id}/transition`, { to: 'CANCELLED', reason: 'dup' })).status,
    ).toBe(403);
    expect((await priya.request('POST', `/api/items/${item.id}/assign`, { userId: alex.userId })).status).toBe(200);
  });

  it('cannot assign work to someone outside the team', async () => {
    const [priya, sam] = await Promise.all([login('priya'), login('sam')]);
    const item = await createItem(priya);
    const res = await priya.request('POST', `/api/items/${item.id}/assign`, { userId: sam.userId });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('INVALID_ASSIGNEE');
  });

  it('nobody — including admins — can approve their own work', async () => {
    const admin = await login('admin');
    const item = await createItem(admin, { type: 'PAYMENT', assignToMe: true });
    await admin.request('POST', `/api/items/${item.id}/transition`, { to: 'IN_PROGRESS' });
    await admin.request('POST', `/api/items/${item.id}/transition`, { to: 'PENDING_APPROVAL' });
    const res = await admin.request('POST', `/api/items/${item.id}/approval`, { decision: 'APPROVED' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('SELF_APPROVAL');
  });

  it('members cannot waive the approval requirement on payment items', async () => {
    const rahul = await login('rahul');
    const item = await createItem(rahul, { type: 'PAYMENT', requiresApproval: false });
    expect(item.requiresApproval).toBe(true);
    const res = await rahul.request('PATCH', `/api/items/${item.id}`, {
      version: item.version,
      requiresApproval: false,
    });
    expect(res.status).toBe(403);
  });

  it('removing someone from a team revokes access on their very next request (identity cache invalidated)', async () => {
    const [admin, alex, rahul] = await Promise.all([login('admin'), login('alex'), login('rahul')]);
    const item = await createItem(rahul);
    expect((await alex.request('GET', `/api/items/${item.id}`)).status).toBe(200); // warms the cache
    const pay = await teamId('PAY');
    expect((await admin.request('DELETE', `/api/teams/${pay}/members/${alex.userId}`)).status).toBe(200);
    expect((await alex.request('GET', `/api/items/${item.id}`)).status).toBe(404);
  });

  it('logging out invalidates the session immediately', async () => {
    const rahul = await login('rahul');
    expect((await rahul.request('GET', '/api/me')).status).toBe(200);
    await rahul.request('POST', '/api/auth/logout');
    expect((await rahul.request('GET', '/api/me')).status).toBe(401);
  });

  it('users can only mark their own notifications as read', async () => {
    const [rahul, priya] = await Promise.all([login('rahul'), login('priya')]);
    const { pool } = await import('./helpers.js');
    const item = await createItem(rahul);
    const ev = await pool.query(`SELECT id FROM activity_events WHERE work_item_id = $1 LIMIT 1`, [item.id]);
    const n = await pool.query(
      `INSERT INTO notifications(user_id, work_item_id, event_id) VALUES ($1, $2, $3) RETURNING id`,
      [rahul.userId, item.id, ev.rows[0].id],
    );
    await priya.request('POST', '/api/notifications/read', { ids: [n.rows[0].id] });
    const row = await pool.query('SELECT read_at FROM notifications WHERE id = $1', [n.rows[0].id]);
    expect(row.rows[0].read_at).toBeNull();
  });
});
