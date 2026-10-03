import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { config, SESSION_COOKIE } from './config.js';
import type { Actor } from './domain/types.js';
import { AppError, unauthorized } from './lib/errors.js';
import { registerItemRoutes } from './routes/items.js';
import { registerRoutes } from './routes/misc.js';
import { actorFromToken } from './services/auth.js';

declare module 'fastify' {
  interface FastifyRequest {
    actor: Actor;
  }
}


const PUBLIC_ROUTES = new Set(['/api/auth/login', '/api/health']);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export async function buildApp(opts: { serveWeb?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: config.logLevel === 'silent' ? false : { level: config.logLevel },
    bodyLimit: 256 * 1024,
  });
  await app.register(cookie);

  app.decorateRequest('actor', null as unknown as Actor);

  // Authentication + CSRF protection for every /api route.
  app.addHook('onRequest', async (req) => {
    const url = req.url.split('?')[0];
    if (!url.startsWith('/api/')) return;
    if (MUTATING.has(req.method) && req.headers['x-requested-with'] !== 'opsdesk') {
      // A custom header cannot be set by cross-site forms and forces a CORS preflight,
      // so together with SameSite=Lax cookies this blocks CSRF.
      throw new AppError(403, 'CSRF_CHECK_FAILED', 'Missing X-Requested-With header.');
    }
    if (PUBLIC_ROUTES.has(url)) return;
    const token = req.cookies[SESSION_COOKIE];
    const actor = token ? await actorFromToken(token) : null;
    if (!actor) throw unauthorized();
    req.actor = actor;
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
          details: err.issues,
        },
      });
    }
    const pgCode = (err as { code?: string }).code;
    if (pgCode === '23505') {
      return reply.status(409).send({ error: { code: 'DUPLICATE', message: 'That conflicts with an existing record.' } });
    }
    if (pgCode === '22P02' || pgCode === '22007' || pgCode === '22008') {
      return reply.status(400).send({ error: { code: 'VALIDATION_ERROR', message: 'Malformed value in request.' } });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({ error: { code: 'BAD_REQUEST', message: (err as Error).message } });
    }
    req.log.error(err);
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.' } });
  });

  await registerRoutes(app);
  await registerItemRoutes(app);

  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (opts.serveWeb && existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } });
      }
      return reply.sendFile('index.html'); // SPA fallback
    });
  } else {
    app.setNotFoundHandler((_req, reply) =>
      reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Route not found.' } }),
    );
  }

  return app;
}
