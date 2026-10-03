# OpsDesk

An internal web app for coordinating operational work: customer issues, incidents, payment investigations, compliance requests and approvals. It's built so that work has a clear owner, every change is on record, and people acting at the same moment don't overwrite each other.

**Stack:** React 19 + TanStack Query + Tailwind (web) · Node + Fastify + TypeScript (API and worker) · PostgreSQL.

**Live demo:** https://opsdesk-gb7f.onrender.com. Sign in with any demo account below. It runs on a free instance, so the first request after 15 idle minutes takes about a minute to wake it.

---

## Run it

**Requirements:** Node.js 20+ and npm. Docker and a local Postgres are **not** required: an embedded PostgreSQL binary is downloaded via npm.

```bash
npm install
npm run dev
```

`npm run dev` starts four processes:
- **db:** PostgreSQL on port 54329, data kept in `./.pgdata`. On the very first run it creates the schema and seeds about 6,000 demo work items.
- **api:** http://localhost:4000
- **worker:** background jobs.
- **web:** http://localhost:5173. Open this one.

All demo accounts use the password **`password123`**. The login page also has one-click buttons for each account.

| Account | Role(s) | Good for demoing |
|---|---|---|
| `priya@opsdesk.dev` | Payments **lead**, Compliance member | approving refunds |
| `rahul@opsdesk.dev` | Payments + Operations member | owns `PAY-1`, requests approval |
| `sam@opsdesk.dev` | Engineering **lead** | can't see Payments at all |
| `alex@opsdesk.dev` | Engineering + Payments member | racing Rahul to claim |
| `vera@opsdesk.dev` | **viewer** (read and comment only) | authorization |
| `admin@opsdesk.dev` | global admin | team management, failed jobs |

Other commands:

```bash
npm test             # 48 API tests (real Postgres) + 8 frontend tests
npm run typecheck
npm run seed         # wipe and re-seed demo data (stop `npm run dev` first or run alongside)
npm run build && npm start   # production build served by the API on :4000
```

To use your own Postgres instead, see `docker-compose.yml`. Set `DATABASE_URL` and run `npm run dev:external-db`.

### Deploying (Render)

`render.yaml` describes the whole deployment: one web service, which serves the UI, the API and the background worker, plus a managed PostgreSQL database.

1. Push this repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository. Render creates the database and the service and deploys.
3. On first boot the server runs migrations and loads the demo data.

Production settings, all already set in `render.yaml`:

| Setting | What it does |
|---|---|
| `NODE_ENV=production` | login cookies are only sent over HTTPS |
| `TRUST_PROXY=1` | the real client IP is used for login throttling |
| `WORKER_IN_PROCESS=1` | the job loop runs inside the web process (the free plan has no separate workers) |
| `SEED_DEMO_DATA=1` | an empty database gets the demo data |

On a paid plan you'd run the worker as a separate service, using `npm run start:worker -w api`, and drop `WORKER_IN_PROCESS`. Running both at once is safe, because jobs are claimed with `SKIP LOCKED`.

---

## A 5-minute demo script

Open two browsers, or one normal window and one private window.

1. **Simultaneous claim.** Sign in as Rahul in one window and Alex in the other. Open the same unassigned Payments item (Dashboard → "Unassigned urgent work") and click **Claim** in both. One wins; the other gets "Rahul Verma already owns this item" and the page updates to show the real owner.
2. **Stale edit.** Sign in as Rahul and Priya, and open `PAY-1` in both. Priya clicks **Edit** on the description. Rahul changes the priority. Priya instantly sees *"Rahul Verma just updated this item"* and a warning inside the editor. When Priya saves, a conflict dialog shows *theirs* next to *yours*, and nothing is overwritten silently.
3. **Workflow and approval.** As Rahul on `PAY-1`, there's no **Resolve** button, because payments need approval. Click **Request approval**. Priya gets a notification, and the item appears in her **Approvals** queue. Rahul cannot approve it himself, and neither could an admin who owns the item.
4. **Authorization.** Sign in as Vera (viewer): she can read and comment, but has no edit, claim or create buttons. The API enforces this too, as the `curl` example below shows. Sam can't open Payments items at all (404).
5. **History.** Every item's timeline shows who changed what and when: priority P3 → P1, owner changes, reasons for blocking or cancelling, approvals, SLA breaches.
6. **Background jobs.** Sign in as Ada (admin) and open **Teams & admin** to see job stats and dead-lettered jobs, each with a Retry button.

```bash
# The server, not the UI, enforces permissions:
curl -i -X PATCH localhost:4000/api/items/<id> -H 'X-Requested-With: opsdesk' \
  -H 'Content-Type: application/json' -b 'opsdesk_session=<vera-cookie>' -d '{"version":1,"title":"x"}'
# → 403 FORBIDDEN
```

---

## Architecture

```
Browser (React + TanStack Query)
  │  REST/JSON, httpOnly session cookie       ▲ Server-Sent Events ("item X changed")
  ▼                                           │
API (Fastify) ── auth → zod validation → policy (per-team roles) → service
  │      one transaction per write: lock row → check version → apply rules
  │      → update + version++ → append history → enqueue job → NOTIFY
  ▼
PostgreSQL ── work_items · activity_events (append-only) · approvals · watchers
  ▲           notifications · idempotency_keys · jobs (outbox) · tsvector search
  │
Worker ── jobs via FOR UPDATE SKIP LOCKED: notification fan-out, SLA scan,
          retries with backoff → DEAD after 5 attempts (admin can retry)
```

**Code map**

| Path | What's there |
|---|---|
| `api/src/db/migrations/001_init.sql` | schema, constraints and indexes, with notes on each |
| `api/src/domain/policy.ts` | **who may do what** (pure functions) |
| `api/src/domain/workflow.ts` | **state machine** (pure functions) |
| `api/src/services/items.ts` | `mutateItem`, the single write path, plus listing and search with keyset pagination |
| `api/src/lib/idempotency.ts` | exactly-once create and comment |
| `api/src/jobs/worker.ts` | outbox consumer, notification fan-out, SLA scan |
| `api/src/lib/live.ts` | SSE hub fed by Postgres `LISTEN` |
| `web/src/api/hooks.ts` | queries plus `useItemMutation` (optimistic → reconcile → conflict) |
| `web/src/pages/ItemDetailPage.tsx` | the main screen: "Next:" guidance, workflow actions, approvals, conflict dialog |
| `web/src/pages/LandingPage.tsx` | public landing page (full-bleed video, dot-matrix display type) |

**Workflow**

```
OPEN ─start/claim─► IN_PROGRESS ⇄ BLOCKED (reason required)
                       │  ▲
       request approval│  │approve / reject (reason) / withdraw
                       ▼  │
                 PENDING_APPROVAL
IN_PROGRESS ─resolve (resolution required; approval first if required)─► RESOLVED ─► CLOSED
RESOLVED ─reopen (reason; revokes approval)─► IN_PROGRESS
any non-terminal ─cancel (leads only, reason)─► CANCELLED
```

## Scale notes

- **No full-dataset loads.**
  - Lists use **keyset (cursor) pagination**, so cost stays flat at any page depth (unlike `OFFSET`).
  - The dashboard is a handful of capped, index-backed queries.
  - The activity timeline is paginated too.
- **Indexes match the access patterns:** team + status + priority, team + updated, owner + status, partial index on due dates of active work, and GIN for full-text search.
- **Search:** typing `PAY-12` is an exact key lookup. Words are prefix-matched (`refu stu` finds "Refund stuck…"). The "New item" form also uses search to flag **possible duplicates** before you create one.
- **The dashboard only touches active work.** Counters use a partial index over active items, so their cost follows "how much is in flight", not "how much history exists".
- **List totals are capped** at 1,000 (shown as "1,000+"), because exact counts get expensive as history grows.
- **Identity cache.** Each request's session and team-role lookup is cached for up to 30 seconds. Role changes and logouts clear it immediately across all API instances, using Postgres NOTIFY.
- **Measured on the seeded data** (about 6,000 items and 22,000 history events): every list, search, dashboard and timeline query runs in 2 ms or less, using indexes.

## Testing strategy

The tests target the behaviours that would be most dangerous if wrong, and they run against a **real PostgreSQL**, because mocks can't prove locking.

| File | What it proves |
|---|---|
| `api/tests/concurrency.test.ts` | 12 parallel claims → exactly 1 owner and 1 history entry; N parallel edits from one version → exactly 1 applied; idempotent create under 8 concurrent duplicates → 1 item; key reuse with a different body → 422; simultaneous approve and reject → one decision; 15 concurrent creates → unique, gap-free keys |
| `api/tests/authorization.test.ts` | 401s, login lockout after repeated failures, logout and team removal take effect on the very next request, CSRF header, cross-team 404s, list/search isolation, viewer limits, member-vs-lead rules, assignees must be team members, **no self-approval (even admin)**, members can't waive approval, notifications are private |
| `api/tests/workflow.test.ts` | demo data never marks work overdue before its due date; every illegal transition rejected; approval gating; reasons required; reopen revokes approval; full lifecycle produces exact history; failed writes leave no events or jobs; DB constraint backstop; pagination visits every item exactly once; key and prefix search |
| `api/tests/jobs.test.ts` | fan-out recipients; re-delivery doesn't double-notify; backoff then dead-letter without blocking other jobs; partial writes of a failed job roll back; 4 concurrent workers never double-process; SLA scan flags exactly once |
| `web/src/api/hooks.test.tsx` | optimistic update → server result; rollback on 403; conflict adopts server copy and returns the user's change |
| `web/src/lib/nextStep.test.ts` | the per-item "Next:" guidance (owner needed, approval needed, overdue, decision needed) |

To check that the tests actually catch bugs, I removed the row lock (the claim-race and concurrent-edit tests fail) and removed the identity-cache invalidation (the access-revocation test fails).

## Known limitations

- Notifications are in-app only (no email or Slack). There's no password reset or SSO. Login rate limiting is in-memory, so it applies per API instance.
- No attachments, @mentions, custom per-team workflows, moving items between teams, or comment editing.
- Duplicate detection is word-based (Postgres full-text), not semantic.
- The live-update client trusts the network to reconnect. After a reconnect it refetches everything rather than replaying missed events.
- The landing page's background video and display font come from third-party CDNs; the app works without them.

See **ENGINEERING_DECISIONS.md** for the reasoning and trade-offs.
