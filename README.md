<div align="center">

# OpsDesk

**Operational work coordination for teams that can't afford to lose a request.**

[![CI](https://img.shields.io/github/actions/workflow/status/abhi-shek2004/opsdesk/ci.yml?branch=main&style=flat-square&label=CI)](https://github.com/abhi-shek2004/opsdesk/actions/workflows/ci.yml)
![Tests](https://img.shields.io/badge/tests-57%20passing-16a34a?style=flat-square)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?style=flat-square&logo=typescript&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-17%20%7C%2018-336791?style=flat-square&logo=postgresql&logoColor=white)
![Node](https://img.shields.io/badge/Node.js-20%20%7C%2022-5fa04e?style=flat-square&logo=node.js&logoColor=white)

[Live demo](https://opsdesk-gb7f.onrender.com) · [Engineering decisions](ENGINEERING_DECISIONS.md) · [Quick start](#quick-start) · [Configuration](#configuration)

<img src="docs/screenshots/dashboard.png" alt="OpsDesk dashboard" width="900" />

</div>

---

## Overview

OpsDesk replaces chat threads, spreadsheets and email as the place where teams track operational work: customer issues, incidents, payment investigations, compliance requests and approvals.

Every work item has **exactly one owner**, a **status and priority**, a **complete, append-only history**, and a clear **next step**. The system is built to stay correct when many people act on the same work at the same time:

- simultaneous claims produce exactly one owner;
- stale edits are rejected instead of silently overwriting someone else's;
- retried requests never create duplicates;
- approval rules are enforced by the server, not just hidden in the UI.

## Features

| Area | Capabilities |
|---|---|
| **Work items** | Create (with duplicate detection), edit, claim, assign and release, comment, watch; human-readable keys such as `PAY-42` |
| **Workflow** | Open → In progress ⇄ Blocked → Pending approval → Resolved → Closed (plus Cancelled); reasons and resolution notes required where it matters |
| **Approvals** | Lead sign-off for payment and compliance work; separation of duties (no self-approval, including admins); approval queue |
| **Visibility** | Dashboard of what needs attention; filterable, searchable work list with shareable URLs; per-item "Next" guidance; activity timeline |
| **Collaboration** | Live updates over Server-Sent Events, in-app notifications, conflict resolution for concurrent edits |
| **Access control** | Per-team roles (viewer, member, lead) and administrators, enforced on every request |
| **Background processing** | Transactional outbox worker with retries, backoff, dead-lettering and idempotent handlers; SLA breach detection |

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/item-detail.png" alt="Work item with next step, workflow actions and history" /></td>
    <td width="50%"><img src="docs/screenshots/work-items.png" alt="Filtered and searchable work list" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Work item: next step, workflow actions, ownership, history</sub></td>
    <td align="center"><sub>Work list: filters, search, keyset pagination</sub></td>
  </tr>
</table>

## Live demo

**https://opsdesk-gb7f.onrender.com**. Every demo account uses the password `password123`, and the sign-in page offers one-click sign-in.

| Account | Role | Useful for |
|---|---|---|
| `priya@opsdesk.dev` | Payments lead, Compliance member | Approvals and assignment |
| `rahul@opsdesk.dev` | Payments and Operations member | Owns `PAY-1`; requests approval |
| `alex@opsdesk.dev` | Engineering and Payments member | Concurrent claims with Rahul |
| `sam@opsdesk.dev` | Engineering lead | Team isolation (cannot see Payments) |
| `vera@opsdesk.dev` | Viewer | Read and comment only |
| `admin@opsdesk.dev` | Administrator | Team membership; failed background jobs |

> The demo runs on a free instance. After 15 minutes of inactivity the first request takes about a minute while it wakes. The demo accounts are public, so data may have been changed by other visitors.

## Quick start

**Prerequisites:** Node.js 20 or newer, and npm. Docker and a local PostgreSQL are **not** required: an embedded PostgreSQL is installed through npm.

```bash
git clone https://github.com/abhi-shek2004/opsdesk.git
cd opsdesk
npm install
npm run dev
```

Open **http://localhost:5173** and sign in with any demo account.

`npm run dev` starts four processes:

| Process | Address | Purpose |
|---|---|---|
| `db` | `localhost:54329` | Embedded PostgreSQL (data in `./.pgdata`); creates the schema and seeds ~6,000 demo items on first run |
| `api` | `localhost:4000` | HTTP API and live-update stream |
| `worker` | n/a | Background jobs: notifications, SLA scan, cleanup |
| `web` | `localhost:5173` | Vite dev server (proxies `/api` to the API) |

### Using your own PostgreSQL

```bash
docker compose up -d db          # or any PostgreSQL 15+
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/opsdesk
npm run seed                     # schema + demo data (destructive)
npm run dev:external-db
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Full local stack with hot reload |
| `npm test` | API tests (real PostgreSQL) and web tests |
| `npm run lint` | ESLint (zero-warning policy) |
| `npm run format` / `npm run format:check` | Prettier |
| `npm run typecheck` | TypeScript, API and web |
| `npm run build` | Compile the API to `api/dist` and build the web app to `web/dist` |
| `npm start` | Run the production build (after `npm run build`) with embedded PostgreSQL; the API serves the web app on `:4000` |
| `npm run seed` | Reset the database to demo data (**destructive**) |

## Configuration

All configuration is through environment variables. Defaults suit local development.

| Variable | Default | Description |
|---|---|---|
| `DATABASE_URL` | local embedded instance | PostgreSQL connection string |
| `PORT` / `HOST` | `4000` / `127.0.0.1` | HTTP listener (use `HOST=0.0.0.0` in containers) |
| `NODE_ENV` | (unset) | `production` marks the session cookie `Secure` |
| `TRUST_PROXY` | `0` | `1` behind a reverse proxy, so client IPs are correct for login throttling |
| `WORKER_IN_PROCESS` | `0` | `1` runs the job worker inside the API process (single-instance hosting) |
| `SEED_DEMO_DATA` | `0` | `1` seeds demo data on boot when the database is empty |
| `DB_POOL_SIZE` | `20` | PostgreSQL connection pool size |
| `SESSION_TTL_HOURS` | `168` | Session lifetime |
| `ACTOR_CACHE_MS` | `30000` | Identity cache TTL (invalidated immediately on logout or role change) |
| `LOGIN_MAX_FAILURES` | `8` | Failed sign-ins per account in 15 minutes before lockout (×5 per IP) |
| `JOB_MAX_ATTEMPTS` | `5` | Attempts before a job is dead-lettered |
| `JOB_POLL_MS` / `SLA_SCAN_MS` | `1000` / `30000` | Worker polling and SLA scan intervals |
| `LOG_LEVEL` | `info` | Pino log level |
| `TEST_DATABASE_URL` | (unset) | Run tests against an existing, **disposable** database instead of the embedded one |

## Architecture

```
Browser (React · TanStack Query)
   │  REST + httpOnly session cookie            ▲ Server-Sent Events ("item X changed")
   ▼                                            │
API (Fastify) ─ auth → validation (zod) → authorization policy → service
   │   every write: one transaction — lock row → check version → apply rules
   │                → update + version++ → append history → enqueue job → NOTIFY
   ▼
PostgreSQL ─ work items · append-only history · approvals · notifications
   ▲          idempotency keys · jobs (outbox) · full-text search · LISTEN/NOTIFY
   │
Worker ─ jobs via FOR UPDATE SKIP LOCKED · retries with backoff · dead-letter queue
```

The design, the five key decisions and their trade-offs, failure handling and the scaling path are documented in **[ENGINEERING_DECISIONS.md](ENGINEERING_DECISIONS.md)**.

### Project structure

```
├── api/                      Fastify API, worker and tests
│   ├── src/
│   │   ├── domain/           Pure rules: authorization policy, workflow state machine
│   │   ├── services/         Business operations (single write path: mutateItem)
│   │   ├── routes/           HTTP endpoints and request validation
│   │   ├── jobs/             Outbox worker, notification fan-out, SLA scan
│   │   ├── lib/              Idempotency, outbox, live updates, errors
│   │   └── db/               Migrations, connection pool, seed data
│   └── tests/                Concurrency, authorization, workflow and job tests
├── web/                      React application
│   └── src/
│       ├── api/              API client, queries, mutation reconciliation
│       ├── pages/            Dashboard, work list, item detail, approvals, teams
│       ├── components/       Shared UI
│       └── lib/              Live updates, next-step guidance, formatting
├── .github/workflows/ci.yml  Continuous integration
├── render.yaml               Deployment blueprint
└── docker-compose.yml        Optional PostgreSQL for local development
```

## Testing

```bash
npm test
```

57 tests (49 API, 8 web). They focus on the behaviours that are most harmful if wrong, and run with **real concurrent requests against a real PostgreSQL**, because locking guarantees can't be proven with mocks.

| Suite | Covers |
|---|---|
| `api/tests/concurrency.test.ts` | Simultaneous claims (exactly one owner); stale edits (exactly one applied); idempotent creation under concurrent duplicates; approval races; unique, gap-free item keys; a 50-operation mixed burst with no lost or double-applied update |
| `api/tests/authorization.test.ts` | Authentication, CSRF protection, login lockout, team isolation (404), role permissions, separation of duties, immediate revocation on logout or role change |
| `api/tests/workflow.test.ts` | Every invalid transition, approval gating, required reasons, history integrity, the database constraint backstop, keyset pagination, search |
| `api/tests/jobs.test.ts` | Notification fan-out, idempotent redelivery, backoff and dead-lettering, partial-failure rollback, concurrent workers, SLA scan |
| `web/src/**/*.test.ts(x)` | Optimistic update reconciliation (success, rollback, version conflict); next-step guidance |

The concurrency tests were checked by deliberately removing the row lock and confirming they fail.

**Continuous integration** runs on every push and pull request: lint, format check, type-check, all tests and the production build on Node.js 20 and 22, plus the API suite against a standard PostgreSQL server.

## Deployment

The repository includes a [Render](https://render.com) blueprint (`render.yaml`) that provisions a web service and a managed PostgreSQL database:

1. Push the repository to GitHub.
2. In Render, choose **New → Blueprint** and select the repository.
3. On first boot the service applies migrations and loads demo data.

For any other platform, run the compiled build:

```bash
npm ci --include=dev && npm run build
NODE_ENV=production HOST=0.0.0.0 DATABASE_URL=… npm run start -w api   # API + web on $PORT
npm run start:worker -w api                                              # optional separate worker
```

Migrations run automatically on start, guarded by an advisory lock, so multiple instances can start at the same time. Workers can scale horizontally: jobs are claimed with `FOR UPDATE SKIP LOCKED`.

## Security

- Authorization is enforced on the server for every request. Items outside a user's teams return `404`.
- Passwords are hashed with bcrypt. Session tokens are random, stored only as SHA-256 hashes, and carried in `httpOnly`, `SameSite=Lax` cookies (`Secure` in production).
- State-changing requests require a custom header, which blocks cross-site request forgery.
- Login is throttled per account and per IP. Error messages don't reveal whether an account exists.
- All input is validated with zod, and all SQL is parameterised.

## Known limitations

- Notifications are in-app only. There is no email or Slack delivery, password reset or SSO.
- Login throttling and the identity cache are per instance (in memory). With several instances they should move to a shared store such as Redis.
- Duplicate detection is word-based (PostgreSQL full-text search), not semantic.
- After a live-update disconnect the client refetches its data rather than replaying missed events.
- Scale has been measured at ~6,000 items and 22,000 history events (all key queries ≤ 2 ms). It has not been load-tested at thousands of concurrent users.
- The landing page loads its background video and display font from public CDNs. The application works without them.
