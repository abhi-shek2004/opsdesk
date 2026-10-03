export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://postgres:postgres@localhost:54329/opsdesk',
  dbPoolSize: Number(process.env.DB_POOL_SIZE ?? 20),
  port: Number(process.env.PORT ?? 4000),
  host: process.env.HOST ?? '127.0.0.1',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS ?? 24 * 7),
  /** How long a resolved session+memberships stays cached in memory (invalidated early via NOTIFY). */
  actorCacheMs: Number(process.env.ACTOR_CACHE_MS ?? 30_000),
  login: { maxFailures: Number(process.env.LOGIN_MAX_FAILURES ?? 8), windowMs: 15 * 60_000 },
  cookieSecure: process.env.NODE_ENV === 'production' || process.env.COOKIE_SECURE === '1',
  logLevel: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  job: {
    maxAttempts: Number(process.env.JOB_MAX_ATTEMPTS ?? 5),
    pollMs: Number(process.env.JOB_POLL_MS ?? 1000),
    slaScanMs: Number(process.env.SLA_SCAN_MS ?? 30_000),
  },
};

export const SESSION_COOKIE = 'opsdesk_session';
