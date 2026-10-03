# Discussion notes (review prep)

Answers to the six questions the brief says the review will cover, plus likely follow-ups and practice changes. Read this alongside the code. You should be able to open each file named here and explain it in your own words.

---

## 1. "How does your architecture work?" Walk through one save

Example: Priya changes the priority of `PAY-1` from P3 to P1.

1. **Browser.** `ItemDetailPage` calls `useItemMutation` (`web/src/api/hooks.ts`). The badge switches to P1 immediately (an optimistic update) and the request is sent: `PATCH /api/items/:id { version: 7, priority: "P1" }`, with the header `X-Requested-With`.
2. **API entry.** `app.ts` checks the CSRF header and resolves the session cookie into an *actor* (the user plus their team roles, cached and invalidated on change). `routes/items.ts` validates the body with zod.
3. **The single write path.** `mutateItem` (`api/src/services/items.ts`) opens a transaction and runs these steps:
   - `SELECT … FOR UPDATE` locks the row, so a concurrent writer waits behind us.
   - If the item isn't visible to this user, return **404**.
   - If the row's version isn't 7, return **409 VERSION_CONFLICT** with the current item.
   - Check the policy: may Priya edit? (`domain/policy.ts`)
   - `UPDATE … version = version + 1`, insert a `PRIORITY_CHANGED` history event, insert a `notify` job, then `pg_notify`.
   - `COMMIT`. All of the above happen together or not at all.
4. **Response.** The browser swaps its optimistic copy for the server's item (version 8).
5. **Other browsers.** Postgres delivers the NOTIFY (only after commit). Each API process forwards `{itemId, version}` over SSE to users in that team. Their browsers refetch the item through the normal authorized endpoint, and anyone viewing it sees "Priya just updated this item".
6. **Worker.** It picks up the `notify` job (`SKIP LOCKED`), works out who should hear about it (watchers and owner, minus Priya), and inserts notifications. The bell updates live.

## 2. "What happens when things fail?"

| Failure | What happens | Why it's safe |
|---|---|---|
| DB error mid-save | the transaction rolls back: no change, no history, no job, no live event | one transaction, and NOTIFY fires only on commit |
| Network drops after the server saved a create or comment | user retries → same Idempotency-Key → server replays the stored response | idempotency key stored in the same transaction |
| Network drops after an edit was saved | a retry carries the old version → 409 → UI shows the current state | the version check doubles as retry protection |
| Notification job throws | retried at 2s, 4s, 8s…, then marked `DEAD` after 5 attempts; admin can retry from the Teams page | savepoint per job; other jobs continue |
| Worker crashes mid-job | its transaction rolls back and the job stays `PENDING` for the next run | the job is marked done in the same transaction as its effects |
| Job runs twice | second run inserts nothing | `UNIQUE(user_id, event_id)` on notifications |
| Worker down for an hour | actions still work; notifications arrive late; the SLA scan catches up | nothing user-facing waits on the worker |
| Browser loses its live connection | "Reconnecting" indicator; after reconnect, everything is refetched | events may have been missed, so the client doesn't trust its cache |
| Two API instances | both LISTEN; both get every NOTIFY | fan-out via Postgres, not process memory |
| Postgres down | API returns 500s and `/api/health` fails | single point of failure; production fix: managed Postgres with failover |

## 3. "What assumptions did you make?"

- **Work belongs to exactly one team.** Cross-team requests are separate items (moving items between teams is on the list for next week).
- **Roles are per team:** viewer, member or lead. Leads approve; admins manage membership.
- **Payment and compliance items need approval by default.** Only leads can waive it.
- **No self-approval for anyone**, including admins (separation of duties).
- **Users mostly edit different fields.** Conflicts are rare, so optimistic locking beats edit locks.
- **Notifications can be seconds late; data can never be wrong.**
- **"Active" work is a bounded set while history grows forever**, so indexes and queries focus on active work.

## 4. "Which parts matter most?"

1. `mutateItem`: one write path, so every rule is enforced in exactly one place.
2. `policy.ts` and `workflow.ts`: pure, fully tested rules.
3. Transactional history and outbox: the audit trail can't disagree with the data.
4. Idempotency keys: no duplicates from double clicks.

The UI matters, but these four parts are what make the system trustworthy.

## 5. "What would change if it grew significantly?"

**At 10× (tens of thousands of concurrent users, millions of items):**
- Put PgBouncer in front of Postgres and add read replicas for lists and search.
- Partition `activity_events` by month and archive closed items.
- Move live-update fan-out to Redis pub/sub (one LISTEN connection per API process is fine, but NOTIFY throughput has limits).
- Move the login rate limit and identity cache to Redis, so they hold across instances.

**At 100×:**
- Use a dedicated queue (SQS or Kafka) fed from the outbox table, so the outbox pattern stays.
- Use a search service (OpenSearch) for typo tolerance and relevance.
- Split per-team data if teams become tenants.

**What I would *not* change:** the single write path, the version checks and the same-transaction history. Those are the correctness core.

## 6. "What would you do with another week?"

- Email and Slack delivery, with per-user notification preferences (the worker already has the hook).
- @mentions and attachments; moving items between teams (with history); linking duplicates.
- Fine-grained approval rules, e.g. "refunds above ₹1L need two approvers".
- Audit export, and a manager view (throughput, time-in-state, SLA breaches per team).
- A load test (k6) to put numbers on "hundreds of simultaneous users".

---

## Likely follow-up questions

**"Why do you need both a row lock and a version?"**
The lock serializes writers *inside* the database during the transaction. The version detects that a client's *view* is stale. That staleness can be minutes old, from before the transaction even started.

**"Why does claiming not need a version?"**
"Claim if nobody owns it" is a condition on current state, not an edit of something the user saw. The lock plus the owner check makes it atomic. Claiming something you already own is a no-op, so retries are safe.

**"Why 404 instead of 403 for other teams' items?"**
A 403 would confirm the item exists. 404 reveals nothing.

**"Could a viewer bypass the UI?"**
No. The UI hides buttons only as a convenience. Every endpoint re-checks `policy.ts` against the locked row. The tests make these calls directly, the way a user with curl would.

**"Why SSE and not WebSockets?"**
Traffic is server→client only: tiny "item X changed" hints. SSE runs over plain HTTP, reconnects automatically and passes through proxies easily.

**"Why is the identity cache safe?"**
Role changes and logouts clear it immediately (locally, and on other instances via NOTIFY), so the 30-second TTL is only a backstop. A test proves revocation takes effect on the next request.

**"How do you know your tests test anything?"**
I deliberately broke the code (removed `FOR UPDATE`, removed the cache invalidation) and the relevant tests failed.

---

## Practice changes (you may be asked to modify the code live)

Try these yourself before the review. Each one touches the same few places.

1. **Add a "Duplicate of" link.**
   - Add a `duplicate_of uuid` column in a new migration (`api/src/db/migrations/003_…sql`).
   - Accept it in `updateBody` in `routes/items.ts` and handle it in `updateItem` (`services/items.ts`), writing an `EDITED` event.
   - Show it in `ItemDetailPage`.
2. **Let leads move an item to another team.**
   - Add a new service function using `mutateItem`.
   - The policy check needs lead rights in **both** teams.
   - Give the item a new key, add a `MOVED` event, and update `describeEvent` in `NotificationBell.tsx`.
3. **Require a reason when priority goes to P1.**
   - Add the rule in `updateItem`, and accept a `reason` field.
   - Add a test in `workflow.test.ts`.
4. **Add an "On hold" status.**
   - Add it to the enum (migration), to `TRANSITIONS` in `workflow.ts`, to labels in `web/src/lib/format.ts`, and to the `ACTIVE_STATUSES` decision.
   - Tests in `workflow.test.ts` will show what else breaks.
5. **Rate-limit comment creation.** Mirror the login throttle in `services/auth.ts`.
