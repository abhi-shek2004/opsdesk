# Engineering Decisions

Five decisions that shaped OpsDesk, the alternatives I rejected, and what each one costs.

---

## 1. PostgreSQL for everything: data, job queue, live-update fan-out and search

**Decision.** One PostgreSQL database holds the domain data. It also does three other jobs:
- **Job queue:** a `jobs` table consumed with `FOR UPDATE SKIP LOCKED`.
- **Live-update bus:** `LISTEN/NOTIFY`.
- **Search engine:** a generated `tsvector` column with a GIN index.

There's no Redis, Kafka or Elasticsearch.

**Why.**
- Every correctness guarantee in this app comes from transactions: row locks, unique indexes, and an all-or-nothing write of *data + history + job*.
- When the queue and the data live in the same database, "save the change and enqueue the notification" is a single commit. That rules out "saved but never notified" and "notified about something that rolled back" by construction.
- `NOTIFY` is only delivered **on commit**, so browsers never hear about changes that didn't happen.
- At the stated scale (thousands of users, tens of thousands of active items), a single Postgres handles this comfortably.

**Trade-offs.**
- Postgres is now a shared bottleneck for OLTP, queue and fan-out.
- NOTIFY payloads are limited to 8 KB. We only send ids, so this doesn't bite.
- Full-text search is decent, not great: there's no typo tolerance and no relevance tuning.

**If we grew 10×.**
- Move fan-out to Redis pub/sub or a managed broker.
- Move the queue to a dedicated system.
- Put search behind OpenSearch, fed from the outbox.
- The outbox table stays: it's still the reliable hand-off point.

---

## 2. Concurrency: row lock *inside* the request, version check *across* requests

Every write to an existing item goes through one function, `mutateItem` in `api/src/services/items.ts`. It runs these steps in one transaction:

1. `SELECT … FOR UPDATE` the row, so concurrent writers to the same item queue up instead of racing.
2. Compare the client's `version` with the row's current version. On a mismatch, return **409 `VERSION_CONFLICT`** with the current item and who changed it last.
3. Apply policy and workflow rules against the **locked, fresh** state, never against what the client believed.
4. Update the row and bump `version`, append history events, enqueue jobs, and `NOTIFY`.

The two halves cover different situations:

| Situation | Mechanism | Result |
|---|---|---|
| Two people click **Claim** at the same moment | row lock + "already has an owner?" check | exactly one owner; the other gets 409 `ALREADY_CLAIMED`, naming the winner |
| Editing a page that someone else changed 2 minutes ago | version check | 409 + conflict dialog: *keep theirs* or *apply mine anyway* (a deliberate re-apply on the new version) |
| Two leads approve and reject simultaneously | row lock + "still pending?" check | one decision recorded; the other gets 409 `NOT_PENDING_APPROVAL` |
| Burst of updates to one item | row lock | updates serialized, none lost |

**Why not last-write-wins?** It silently loses work. That's exactly the "someone edits an older version" problem in the brief.

**Why not pessimistic "edit locks" (checking an item out)?** People abandon tabs. Locks then need expiry, and expiry reintroduces races. Optimistic versioning costs nothing until an actual conflict.

**Deliberate choices.**
- **Claim doesn't require a version.** Claiming is a conditional action ("take it if nobody owns it"), not an edit, and it's idempotent for the owner, so retrying a timed-out claim is safe.
- **Comments don't bump the version.** Commenting shouldn't make everyone else's open edit forms stale.
- **The DB is the last line of defence.** A `CHECK` constraint enforces that active work has an owner, so a future code path can't violate the invariant.

---

## 3. Idempotency keys stored in the same transaction as the operation

Create-item and add-comment accept an `Idempotency-Key` header. The client generates one key per *intent*: one per opening of the "New item" form, and one per comment draft. It reuses that key on retries and double clicks.

The server inserts `(user_id, key, request_hash)` **inside the same transaction** as the operation and stores the response before commit. Each case then resolves on its own:

- **Retry after success:** the unique key conflicts, so the server replays the stored response (`Idempotent-Replayed: true`).
- **Two identical requests in flight:** the second `INSERT` blocks on the first transaction's uncommitted row. When the first commits, the second replays. If the first rolls back, the second runs normally.
- **Same key, different body:** the server returns 422. That's a client bug, not a retry.
- **Scope:** keys are per user. They expire after 24h (the worker cleans them up).

**Trade-off.** Only creation-style operations need keys. Field edits are already protected by the version check: a retried PATCH with the old version returns 409 instead of applying twice. Claims, transitions and approvals are naturally idempotent or guarded by state checks.

---

## 4. Authorization: per-team roles, one pure policy module, enforced server-side

- **Roles are per team** (`VIEWER < MEMBER < LEAD`), plus a global `is_admin` flag. Someone can lead Payments and only view Engineering.
- **All rules live in `api/src/domain/policy.ts`** as pure functions, so they're trivially testable. Every service call checks them against the *current* row.
- **Resource-level checks.** Items in teams you don't belong to return **404, not 403**, so their existence doesn't leak. List, search, dashboard and notifications queries are always scoped by team membership in SQL.
- **Separation of duties.** Nobody can approve work they own, created or requested, **including admins**.
- **The server tells the UI what's allowed.** Each item DTO includes `permissions`: which buttons to show and which transitions are allowed. The UI never re-implements policy, so the two can't drift.
- **CSRF protection.** Session cookies are `httpOnly` with `SameSite=Lax`, and every mutating request must carry `X-Requested-With: opsdesk`. A custom header can't be sent cross-site without a CORS preflight, which the server never grants.
- **Login safety.** Login uses a constant-time-ish path: bcrypt runs against a dummy hash for unknown emails, so attackers can't enumerate users by response timing.

- **Fast without going stale.** Identity and roles are cached for up to 30 seconds per session to save a DB round trip on every request. Correctness doesn't depend on the TTL: removing someone from a team or logging out clears the cache immediately on every API instance (Postgres NOTIFY). It also re-scopes that user's open live-update connection. A test proves a removed member is refused on their very next request.
- **Brute-force protection.** After 8 failed sign-ins for an account (40 per IP) within 15 minutes, logins return 429. Even the correct password is refused until the window passes. The counter is in memory, so the limit is per instance; behind a load balancer it would move to Redis.

**Trade-off.** Per-team roles are coarse. "Can approve payments above ₹1L" would need attribute-based rules. I'd add those to `policy.ts` without touching call sites.

---

## 5. Synchronous core, asynchronous side effects (transactional outbox)

**Synchronous (inside the request transaction):** the change, its history events, the approval row, and enqueuing jobs. The user's action either fully happened or didn't happen at all.

**Asynchronous (worker process):** notification fan-out (to watchers, the owner, the new assignee, team leads for approval requests), the SLA/overdue scan, and cleanup.

How the worker handles each failure the brief asks about:

| Problem | Handling |
|---|---|
| **Fails** | Retry with exponential backoff (2s, 4s, 8s…). After 5 attempts the job is marked `DEAD` and shown in the admin panel with a Retry button. A savepoint per job rolls back only that job's partial writes, so one bad job never blocks the batch. |
| **Runs twice** (crash after doing the work, before acking) | Handlers are idempotent. `UNIQUE(user_id, event_id)` on notifications means a duplicate run inserts nothing. The SLA scan uses `UPDATE … WHERE sla_breached_at IS NULL`, so each item is flagged exactly once even with multiple workers. |
| **Delayed** | Nothing user-facing waits on a job. Notifications arrive late; data is never wrong. |
| **Multiple workers** | `SKIP LOCKED` means no job is processed by two workers at once (tested with 4 concurrent consumers). |

---

## Frontend state management

- **Server state lives in TanStack Query.** There's no global store, and the URL holds list filters, so views are shareable and survive a refresh.
- **One mutation wrapper, `useItemMutation`, sets the reconciliation policy:** apply optimistically, then replace with the server's item on success. On failure it rolls back and explains why. On `VERSION_CONFLICT` it adopts the server's copy and hands the user their change back.
- **Edit forms remember the version they started from.** Typing while a live update arrives shows a "this changed while you were editing" hint instead of silently rebasing.
- **Live updates use Server-Sent Events, and messages carry only ids.**
  - The client refetches through the authorized API, so a stale membership on an open connection leaks nothing but an id.
  - List and dashboard refreshes are throttled to one every 3 seconds, so a burst of edits doesn't cause a refetch storm.
  - After a reconnect, the client refetches everything, because events may have been missed.

## What I deliberately did not build

- SSO or password reset.
- Email/Slack delivery: notifications are in-app only. The worker has the hook for it.
- Attachments, @mentions, per-team custom workflows, comment editing or deleting, and moving items between teams.
- Analytics charts and audit-log export.
- Horizontal-scale infrastructure. The design allows N API instances and N workers, but I haven't load-tested it.
