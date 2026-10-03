import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config, SESSION_COOKIE } from '../config.js';
import { pool } from '../db/pool.js';
import { ROLES } from '../domain/types.js';
import { liveHub } from '../lib/live.js';
import * as auth from '../services/auth.js';
import { getDashboard, listApprovalQueue } from '../services/dashboard.js';
import * as notifications from '../services/notifications.js';
import * as teams from '../services/teams.js';

const uuid = z.uuid();

export async function registerRoutes(app: FastifyInstance) {
  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { ok: true };
  });

  // ── Auth ──
  app.post('/api/auth/login', async (req, reply) => {
    const body = z.object({ email: z.string().min(1).max(200), password: z.string().min(1).max(200) }).parse(req.body);
    const { token, expiresAt } = await auth.login(body.email, body.password, req.ip);
    reply.setCookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      path: '/',
      expires: expiresAt,
    });
    const actor = await auth.actorFromToken(token);
    return auth.describeMe(actor!);
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await auth.logout(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => auth.describeMe(req.actor));

  // ── Dashboard & approvals ──
  app.get('/api/dashboard', async (req) => getDashboard(req.actor));
  app.get('/api/approvals', async (req) => ({ approvals: await listApprovalQueue(req.actor) }));

  // ── Teams ──
  app.get('/api/teams', async (req) => ({ teams: await teams.listTeams(req.actor) }));

  app.get('/api/teams/:id/members', async (req) => {
    const { id } = z.object({ id: uuid }).parse(req.params);
    return { members: await teams.listMembers(req.actor, id) };
  });

  app.put('/api/teams/:id/members/:userId', async (req) => {
    const { id, userId } = z.object({ id: uuid, userId: uuid }).parse(req.params);
    const { role } = z.object({ role: z.enum(ROLES) }).parse(req.body);
    await teams.setMemberRole(req.actor, id, userId, role);
    return { ok: true };
  });

  app.delete('/api/teams/:id/members/:userId', async (req) => {
    const { id, userId } = z.object({ id: uuid, userId: uuid }).parse(req.params);
    await teams.removeMember(req.actor, id, userId);
    return { ok: true };
  });

  app.get('/api/users', async (req) => {
    const { q } = z.object({ q: z.string().max(100).default('') }).parse(req.query);
    return { users: await teams.searchUsers(req.actor, q) };
  });

  // ── Notifications ──
  app.get('/api/notifications', async (req) => {
    const q = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(50).default(20),
      })
      .parse(req.query);
    return notifications.listNotifications(req.actor, q.before, q.limit);
  });

  app.post('/api/notifications/read', async (req) => {
    const body = z
      .object({ ids: z.array(z.number().int()).max(500).optional(), all: z.boolean().optional() })
      .parse(req.body);
    await notifications.markRead(req.actor, body.all ? 'all' : (body.ids ?? []));
    return { ok: true };
  });

  // ── Admin: background jobs ──
  app.get('/api/admin/jobs', async (req) => {
    const { status } = z.object({ status: z.enum(['PENDING', 'DONE', 'DEAD']).default('DEAD') }).parse(req.query);
    return notifications.listJobs(req.actor, status);
  });

  app.post('/api/admin/jobs/:id/retry', async (req) => {
    const { id } = z.object({ id: z.coerce.number().int() }).parse(req.params);
    await notifications.retryJob(req.actor, id);
    return { ok: true };
  });

  // ── Live updates (SSE) ──
  app.get('/api/events', (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const remove = liveHub.add(req.actor, reply.raw);
    req.raw.on('close', remove);
  });
}
