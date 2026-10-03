import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ITEM_TYPES, PRIORITIES, STATUSES } from '../domain/types.js';
import * as items from '../services/items.js';

const uuid = z.uuid();
const idParams = z.object({ id: uuid });

/** "OPEN,IN_PROGRESS" → ['OPEN','IN_PROGRESS'] */
const csvEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .transform((s) =>
      s
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)))
    .optional();

const boolFlag = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1')
  .optional();

const listQuery = z.object({
  team: uuid.optional(),
  status: csvEnum(STATUSES),
  priority: csvEnum(PRIORITIES),
  type: csvEnum(ITEM_TYPES),
  owner: z.union([z.literal('me'), z.literal('none'), uuid]).optional(),
  createdBy: z.union([z.literal('me'), uuid]).optional(),
  q: z.string().max(200).optional(),
  active: boolFlag,
  overdue: boolFlag,
  watching: boolFlag,
  sort: z.enum(['updated', 'created', 'priority']).default('updated'),
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const isoDate = z.iso.datetime({ offset: true });

const createBody = z.object({
  teamId: uuid,
  type: z.enum(ITEM_TYPES),
  title: z.string().trim().min(1, 'Title is required').max(200),
  description: z.string().max(20_000).optional(),
  priority: z.enum(PRIORITIES).default('P3'),
  dueAt: isoDate.nullable().optional(),
  requiresApproval: z.boolean().optional(),
  assignToMe: z.boolean().optional(),
});

const updateBody = z.object({
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().max(20_000).optional(),
  priority: z.enum(PRIORITIES).optional(),
  type: z.enum(ITEM_TYPES).optional(),
  dueAt: isoDate.nullable().optional(),
  requiresApproval: z.boolean().optional(),
});

const transitionBody = z.object({
  to: z.enum(STATUSES),
  version: z.number().int().positive().optional(),
  reason: z.string().max(2000).optional(),
  resolution: z.string().max(5000).optional(),
});

const assignBody = z.object({
  userId: uuid.nullable(),
  version: z.number().int().positive().optional(),
});

const decisionBody = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']),
  reason: z.string().max(2000).optional(),
});

const commentBody = z.object({ body: z.string().trim().min(1, 'Comment cannot be empty').max(10_000) });

function idempotencyKey(req: FastifyRequest): string | undefined {
  const v = req.headers['idempotency-key'];
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function sendIdempotent(reply: FastifyReply, r: { status: number; body: unknown; replayed: boolean }) {
  if (r.replayed) reply.header('Idempotent-Replayed', 'true');
  return reply.status(r.status).send(r.body);
}

export async function registerItemRoutes(app: FastifyInstance) {
  app.get('/api/items', async (req) => {
    const q = listQuery.parse(req.query);
    return items.listItems(req.actor, {
      teamId: q.team,
      status: q.status,
      priority: q.priority,
      type: q.type,
      owner: q.owner,
      createdBy: q.createdBy,
      q: q.q,
      active: q.active,
      overdue: q.overdue,
      watching: q.watching,
      sort: q.sort,
      cursor: q.cursor,
      limit: q.limit,
    });
  });

  app.get('/api/items/similar', async (req) => {
    const q = z.object({ q: z.string().max(200), team: uuid.optional() }).parse(req.query);
    return { items: await items.findSimilar(req.actor, q.team, q.q) };
  });

  app.post('/api/items', async (req, reply) => {
    const body = createBody.parse(req.body);
    return sendIdempotent(reply, await items.createItem(req.actor, body, idempotencyKey(req)));
  });

  app.get('/api/items/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    return items.getItem(req.actor, id);
  });

  app.patch('/api/items/:id', async (req) => {
    const { id } = idParams.parse(req.params);
    const { version, ...patch } = updateBody.parse(req.body);
    return items.updateItem(req.actor, id, version, patch);
  });

  app.post('/api/items/:id/claim', async (req) => {
    const { id } = idParams.parse(req.params);
    return items.claimItem(req.actor, id);
  });

  app.post('/api/items/:id/assign', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = assignBody.parse(req.body);
    return items.assignItem(req.actor, id, body.version, body.userId);
  });

  app.post('/api/items/:id/transition', async (req) => {
    const { id } = idParams.parse(req.params);
    return items.transitionItem(req.actor, id, transitionBody.parse(req.body));
  });

  app.post('/api/items/:id/approval', async (req) => {
    const { id } = idParams.parse(req.params);
    const body = decisionBody.parse(req.body);
    return items.decideApproval(req.actor, id, body.decision, body.reason);
  });

  app.get('/api/items/:id/activity', async (req) => {
    const { id } = idParams.parse(req.params);
    const q = z
      .object({
        before: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(100).default(50),
      })
      .parse(req.query);
    return items.listActivity(req.actor, id, q.before, q.limit);
  });

  app.post('/api/items/:id/comments', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const { body } = commentBody.parse(req.body);
    return sendIdempotent(reply, await items.addComment(req.actor, id, body, idempotencyKey(req)));
  });

  app.put('/api/items/:id/watch', async (req) => {
    const { id } = idParams.parse(req.params);
    return items.setWatching(req.actor, id, true);
  });

  app.delete('/api/items/:id/watch', async (req) => {
    const { id } = idParams.parse(req.params);
    return items.setWatching(req.actor, id, false);
  });
}
