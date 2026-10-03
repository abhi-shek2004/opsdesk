# Engineering Decisions

This document explains how OpsDesk is designed and why: the system's shape, the five decisions that matter most and their trade-offs, how it behaves when things fail, and how it would evolve. Setup and usage are in the [README](README.md).

**Contents**
1. [Goals and constraints](#1-goals-and-constraints)
2. [System overview](#2-system-overview)
3. [Key decisions](#3-key-decisions)
4. [Domain rules](#4-domain-rules)
5. [Frontend state](#5-frontend-state)
6. [Failure handling](#6-failure-handling)
7. [Performance and scale](#7-performance-and-scale)
8. [Testing strategy](#8-testing-strategy)
9. [Scope and next steps](#9-scope-and-next-steps)

---

## 1. Goals and constraints

Operational work previously lived in chat, spreadsheets and email. Requests got lost, two people worked on the same issue, edits were made against stale information, and nobody could see who owned what or why a decision was made.

**Goals, in priority order**
1. **Correctness under concurrency.** Exactly one owner per item; no lost updates; no duplicates from retries; workflow and approval rules that can't be bypassed.
2. **Traceability.** Every meaningful change is recorded, attributed and impossible to lose silently.
3. **Visibility.** Each person can see quickly what needs their attention, and find any item without browsing everything.
4. **Operability at the stated scale.** Thousands of users, hundreds to a few thousand concurrently, tens of thousands of active items, and an ever-growing history, without loading full datasets into the browser or server memory.

**Constraints:** a one-day build, a small team, and a reviewer who must be able to run it with minimal setup. These favour fewer moving parts over specialised infrastructure.

---

## 2. System overview

```
Browser (React · TanStack Query)
   │  REST/JSON, httpOnly session cookie          ▲  Server-Sent Events (id-only hints)
   ▼                                              │
API (Fastify)
   onRequest: CSRF header check → session → actor (user + team roles)
   route:     zod validation
   service:   policy + workflow rules, executed inside one transaction
   │
   ▼
PostgreSQL ── work_items · activity_events (append-only) · approvals · watchers
   ▲           notifications · idempotency_keys · jobs (outbox) · tsvector search
   │           LISTEN/NOTIFY fan-out to every API instance
Worker ── claims jobs with FOR UPDATE SKIP LOCKED → notifications, SLA scan, cleanup
```

| Component | Responsibility | Location |
|---|---|---|
| Web app | Rendering, server-state cache, optimistic updates and reconciliation | `web/src` |
| API | Authentication, validation, authorization, business operations | `api/src/app.ts`, `routes/`, `services/` |
| Domain modules | Pure authorization policy and workflow state machine | `api/src/domain/` |
| PostgreSQL | System of record, job queue, live-update bus, search index | `api/src/db/migrations/` |
| Worker | Asynchronous side effects with retries | `api/src/jobs/` |

### The write path

Every change to an existing item goes through one function, `mutateItem` (`api/src/services/items.ts`). Each operation (edit, claim, assign, transition, approval) supplies only a `decide` callback. Within a single transaction, `mutateItem`:

1. locks the row with `SELECT … FOR UPDATE`;
2. returns `404` if the item is outside the actor's teams (existence is not disclosed);
3. returns `409 VERSION_CONFLICT`, with the current item and its last change, if the client's version is stale;
4. runs `decide` against the **locked, current** state, which applies policy and workflow rules (`403` / `422`);
5. writes the update with `version = version + 1`;
6. appends history events, enqueues one notification job per event, and adds watchers;
7. publishes a live-update hint with `pg_notify`, which Postgres delivers only on commit.

Because locking, version checks, history, notifications and live updates live in one place, a new operation can't forget any of them.

---

## 3. Key decisions

### Decision 1: PostgreSQL as the system of record, job queue, live-update bus and search engine

**Context.** The product needs reliable notifications, live updates and search alongside transactional data.

**Decision.** Use PostgreSQL for all four:
- a `jobs` table consumed with `FOR UPDATE SKIP LOCKED`;
- `LISTEN/NOTIFY` for fan-out;
- a generated `tsvector` column with a GIN index for search.

There is no Redis, Kafka or Elasticsearch.

**Why.**
- "Save the change" and "queue its notification" commit in **one transaction**, so the system can never be "saved but not notified", nor notify about a change that rolled back.
- `NOTIFY` is delivered only on commit.
- At the stated scale a single PostgreSQL handles this comfortably, and the system stays runnable with `npm install && npm run dev`.

**Trade-offs.**
- PostgreSQL becomes a shared bottleneck for transactions, queue and fan-out.
- NOTIFY throughput is bounded (payloads carry IDs only).
- Search has no typo tolerance or relevance tuning.

**Revisit when** fan-out volume or search quality requirements outgrow it. Move fan-out to Redis pub/sub, the queue to a managed broker fed from the same outbox table, and search to OpenSearch.

### Decision 2: Pessimistic row lock within a request; optimistic version check across requests

**Context.**
- Two people may claim or edit the same item at the same instant.
- A person may also edit based on a screen that is minutes out of date.

**Decision.** Do both:
- lock the row for the duration of the write transaction;
- require the client's `version` on edits, rejecting mismatches with `409`.

| Situation | Mechanism | Outcome |
|---|---|---|
| Simultaneous claims | Row lock + "already owned?" check | One owner; others receive `409 ALREADY_CLAIMED` naming the owner |
| Edit based on an outdated view | Version check | `409` plus a conflict dialog: keep theirs, or deliberately re-apply mine |
| Simultaneous approve and reject | Row lock + "still pending?" check | One decision; the other receives `409 NOT_PENDING_APPROVAL` |
| Bursts of updates to one item | Row lock | Serialised; no update lost |

**Why not last-write-wins?** It silently discards work, which is exactly the original problem.

**Why not edit locks (check-out)?** Abandoned tabs hold locks, and lock expiry reintroduces races. Optimistic versioning costs nothing until a real conflict occurs.

**Refinements.**
- **Claim is a conditional action**, not an edit of what the user saw, so it needs no version, and re-claiming one's own item is a no-op (safe to retry).
- **Comments and system SLA flags don't increment the version**, so they don't invalidate other users' open edits.
- **A database `CHECK` constraint** guarantees active work always has an owner, as a backstop to application logic.

**Trade-off.** Users occasionally see a conflict dialog.

### Decision 3: Idempotency keys committed with the operation

**Context.** Double clicks, flaky networks and client retries must not create duplicate items or comments.

**Decision.** Create and comment requests accept an `Idempotency-Key`. The client generates one key per intent: one per opening of the create form, one per comment draft. The server inserts `(user, key, request hash)` **inside the same transaction** as the operation and stores the response before commit.

**Behaviour.**
- **Retry after success:** the unique constraint conflicts, and the stored response is replayed (`Idempotent-Replayed: true`).
- **Concurrent duplicates:** the second insert blocks on the first's uncommitted row. It replays if the first commits, and proceeds if the first rolls back. Either way exactly one item is created.
- **Same key, different payload:** `422 IDEMPOTENCY_KEY_REUSED`.
- **Scope:** keys are per user and expire after 24 hours.

**Why only creates and comments?** Edits already carry a version, so a replayed edit is rejected with `409` rather than applied twice. Claims, transitions and approvals are guarded by state checks.

### Decision 4: Per-team roles in a pure policy module, enforced server-side

**Context.** People belong to several teams with different responsibilities, and authorization must not depend on the UI.

**Decision.**
- **Roles are per team** (`VIEWER < MEMBER < LEAD`), plus a global administrator flag.
- **All rules live in `api/src/domain/policy.ts`** as pure functions, and services evaluate them against the locked row on every request.
- **List, search, dashboard and notification queries are scoped** to the actor's teams in SQL.
- **Items in other teams return `404`.**
- **The server attaches a `permissions` object to every item**, so the UI shows only valid actions and never duplicates the rules.

**Separation of duties.** Nobody, including administrators, can approve work they own, created or requested.

**Supporting measures.**
- bcrypt password hashes;
- session tokens stored as SHA-256 hashes in `httpOnly`, `SameSite=Lax` cookies (`Secure` in production);
- a required custom header on state-changing requests (CSRF);
- per-account and per-IP login throttling;
- an identity cache with a 30-second TTL that is **invalidated immediately** on logout or role change, on every instance, via `NOTIFY`.

**Trade-off.** Roles are coarse. Attribute-based rules (for example, two approvers above an amount) would be added to `policy.ts` without changing call sites.

### Decision 5: Synchronous core, asynchronous side effects via a transactional outbox

**Decision.**
- **Synchronous** (inside the request transaction): the change, its history events, approval records, and the enqueued job.
- **Asynchronous** (worker): notification fan-out, SLA breach detection and cleanup.

| Concern | Handling |
|---|---|
| A job fails | Exponential backoff (2 s, 4 s, 8 s…, capped at 5 min). After 5 attempts it is marked `DEAD`, visible to administrators and retryable. Each job runs in a savepoint, so a failure rolls back only its own writes. |
| A job runs twice | Handlers are idempotent: `UNIQUE(user_id, event_id)` on notifications, and a conditional `UPDATE … WHERE sla_breached_at IS NULL` for SLA flags. A job's effects and its completion commit together. |
| A job is delayed | Nothing user-facing waits on the worker; notifications arrive late, data is never wrong. |
| Multiple workers | `SKIP LOCKED` guarantees a job is processed by one worker at a time. |

**Trade-off.** Notifications may lag by seconds. Delivery is at-least-once, with exactly-once effects.

---

## 4. Domain rules

### Workflow

```
OPEN ─claim/start─► IN_PROGRESS ⇄ BLOCKED                         (block requires a reason)
                       │   ▲
       request approval│   │ approve · reject (reason) · withdraw
                       ▼   │
                PENDING_APPROVAL
IN_PROGRESS ─resolve (resolution note; approval first when required)─► RESOLVED ─► CLOSED
RESOLVED ─reopen (reason; revokes prior approval)─► IN_PROGRESS
any non-terminal state ─cancel (leads only; reason)─► CANCELLED
```

The state machine is pure (`api/src/domain/workflow.ts`). Invalid moves return `422` with a specific code: `INVALID_TRANSITION`, `OWNER_REQUIRED`, `APPROVAL_REQUIRED`, `REASON_REQUIRED`, `RESOLUTION_REQUIRED` or `ITEM_CLOSED`. Payment and compliance items require approval by default, and only leads may waive it.

### Data model

| Table | Notes |
|---|---|
| `work_items` | `version` for optimistic concurrency; owner, status, priority (ordered enum), due date, approval fields; generated `tsvector`; `CHECK` that active work has an owner |
| `activity_events` | Append-only history (comments included); written in the same transaction as the change |
| `approvals` | Unique partial index: at most one pending request per item |
| `notifications` | `UNIQUE(user_id, event_id)` makes delivery idempotent |
| `idempotency_keys` | Request hash and stored response per (user, key) |
| `jobs` | Outbox: status, attempts, next run time, last error |
| `teams`, `team_members`, `users`, `sessions`, `watchers` | Identity, membership, subscriptions |

Migrations are plain SQL, applied in order on start under an advisory lock.

---

## 5. Frontend state

- **Server state** is held in TanStack Query. **Filters** live in the URL, so views are shareable and survive refresh. Local UI state stays in components. There is no global store.
- **One mutation hook, `useItemMutation`, encodes the reconciliation policy:**
  - apply the expected result optimistically;
  - on success, replace it with the server's item;
  - on failure, roll back and explain;
  - on `VERSION_CONFLICT`, adopt the server copy and hand the user's change back through a conflict dialog.
- **Edit forms remember the version they started from**, so a live refresh during typing can't make a stale edit look current.
- **Writes are never retried automatically**; reads retry only transient failures.
- **Live updates arrive over Server-Sent Events and carry only IDs.** The client refetches through authorized endpoints, so a stale connection can't leak content.
  - List and dashboard refreshes are throttled to one every 3 seconds.
  - After a reconnect, all cached data is refetched.

---

## 6. Failure handling

| Failure | Behaviour |
|---|---|
| Database error during a write | Transaction rolls back: no change, no history, no job, no live event |
| Lost response after a successful create | Retry with the same key replays the stored response; no duplicate |
| Lost response after a successful edit | Retry carries the old version → `409` → client shows the current state |
| Worker crash mid-job | Job transaction rolls back; the job remains pending and is retried |
| Worker unavailable | Writes continue; notifications and SLA flags catch up when it returns |
| Live-update connection drops | Client shows "Reconnecting" and refetches on reconnect; versions still prevent stale writes |
| API restart or multiple instances | Sessions are stored in the database; every instance LISTENs and receives all live hints |
| Credential guessing | Lockout after 8 failures per account (40 per IP) within 15 minutes |
| Database unavailable | Requests fail with `500`; `/api/health` reports unhealthy. Production would use managed PostgreSQL with failover. |

---

## 7. Performance and scale

**Techniques**
- **Keyset pagination** on `(sort key, id)`, with cursor values transported as text to preserve timestamp precision. Cost is flat regardless of page depth.
- **Composite indexes** matched to each query pattern, plus a **partial index on active items** for dashboard counters, so their cost tracks work in flight rather than total history.
- **Capped counts:** list totals stop at 1,000 and are displayed as "1,000+".
- **GIN-indexed full-text search** with prefix matching. Item keys such as `PAY-12` resolve by exact lookup.

**Measured** with `EXPLAIN ANALYZE` on 6,000 items and 22,000 history events: list, search, dashboard and timeline queries each complete in about 2 ms or less, using indexes.

**Scaling path**
- **~10×:**
  - PgBouncer and read replicas;
  - monthly partitioning of `activity_events`;
  - Redis for fan-out, login throttling and the identity cache;
  - the worker as an independently scaled service.
- **~100×:**
  - a managed queue fed from the existing outbox;
  - OpenSearch;
  - tenant or team sharding;
  - full observability.
- **What stays:** the single write path, version checks and same-transaction history, which are the correctness core.

---

## 8. Testing strategy

Tests target the behaviours that would be most harmful if wrong. Concurrency and authorization tests issue **real concurrent requests against a real PostgreSQL** (embedded locally, or a standard server via `TEST_DATABASE_URL`), because locking and constraint guarantees can't be demonstrated with mocks.

- **Concurrency:**
  - 12 simultaneous claims → one owner and one history entry;
  - concurrent stale edits → exactly one applied;
  - 8 concurrent keyed creates → one item;
  - approve/reject race → one decision;
  - a 50-operation mixed burst → versions form an unbroken sequence (no lost or double-applied write).
- **Authorization:**
  - team isolation;
  - role permissions;
  - separation of duties;
  - CSRF;
  - lockout;
  - immediate revocation.
- **Workflow:**
  - every invalid transition;
  - approval gating;
  - history integrity;
  - the database constraint backstop.
- **Jobs:**
  - idempotent redelivery;
  - backoff and dead-lettering;
  - savepoint rollback;
  - concurrent workers.
- **Frontend:** optimistic reconciliation and next-step guidance.

The tests were validated by fault injection: removing the row lock, or the cache invalidation, makes the corresponding tests fail.

CI runs lint, format check, type-check, all 57 tests and the production build on Node.js 20 and 22, plus the API suite against a standard PostgreSQL server.

---

## 9. Scope and next steps

**Deliberately out of scope:**
- SSO and password reset;
- email and Slack delivery;
- attachments and @mentions;
- comment editing;
- moving items between teams;
- per-team custom workflows;
- reporting and audit export.

**Known limitations:**
- login throttling and the identity cache are per instance;
- duplicate detection is lexical;
- after a disconnect the client refetches rather than replaying missed events;
- throughput at thousands of concurrent users has not been load-tested.

**Next steps:**
1. Email and Slack notification channels with per-user preferences.
2. Moving items between teams, and linking duplicates.
3. Attribute-based approval rules (for example, two approvers above a threshold).
4. A load-test suite with published latency and error budgets.
5. Operational reporting: time in each status, SLA breach rate, throughput.
