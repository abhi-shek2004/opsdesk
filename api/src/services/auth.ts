import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { pool } from '../db/pool.js';
import type { Actor, Role } from '../domain/types.js';
import { AppError } from '../lib/errors.js';
import { publish } from '../lib/outbox.js';

export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

// Used to equalize timing when the email does not exist (avoid user enumeration).
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

// ── Identity cache ──
// Every API request needs the caller's identity and team roles. Caching them briefly removes
// a DB round trip per request. Correctness comes from invalidation, not the TTL: role changes
// and logouts are broadcast with Postgres NOTIFY and every API instance drops the entry
// (lib/live.ts). The TTL only bounds staleness if a notification were ever missed.
const actorCache = new Map<string, { actor: Actor; expires: number }>();
const MAX_CACHE = 20_000;

export function invalidateUser(userId: string) {
  for (const [k, v] of actorCache) if (v.actor.id === userId) actorCache.delete(k);
}

export function invalidateSession(tokenHash: string) {
  actorCache.delete(tokenHash);
}

// ── Brute-force protection ──
// Failed attempts per email and per IP inside a sliding window. Kept in memory, so the limit
// is per API instance; with several instances behind a load balancer it would move to Redis
// or a database table.
const failures = new Map<string, number[]>();

function recent(key: string, now: number): number[] {
  const list = (failures.get(key) ?? []).filter((t) => now - t < config.login.windowMs);
  if (list.length) failures.set(key, list);
  else failures.delete(key);
  return list;
}

const keysFor = (email: string, ip: string) => [`e:${email.trim().toLowerCase()}`, `ip:${ip}`];
// One shared office IP can have many users, so the IP limit is looser than the per-account one.
const limitFor = (key: string) => (key.startsWith('ip:') ? config.login.maxFailures * 5 : config.login.maxFailures);

function assertNotThrottled(email: string, ip: string) {
  const now = Date.now();
  for (const key of keysFor(email, ip)) {
    const list = recent(key, now);
    if (list.length >= limitFor(key)) {
      const minutes = Math.ceil((config.login.windowMs - (now - list[0])) / 60_000);
      throw new AppError(429, 'TOO_MANY_ATTEMPTS', `Too many failed sign-in attempts. Try again in ${minutes} minute(s).`);
    }
  }
}

function recordFailure(email: string, ip: string) {
  const now = Date.now();
  for (const key of keysFor(email, ip)) failures.set(key, [...recent(key, now), now]);
}

export function resetLoginThrottle() {
  failures.clear();
}

export async function login(email: string, password: string, ip = 'unknown'): Promise<{ token: string; expiresAt: Date }> {
  assertNotThrottled(email, ip);
  const { rows } = await pool.query('SELECT id, password_hash FROM users WHERE lower(email) = lower($1)', [email.trim()]);
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
  if (!user || !ok) {
    recordFailure(email, ip);
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
  }
  failures.delete(keysFor(email, ip)[0]); // success clears the account's counter

  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000);
  await pool.query('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
    hashToken(token),
    user.id,
    expiresAt,
  ]);
  return { token, expiresAt };
}

export async function logout(token: string): Promise<void> {
  const tokenHash = hashToken(token);
  await pool.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
  invalidateSession(tokenHash);
  await publish(pool, { kind: 'session', tokenHash }); // other API instances drop it too
}

/** Resolve a session token into an Actor with team memberships (cached briefly; see above). */
export async function actorFromToken(token: string): Promise<Actor | null> {
  const tokenHash = hashToken(token);
  const cached = actorCache.get(tokenHash);
  if (cached && cached.expires > Date.now()) return cached.actor;

  const { rows } = await pool.query(
    `SELECT u.id, u.name, u.email, u.is_admin, s.expires_at,
            coalesce(json_agg(json_build_object('teamId', m.team_id, 'role', m.role))
                     FILTER (WHERE m.team_id IS NOT NULL), '[]') AS memberships
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     LEFT JOIN team_members m ON m.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > now()
     GROUP BY u.id, s.expires_at`,
    [tokenHash],
  );
  const r = rows[0];
  if (!r) {
    actorCache.delete(tokenHash);
    return null;
  }
  const actor: Actor = {
    id: r.id,
    name: r.name,
    email: r.email,
    isAdmin: r.is_admin,
    memberships: new Map((r.memberships as { teamId: string; role: Role }[]).map((m) => [m.teamId, m.role])),
  };
  if (config.actorCacheMs > 0) {
    if (actorCache.size >= MAX_CACHE) actorCache.clear(); // crude bound, adequate at this scale
    const expires = Math.min(Date.now() + config.actorCacheMs, new Date(r.expires_at).getTime());
    actorCache.set(tokenHash, { actor, expires });
  }
  return actor;
}

/** Fresh team roles for one user (used to re-scope long-lived SSE connections). */
export async function loadMemberships(userId: string): Promise<Map<string, Role>> {
  const { rows } = await pool.query('SELECT team_id, role FROM team_members WHERE user_id = $1', [userId]);
  return new Map(rows.map((m) => [m.team_id as string, m.role as Role]));
}

export async function describeMe(actor: Actor) {
  const { rows } = await pool.query(
    `SELECT t.id, t.name, t.key, m.role FROM teams t
     LEFT JOIN team_members m ON m.team_id = t.id AND m.user_id = $1
     WHERE m.user_id IS NOT NULL OR $2
     ORDER BY t.name`,
    [actor.id, actor.isAdmin],
  );
  return {
    id: actor.id,
    name: actor.name,
    email: actor.email,
    isAdmin: actor.isAdmin,
    teams: rows.map((r) => ({ id: r.id, name: r.name, key: r.key, role: (r.role ?? null) as Role | null })),
  };
}
