import type { FastifyInstance, InjectOptions } from 'fastify';
import { buildApp } from '../src/app.js';
import { pool } from '../src/db/pool.js';
import { DEMO_PASSWORD, seedDatabase } from '../src/db/seed.js';
import { resetLoginThrottle } from '../src/services/auth.js';

export { pool };

let app: FastifyInstance | null = null;

export async function getApp() {
  app ??= await buildApp();
  return app;
}

/** Fresh, deterministic dataset (demo users + a small number of generated items). */
export async function resetDb() {
  resetLoginThrottle();
  await seedDatabase(pool, { items: 60, quiet: true });
}

export interface Client {
  userId: string;
  request: (method: InjectOptions['method'], url: string, body?: unknown, headers?: Record<string, string>) => Promise<{
    status: number;
    body: any;
    headers: Record<string, unknown>;
  }>;
}

export async function login(name: string): Promise<Client> {
  const a = await getApp();
  const res = await a.inject({
    method: 'POST',
    url: '/api/auth/login',
    headers: { 'x-requested-with': 'opsdesk' },
    payload: { email: `${name}@opsdesk.dev`, password: DEMO_PASSWORD },
  });
  if (res.statusCode !== 200) throw new Error(`login failed for ${name}: ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'opsdesk_session')!;
  const userId = res.json().id;
  return {
    userId,
    async request(method, url, body, headers = {}) {
      const r = await a.inject({
        method,
        url,
        payload: body as any,
        cookies: { opsdesk_session: cookie.value },
        headers: { 'x-requested-with': 'opsdesk', ...headers },
      });
      return { status: r.statusCode, body: r.body ? r.json() : null, headers: r.headers };
    },
  };
}

export async function teamId(key: string): Promise<string> {
  return (await pool.query('SELECT id FROM teams WHERE key = $1', [key])).rows[0].id;
}

export async function itemByKey(key: string) {
  return (await pool.query('SELECT * FROM work_items WHERE key = $1', [key])).rows[0];
}

export async function createItem(client: Client, overrides: Record<string, unknown> = {}) {
  const res = await client.request('POST', '/api/items', {
    teamId: await teamId('PAY'),
    type: 'TASK',
    title: 'Test item',
    priority: 'P3',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`create failed: ${JSON.stringify(res.body)}`);
  return res.body;
}

export async function eventsFor(itemId: string): Promise<{ type: string; payload: any; actor_id: string | null }[]> {
  return (await pool.query('SELECT type, payload, actor_id FROM activity_events WHERE work_item_id = $1 ORDER BY id', [itemId]))
    .rows;
}
