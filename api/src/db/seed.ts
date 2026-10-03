/**
 * Demo data: 5 teams, ~45 users, ~6,000 work items with consistent history.
 * WARNING: wipes existing data. Usage: npm run seed [-- --items=6000]
 */
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'node:url';
import type { Db } from './pool.js';

export const DEMO_PASSWORD = 'password123';

const TEAMS = [
  { key: 'PAY', name: 'Payments' },
  { key: 'ENG', name: 'Engineering' },
  { key: 'OPS', name: 'Operations' },
  { key: 'CMP', name: 'Compliance' },
  { key: 'SUP', name: 'Customer Support' },
] as const;

type TeamKey = (typeof TEAMS)[number]['key'];
type Role = 'VIEWER' | 'MEMBER' | 'LEAD';

export const DEMO_USERS: { email: string; name: string; admin?: boolean; teams: Partial<Record<TeamKey, Role>> }[] = [
  { email: 'admin@opsdesk.dev', name: 'Ada Admin', admin: true, teams: {} },
  { email: 'priya@opsdesk.dev', name: 'Priya Sharma', teams: { PAY: 'LEAD', CMP: 'MEMBER' } },
  { email: 'rahul@opsdesk.dev', name: 'Rahul Verma', teams: { PAY: 'MEMBER', OPS: 'MEMBER' } },
  { email: 'sam@opsdesk.dev', name: 'Sam Okafor', teams: { ENG: 'LEAD', SUP: 'MEMBER' } },
  { email: 'alex@opsdesk.dev', name: 'Alex Chen', teams: { ENG: 'MEMBER', PAY: 'MEMBER' } },
  { email: 'maria@opsdesk.dev', name: 'Maria Garcia', teams: { OPS: 'LEAD', CMP: 'LEAD' } },
  { email: 'dev@opsdesk.dev', name: 'Dev Patel', teams: { OPS: 'MEMBER', ENG: 'MEMBER', SUP: 'LEAD' } },
  { email: 'vera@opsdesk.dev', name: 'Vera Auditor', teams: { PAY: 'VIEWER', ENG: 'VIEWER', CMP: 'VIEWER' } },
];

const FIRST = ['Aisha', 'Ben', 'Chloe', 'Diego', 'Elena', 'Farhan', 'Grace', 'Hiro', 'Ines', 'Jamal', 'Kavya', 'Liam', 'Mei', 'Noah', 'Olu', 'Pooja', 'Quinn', 'Ravi', 'Sara', 'Tomas'];
const LAST = ['Khan', 'Nair', 'Smith', 'Lopez', 'Ivanova', 'Rao', 'Kim', 'Tanaka', 'Silva', 'Brown'];

const TITLES: Record<string, string[]> = {
  PAYMENT: ['Refund failed for order #{n}', 'Chargeback dispute from merchant {m}', 'Duplicate charge reported by customer #{n}', 'Payout delayed to merchant {m}', 'Settlement mismatch on {d} batch', 'Manual refund of ₹{amt} requested'],
  INCIDENT: ['Checkout latency spike in {region}', '{svc} returning 5xx errors', 'Queue backlog growing on {svc}', 'Login failures for {pct}% of users', 'Webhook deliveries failing to {m}', 'Database CPU at 95% on {svc}'],
  CUSTOMER_ISSUE: ['Customer #{n} cannot reset password', 'Invoice PDF missing line items for #{n}', 'Enterprise client {m} reports missing data', 'Customer #{n} charged in wrong currency', 'Account locked after KYC update #{n}'],
  ENGINEERING: ['Upgrade {svc} to latest runtime', 'Flaky test in {svc} pipeline', 'Add rate limiting to {svc}', 'Investigate memory leak in {svc}', 'Rotate credentials for {svc}', 'Remove deprecated {svc} endpoint'],
  COMPLIANCE: ['Data deletion request from customer #{n}', 'Quarterly access review for {svc}', 'Audit evidence for SOC2 control {c}', 'Sanctions screening hit on merchant {m}', 'GDPR export request #{n}'],
  TASK: ['Onboard new vendor {m}', 'Provision access for new hire in {region}', 'Update runbook for {svc}', 'Renew SSL certificate for {svc}', 'Schedule maintenance window for {svc}'],
};
const SVCS = ['payments-api', 'ledger', 'auth-service', 'checkout', 'notifications', 'search', 'billing', 'reporting'];
const MERCHANTS = ['Acme Retail', 'BlueKart', 'Zenith Travel', 'Nova Foods', 'Orbit Media', 'Kite Logistics'];
const REGIONS = ['ap-south-1', 'eu-west-1', 'us-east-1', 'Bangalore', 'Mumbai'];
const TEAM_TYPES: Record<TeamKey, string[]> = {
  PAY: ['PAYMENT', 'PAYMENT', 'CUSTOMER_ISSUE', 'INCIDENT', 'TASK'],
  ENG: ['ENGINEERING', 'ENGINEERING', 'INCIDENT', 'INCIDENT', 'TASK'],
  OPS: ['TASK', 'TASK', 'INCIDENT', 'CUSTOMER_ISSUE'],
  CMP: ['COMPLIANCE', 'COMPLIANCE', 'TASK'],
  SUP: ['CUSTOMER_ISSUE', 'CUSTOMER_ISSUE', 'CUSTOMER_ISSUE', 'TASK'],
};
const COMMENTS = [
  'Looking into this now.',
  'Reached out to the customer, waiting for a reply.',
  'Root cause identified — fix in review.',
  'Escalated to the vendor.',
  'Can someone from Engineering take a look?',
  'Confirmed resolved with the customer.',
  'Added logs from the affected window.',
];

// mulberry32: small deterministic PRNG using 32-bit integer math (no float precision loss).
let seed = 42;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)];
const fill = (t: string) =>
  t
    .replace('{n}', String(10000 + Math.floor(rand() * 89999)))
    .replace('{m}', pick(MERCHANTS))
    .replace('{svc}', pick(SVCS))
    .replace('{region}', pick(REGIONS))
    .replace('{pct}', String(1 + Math.floor(rand() * 20)))
    .replace('{amt}', String(1000 * (1 + Math.floor(rand() * 90))))
    .replace('{c}', `CC${1 + Math.floor(rand() * 9)}.${1 + Math.floor(rand() * 5)}`)
    .replace('{d}', `${1 + Math.floor(rand() * 28)} Sep`);

export async function seedDatabase(db: Db, opts: { items?: number; quiet?: boolean } = {}) {
  const itemCount = opts.items ?? 6000;
  const log = (...a: unknown[]) => !opts.quiet && console.log('[seed]', ...a);
  seed = 42;

  await db.query(`TRUNCATE users, teams, work_items, activity_events, approvals, watchers, notifications,
                  idempotency_keys, jobs, sessions, team_members RESTART IDENTITY CASCADE`);

  const teamIds = {} as Record<TeamKey, string>;
  for (const t of TEAMS) {
    teamIds[t.key] = (await db.query('INSERT INTO teams(name, key) VALUES ($1, $2) RETURNING id', [t.name, t.key])).rows[0].id;
  }

  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const users = [...DEMO_USERS];
  for (let i = 0; i < 40; i++) {
    const name = `${FIRST[i % FIRST.length]} ${LAST[(i * 7) % LAST.length]}`;
    const teamsFor: Partial<Record<TeamKey, Role>> = {};
    teamsFor[TEAMS[i % TEAMS.length].key] = 'MEMBER';
    if (i % 3 === 0) teamsFor[TEAMS[(i + 2) % TEAMS.length].key] = i % 9 === 0 ? 'VIEWER' : 'MEMBER';
    users.push({ email: `user${String(i + 1).padStart(2, '0')}@opsdesk.dev`, name, teams: teamsFor });
  }

  const userIds: Record<string, string> = {};
  const membersByTeam: Record<TeamKey, { id: string; role: Role }[]> = { PAY: [], ENG: [], OPS: [], CMP: [], SUP: [] };
  for (const u of users) {
    const id = (
      await db.query('INSERT INTO users(email, name, password_hash, is_admin) VALUES ($1,$2,$3,$4) RETURNING id', [
        u.email,
        u.name,
        hash,
        !!u.admin,
      ])
    ).rows[0].id;
    userIds[u.email] = id;
    for (const [tk, role] of Object.entries(u.teams) as [TeamKey, Role][]) {
      await db.query('INSERT INTO team_members(team_id, user_id, role) VALUES ($1,$2,$3)', [teamIds[tk], id, role]);
      membersByTeam[tk].push({ id, role });
    }
  }
  log(`${users.length} users, ${TEAMS.length} teams`);

  const counters: Record<TeamKey, number> = { PAY: 0, ENG: 0, OPS: 0, CMP: 0, SUP: 0 };
  const now = Date.now();
  const H = 3600_000;
  const cols = {
    team: [] as string[], number: [] as number[], key: [] as string[], type: [] as string[], title: [] as string[],
    description: [] as string[], status: [] as string[], priority: [] as string[], owner: [] as (string | null)[],
    createdBy: [] as string[], requiresApproval: [] as boolean[], approvedAt: [] as (Date | null)[],
    approvedBy: [] as (string | null)[], resolution: [] as (string | null)[], dueAt: [] as (Date | null)[],
    sla: [] as (Date | null)[], createdAt: [] as Date[], updatedAt: [] as Date[], resolvedAt: [] as (Date | null)[],
  };

  const add = (it: {
    team: TeamKey; type: string; title: string; description?: string; status: string; priority: string;
    owner?: string | null; createdBy: string; requiresApproval?: boolean; approvedBy?: string | null;
    dueAt?: Date | null; sla?: boolean; createdAt: Date; updatedAt?: Date;
  }) => {
    const n = ++counters[it.team];
    const resolved = ['RESOLVED', 'CLOSED'].includes(it.status);
    const updatedAt = it.updatedAt ?? it.createdAt;
    cols.team.push(teamIds[it.team]);
    cols.number.push(n);
    cols.key.push(`${it.team}-${n}`);
    cols.type.push(it.type);
    cols.title.push(it.title);
    cols.description.push(it.description ?? `Reported via ${pick(['chat', 'email', 'phone', 'on-call page', 'support ticket'])}. ${pick(COMMENTS)}`);
    cols.status.push(it.status);
    cols.priority.push(it.priority);
    cols.owner.push(it.owner ?? null);
    cols.createdBy.push(it.createdBy);
    cols.requiresApproval.push(!!it.requiresApproval);
    cols.approvedAt.push(it.approvedBy ? updatedAt : null);
    cols.approvedBy.push(it.approvedBy ?? null);
    cols.resolution.push(resolved ? pick(['Fixed and verified.', 'Refund processed.', 'Customer confirmed.', 'Config corrected.']) : null);
    cols.dueAt.push(it.dueAt ?? null);
    // Only work whose deadline has already passed is breached (the worker flags it at the due time).
    cols.sla.push(it.sla && it.dueAt && it.dueAt.getTime() < now ? it.dueAt : null);
    cols.createdAt.push(it.createdAt);
    cols.updatedAt.push(updatedAt);
    cols.resolvedAt.push(resolved ? updatedAt : null);
  };

  // ── Hand-written scenarios for the demo ──
  const u = (e: string) => userIds[`${e}@opsdesk.dev`];
  add({ team: 'PAY', type: 'PAYMENT', title: 'Customer #88123 charged twice — refund stuck at bank', status: 'IN_PROGRESS', priority: 'P1', owner: u('rahul'), createdBy: u('rahul'), requiresApproval: true, dueAt: new Date(now + 3 * H), createdAt: new Date(now - 5 * H), updatedAt: new Date(now - 1 * H), description: 'Customer paid twice for order #88123 (₹12,499). Automatic refund failed with bank error R05. Needs a manual refund, which requires lead approval.' });
  add({ team: 'PAY', type: 'PAYMENT', title: 'Manual refund of ₹40,000 to Acme Retail', status: 'PENDING_APPROVAL', priority: 'P2', owner: u('rahul'), createdBy: u('rahul'), requiresApproval: true, dueAt: new Date(now + 20 * H), createdAt: new Date(now - 26 * H), updatedAt: new Date(now - 2 * H), description: 'Settlement error on 14 Sep batch. Finance confirmed the amount. Requesting approval to issue a manual refund.' });
  add({ team: 'PAY', type: 'CUSTOMER_ISSUE', title: 'Merchant BlueKart reports missing payouts since Monday', status: 'OPEN', priority: 'P2', createdBy: u('priya'), dueAt: new Date(now + 6 * H), createdAt: new Date(now - 3 * H) });
  add({ team: 'ENG', type: 'INCIDENT', title: 'Checkout returning 500 for ~3% of requests', status: 'OPEN', priority: 'P1', createdBy: u('sam'), dueAt: new Date(now + 0.5 * H), createdAt: new Date(now - 0.3 * H), description: 'Error rate on /checkout jumped from 0.1% to 3% at 14:05. Correlates with the payments-api deploy. Needs an owner NOW.' });
  add({ team: 'ENG', type: 'ENGINEERING', title: 'Ledger reconciliation job exceeds its 2h window', status: 'BLOCKED', priority: 'P2', owner: u('alex'), createdBy: u('sam'), createdAt: new Date(now - 50 * H), updatedAt: new Date(now - 4 * H), dueAt: new Date(now - 2 * H) });
  add({ team: 'OPS', type: 'TASK', title: 'Provision laptop and access for 6 new hires (Mumbai)', status: 'IN_PROGRESS', priority: 'P3', owner: u('dev'), createdBy: u('maria'), createdAt: new Date(now - 30 * H), updatedAt: new Date(now - 6 * H), dueAt: new Date(now + 48 * H) });
  add({ team: 'CMP', type: 'COMPLIANCE', title: 'GDPR data deletion request from customer #55102', status: 'OPEN', priority: 'P2', createdBy: u('maria'), requiresApproval: true, dueAt: new Date(now + 72 * H), createdAt: new Date(now - 10 * H) });
  const handWritten = cols.key.length;

  // ── Bulk realistic history ──
  const statusWheel = ['OPEN', 'OPEN', 'IN_PROGRESS', 'IN_PROGRESS', 'BLOCKED', 'RESOLVED', 'RESOLVED', 'CLOSED', 'CLOSED', 'CLOSED', 'CLOSED', 'CANCELLED'];
  for (let i = 0; i < itemCount - handWritten; i++) {
    const team = pick(TEAMS).key;
    const members = membersByTeam[team].filter((m) => m.role !== 'VIEWER');
    const leads = members.filter((m) => m.role === 'LEAD');
    const type = pick(TEAM_TYPES[team]);
    const requiresApproval = type === 'PAYMENT' || type === 'COMPLIANCE';
    let status = pick(statusWheel);
    if (status === 'BLOCKED' && rand() < 0.5) status = 'IN_PROGRESS';
    if (requiresApproval && status === 'IN_PROGRESS' && rand() < 0.25) status = 'PENDING_APPROVAL';
    const createdAt = new Date(now - rand() * 120 * 24 * H);
    const updatedAt = new Date(createdAt.getTime() + rand() * (now - createdAt.getTime()));
    const owner = status === 'OPEN' ? (rand() < 0.3 ? pick(members).id : null) : status === 'CANCELLED' ? null : pick(members).id;
    const active = ['OPEN', 'IN_PROGRESS', 'BLOCKED', 'PENDING_APPROVAL'].includes(status);
    let dueAt: Date | null = null;
    if (active && rand() < 0.4) dueAt = new Date(now + (rand() < 0.08 ? -1 : 1) * rand() * 7 * 24 * H);
    const approver = leads.find((l) => l.id !== owner)?.id ?? null;
    add({
      team, type, title: fill(pick(TITLES[type])), status,
      priority: pick(['P1', 'P2', 'P2', 'P3', 'P3', 'P3', 'P4', 'P4']),
      owner, createdBy: pick(members).id, requiresApproval,
      approvedBy: requiresApproval && ['RESOLVED', 'CLOSED'].includes(status) ? approver : null,
      dueAt, sla: true, createdAt, updatedAt,
    });
  }

  // Bulk insert with unnest() — one round trip per 1,000 rows.
  const B = 1000;
  for (let s = 0; s < cols.key.length; s += B) {
    const sl = <T>(a: T[]) => a.slice(s, s + B);
    await db.query(
      `INSERT INTO work_items(team_id, number, key, type, title, description, status, priority, owner_id, created_by,
         requires_approval, approved_at, approved_by, resolution, due_at, sla_breached_at, created_at, updated_at, resolved_at)
       SELECT * FROM unnest($1::uuid[], $2::int[], $3::text[], $4::item_type[], $5::text[], $6::text[], $7::item_status[],
         $8::item_priority[], $9::uuid[], $10::uuid[], $11::bool[], $12::timestamptz[], $13::uuid[], $14::text[],
         $15::timestamptz[], $16::timestamptz[], $17::timestamptz[], $18::timestamptz[], $19::timestamptz[])`,
      [sl(cols.team), sl(cols.number), sl(cols.key), sl(cols.type), sl(cols.title), sl(cols.description), sl(cols.status),
       sl(cols.priority), sl(cols.owner), sl(cols.createdBy), sl(cols.requiresApproval), sl(cols.approvedAt), sl(cols.approvedBy),
       sl(cols.resolution), sl(cols.dueAt), sl(cols.sla), sl(cols.createdAt), sl(cols.updatedAt), sl(cols.resolvedAt)],
    );
  }
  for (const t of TEAMS) await db.query('UPDATE teams SET next_number = $2 WHERE id = $1', [teamIds[t.key], counters[t.key] + 1]);
  log(`${cols.key.length} work items`);

  // ── History consistent with each item's current state ──
  await db.query(`INSERT INTO activity_events(work_item_id, actor_id, type, payload, created_at)
    SELECT id, created_by, 'CREATED', jsonb_build_object('title', title, 'priority', priority, 'type', type,
           'requiresApproval', requires_approval), created_at FROM work_items`);
  await db.query(`INSERT INTO activity_events(work_item_id, actor_id, type, payload, created_at)
    SELECT i.id, i.owner_id, 'ASSIGNED', jsonb_build_object('from', NULL, 'to', jsonb_build_object('id', u.id, 'name', u.name), 'claimed', true),
           i.created_at + (i.updated_at - i.created_at) * 0.2
    FROM work_items i JOIN users u ON u.id = i.owner_id`);
  await db.query(`INSERT INTO activity_events(work_item_id, actor_id, type, payload, created_at)
    SELECT id, owner_id, 'STATUS_CHANGED', jsonb_build_object('from', 'OPEN', 'to', 'IN_PROGRESS'),
           created_at + (updated_at - created_at) * 0.25
    FROM work_items WHERE owner_id IS NOT NULL AND status <> 'OPEN'`);
  await db.query(`INSERT INTO activity_events(work_item_id, actor_id, type, payload, created_at)
    SELECT id, owner_id, 'COMMENTED', jsonb_build_object('body', (ARRAY[${COMMENTS.map((c) => `'${c.replace(/'/g, "''")}'`).join(',')}])[1 + (abs(hashtext(id::text)) % ${COMMENTS.length})]),
           created_at + (updated_at - created_at) * 0.5
    FROM work_items WHERE owner_id IS NOT NULL AND abs(hashtext(id::text)) % 3 = 0`);
  await db.query(`INSERT INTO activity_events(work_item_id, actor_id, type, payload, created_at)
    SELECT id, approved_by, 'APPROVED', jsonb_build_object('from','PENDING_APPROVAL','to','IN_PROGRESS'), approved_at - interval '1 hour'
    FROM work_items WHERE approved_by IS NOT NULL`);
  await db.query(`INSERT INTO activity_events(work_item_id, actor_id, type, payload, created_at)
    SELECT id, coalesce(owner_id, created_by),
           CASE WHEN status = 'PENDING_APPROVAL' THEN 'APPROVAL_REQUESTED' ELSE 'STATUS_CHANGED' END,
           jsonb_build_object('from', 'IN_PROGRESS', 'to', status,
             'reason', CASE WHEN status IN ('BLOCKED','CANCELLED') THEN 'Waiting on external party' END,
             'resolution', resolution),
           updated_at
    FROM work_items WHERE status NOT IN ('OPEN', 'IN_PROGRESS')`);
  await db.query(`INSERT INTO activity_events(work_item_id, actor_id, type, payload, created_at)
    SELECT id, NULL, 'SLA_BREACHED', jsonb_build_object('dueAt', due_at), sla_breached_at
    FROM work_items WHERE sla_breached_at IS NOT NULL`);
  await db.query(`INSERT INTO approvals(work_item_id, requested_by, requested_at, note)
    SELECT id, owner_id, updated_at, 'Please review.' FROM work_items WHERE status = 'PENDING_APPROVAL'`);
  await db.query(`INSERT INTO watchers(work_item_id, user_id)
    SELECT id, created_by FROM work_items
    UNION SELECT id, owner_id FROM work_items WHERE owner_id IS NOT NULL
    ON CONFLICT DO NOTHING`);
  await db.query('ANALYZE');
  const ev = (await db.query('SELECT count(*) AS n FROM activity_events')).rows[0].n;
  log(`${ev} activity events`);
  log(`done — sign in with any demo user, password "${DEMO_PASSWORD}"`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { pool, waitForDb } = await import('./pool.js');
  const { migrate } = await import('./migrate.js');
  await waitForDb();
  await migrate(pool);
  const itemsArg = process.argv.find((a) => a.startsWith('--items='));
  await seedDatabase(pool, { items: itemsArg ? Number(itemsArg.split('=')[1]) : undefined });
  await pool.end();
}
