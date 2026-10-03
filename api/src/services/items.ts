import { pool, withTx, type Db, type Tx } from '../db/pool.js';
import { can, canOwnWork, roleIn } from '../domain/policy.js';
import {
  ACTIVE_STATUSES,
  APPROVAL_TYPES_DEFAULT,
  TERMINAL_STATUSES,
  type Actor,
  type ItemState,
  type ItemType,
  type Priority,
  type Status,
} from '../domain/types.js';
import { TRANSITIONS, planTransition, structuralBlocker } from '../domain/workflow.js';
import { AppError, conflict, forbidden, notFound, ruleViolation } from '../lib/errors.js';
import { runIdempotent } from '../lib/idempotency.js';
import { enqueue, publish } from '../lib/outbox.js';

// ───────────────────────────── Read model ─────────────────────────────

const ITEM_SELECT = `
  SELECT i.id, i.key, i.team_id, t.name AS team_name, t.key AS team_key, i.type, i.title,
         i.description, i.status, i.priority, i.owner_id, o.name AS owner_name,
         i.created_by, cb.name AS created_by_name, i.requires_approval, i.approved_at,
         i.approved_by, ab.name AS approved_by_name, i.resolution, i.due_at, i.sla_breached_at,
         i.version, i.created_at, i.updated_at, i.resolved_at
  FROM work_items i
  JOIN teams t ON t.id = i.team_id
  JOIN users cb ON cb.id = i.created_by
  LEFT JOIN users o ON o.id = i.owner_id
  LEFT JOIN users ab ON ab.id = i.approved_by`;

type Row = Record<string, any>;

function stateOf(r: Row): ItemState {
  return {
    id: r.id,
    teamId: r.team_id,
    status: r.status,
    ownerId: r.owner_id,
    createdBy: r.created_by,
    requiresApproval: r.requires_approval,
    approvedAt: r.approved_at,
    version: r.version,
  };
}

export function availableTransitions(actor: Actor, item: ItemState): Status[] {
  return TRANSITIONS[item.status].filter((to) => {
    if (to === 'CANCELLED') return can.cancel(actor, item);
    if (!can.transition(actor, item)) return false;
    return structuralBlocker(item, to) === null;
  });
}

function permissionsFor(actor: Actor, item: ItemState, pendingRequestedBy?: string) {
  const closed = TERMINAL_STATUSES.includes(item.status);
  return {
    edit: !closed && can.editItem(actor, item),
    changeApprovalRequirement: !closed && can.changeApprovalRequirement(actor, item),
    claim: !closed && item.status !== 'RESOLVED' && !item.ownerId && can.claim(actor, item),
    assign: !closed && item.status !== 'RESOLVED' && can.assign(actor, item),
    unassign: !!item.ownerId && item.status !== 'PENDING_APPROVAL' && !closed && can.unassign(actor, item),
    comment: can.comment(actor, item),
    transitions: availableTransitions(actor, item),
    decideApproval: item.status === 'PENDING_APPROVAL' && can.decideApproval(actor, item, pendingRequestedBy),
  };
}

export function toItemDto(r: Row, actor: Actor, pendingRequestedBy?: string) {
  const state = stateOf(r);
  return {
    id: r.id as string,
    key: r.key as string,
    team: { id: r.team_id, name: r.team_name, key: r.team_key },
    type: r.type as ItemType,
    title: r.title as string,
    description: r.description as string,
    status: r.status as Status,
    priority: r.priority as Priority,
    owner: r.owner_id ? { id: r.owner_id, name: r.owner_name } : null,
    createdBy: { id: r.created_by, name: r.created_by_name },
    requiresApproval: r.requires_approval as boolean,
    approvedAt: r.approved_at,
    approvedBy: r.approved_by ? { id: r.approved_by, name: r.approved_by_name } : null,
    resolution: r.resolution,
    dueAt: r.due_at,
    slaBreachedAt: r.sla_breached_at,
    version: r.version as number,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at,
    permissions: permissionsFor(actor, state, pendingRequestedBy),
  };
}
export type ItemDto = ReturnType<typeof toItemDto>;

/** Full item view, including approval and watch state. Returns null if missing or not visible. */
export async function loadItem(db: Db, actor: Actor, id: string) {
  const { rows } = await db.query(`${ITEM_SELECT} WHERE i.id = $1`, [id]);
  const r = rows[0];
  if (!r || !can.viewItem(actor, { teamId: r.team_id })) return null;

  const [pending, watch] = await Promise.all([
    db.query(
      `SELECT a.id, a.requested_by, u.name AS requested_by_name, a.requested_at, a.note
       FROM approvals a JOIN users u ON u.id = a.requested_by
       WHERE a.work_item_id = $1 AND a.decided_at IS NULL`,
      [id],
    ),
    db.query(`SELECT count(*) AS watchers, bool_or(user_id = $2) AS watching FROM watchers WHERE work_item_id = $1`, [
      id,
      actor.id,
    ]),
  ]);
  const p = pending.rows[0];
  return {
    ...toItemDto(r, actor, p?.requested_by),
    pendingApproval: p
      ? {
          id: p.id,
          requestedBy: { id: p.requested_by, name: p.requested_by_name },
          requestedAt: p.requested_at,
          note: p.note,
        }
      : null,
    watcherCount: watch.rows[0].watchers as number,
    watching: Boolean(watch.rows[0].watching),
  };
}
export type ItemDetailDto = NonNullable<Awaited<ReturnType<typeof loadItem>>>;

export async function getItem(actor: Actor, id: string) {
  const item = await loadItem(pool, actor, id);
  if (!item) throw notFound('Work item');
  return item;
}

// ───────────────────────────── Listing & search ─────────────────────────────

export type SortKey = 'updated' | 'created' | 'priority';

export const COUNT_CAP = 1000;

export interface ListFilters {
  teamId?: string;
  status?: Status[];
  priority?: Priority[];
  type?: ItemType[];
  owner?: string; // 'me' | 'none' | uuid
  createdBy?: string; // 'me' | uuid
  q?: string;
  active?: boolean;
  overdue?: boolean;
  watching?: boolean;
  sort: SortKey;
  cursor?: string;
  limit: number;
}

const SORTS: Record<SortKey, { order: string; cols: string[]; casts: string[]; dir: '<' | '>' }> = {
  updated: {
    order: 'i.updated_at DESC, i.id DESC',
    cols: ['i.updated_at', 'i.id'],
    casts: ['timestamptz', 'uuid'],
    dir: '<',
  },
  created: {
    order: 'i.created_at DESC, i.id DESC',
    cols: ['i.created_at', 'i.id'],
    casts: ['timestamptz', 'uuid'],
    dir: '<',
  },
  priority: {
    order: 'i.priority ASC, i.created_at ASC, i.id ASC',
    cols: ['i.priority', 'i.created_at', 'i.id'],
    casts: ['item_priority', 'timestamptz', 'uuid'],
    dir: '>',
  },
};

/** Turn free text into a prefix-matching tsquery: "refund stu" → "refund:* & stu:*". */
export function toPrefixQuery(q: string, joiner: '&' | '|' = '&'): string | null {
  const tokens = (q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 8);
  return tokens.length ? tokens.map((t) => `${t}:*`).join(` ${joiner} `) : null;
}

function encodeCursor(sort: SortKey, values: unknown[]): string {
  return Buffer.from(JSON.stringify({ s: sort, v: values })).toString('base64url');
}

function decodeCursor(sort: SortKey, cursor: string): unknown[] {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (parsed.s === sort && Array.isArray(parsed.v) && parsed.v.length === SORTS[sort].cols.length) return parsed.v;
  } catch {
    /* fall through */
  }
  throw new AppError(400, 'INVALID_CURSOR', 'Invalid pagination cursor.');
}

export async function listItems(actor: Actor, f: ListFilters) {
  const params: unknown[] = [];
  const p = (v: unknown) => `$${params.push(v)}`;
  const where: string[] = [];

  if (!actor.isAdmin) where.push(`i.team_id = ANY(${p([...actor.memberships.keys()])}::uuid[])`);
  if (f.teamId) where.push(`i.team_id = ${p(f.teamId)}`);
  if (f.status?.length) where.push(`i.status = ANY(${p(f.status)}::item_status[])`);
  else if (f.active) where.push(`i.status = ANY(${p(ACTIVE_STATUSES)}::item_status[])`);
  if (f.priority?.length) where.push(`i.priority = ANY(${p(f.priority)}::item_priority[])`);
  if (f.type?.length) where.push(`i.type = ANY(${p(f.type)}::item_type[])`);
  if (f.owner === 'none') where.push('i.owner_id IS NULL');
  else if (f.owner) where.push(`i.owner_id = ${p(f.owner === 'me' ? actor.id : f.owner)}`);
  if (f.createdBy) where.push(`i.created_by = ${p(f.createdBy === 'me' ? actor.id : f.createdBy)}`);
  if (f.overdue) {
    where.push(`i.due_at < now() AND i.status = ANY(${p(ACTIVE_STATUSES)}::item_status[])`);
  }
  if (f.watching) {
    where.push(`EXISTS (SELECT 1 FROM watchers w WHERE w.work_item_id = i.id AND w.user_id = ${p(actor.id)})`);
  }
  if (f.q?.trim()) {
    const q = f.q.trim();
    if (/^[A-Za-z]{2,6}-\d+$/.test(q)) {
      // Looks like an item key (e.g. PAY-12): exact lookup, not fuzzy text search.
      where.push(`i.key = ${p(q.toUpperCase())}`);
    } else {
      const tsq = toPrefixQuery(q);
      if (tsq) where.push(`i.search @@ to_tsquery('english', ${p(tsq)})`);
    }
  }

  // Filters push their params first, so the count query can reuse this prefix.
  const baseWhere = [...where];
  const baseParams = params.slice();

  const sort = SORTS[f.sort];
  if (f.cursor) {
    // Keyset pagination: "rows after the last one I saw" — O(page) at any depth, unlike OFFSET.
    const values = decodeCursor(f.sort, f.cursor);
    const tuple = values.map((v, idx) => `${p(v)}::${sort.casts[idx]}`).join(', ');
    where.push(`(${sort.cols.join(', ')}) ${sort.dir} (${tuple})`);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Cursor values are read back as text so timestamps keep full microsecond precision.
  const cursorCols = sort.cols.map((c, idx) => `${c}::text AS _c${idx}`).join(', ');
  const select = ITEM_SELECT.replace('i.description,', 'left(i.description, 240) AS description,').replace(
    'i.resolved_at',
    `i.resolved_at, ${cursorCols}`,
  );
  const { rows } = await pool.query(`${select} ${whereSql} ORDER BY ${sort.order} LIMIT ${p(f.limit + 1)}`, params);

  const hasMore = rows.length > f.limit;
  const page = hasMore ? rows.slice(0, f.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor(
          f.sort,
          sort.cols.map((_c, idx) => last[`_c${idx}`]),
        )
      : null;

  // Exact counts get expensive as history grows, and nobody needs "48,213" vs "48,214".
  // Count at most COUNT_CAP + 1 rows; the UI shows "1,000+" beyond that.
  let total: number | undefined;
  let totalCapped = false;
  if (!f.cursor) {
    const countSql = `SELECT count(*) AS n FROM (SELECT 1 FROM work_items i
      ${baseWhere.length ? `WHERE ${baseWhere.join(' AND ')}` : ''} LIMIT ${COUNT_CAP + 1}) capped`;
    const n: number = (await pool.query(countSql, baseParams)).rows[0].n;
    totalCapped = n > COUNT_CAP;
    total = Math.min(n, COUNT_CAP);
  }

  return { items: page.map((r) => toItemDto(r, actor)), nextCursor, total, totalCapped };
}

/** Possible duplicates for the "create item" form: open items with overlapping words. */
export async function findSimilar(actor: Actor, teamId: string | undefined, text: string) {
  const tsq = toPrefixQuery(text, '|');
  if (!tsq) return [];
  const params: unknown[] = [tsq, ACTIVE_STATUSES];
  const where = [`i.search @@ to_tsquery('english', $1)`, `i.status = ANY($2::item_status[])`];
  if (!actor.isAdmin) where.push(`i.team_id = ANY($${params.push([...actor.memberships.keys()])}::uuid[])`);
  if (teamId) where.push(`i.team_id = $${params.push(teamId)}`);
  const { rows } = await pool.query(
    `SELECT i.id, i.key, i.title, i.status, i.priority, ts_rank(i.search, to_tsquery('english', $1)) AS rank
     FROM work_items i WHERE ${where.join(' AND ')} ORDER BY rank DESC, i.updated_at DESC LIMIT 5`,
    params,
  );
  return rows.filter((r) => r.rank > 0.05).map(({ rank: _r, ...r }) => r);
}

// ───────────────────────────── Mutations ─────────────────────────────

interface EventSpec {
  type: string;
  payload?: Record<string, unknown>;
}

interface Change {
  set?: Record<string, unknown>;
  events: EventSpec[];
  addWatchers?: string[];
}

/**
 * The single write path for existing items. Inside one transaction it:
 *  1. locks the row (SELECT … FOR UPDATE) so concurrent writers queue up;
 *  2. hides items the actor cannot see (404, not 403 — don't leak existence);
 *  3. rejects stale writes when the caller's version != current version (409);
 *  4. lets `decide` apply policy + workflow rules against the *locked, fresh* state;
 *  5. writes the update, bumps the version, appends history events,
 *     enqueues notification jobs and publishes a live-update hint.
 * All or nothing: history, jobs and data can never disagree.
 */
async function mutateItem(
  actor: Actor,
  itemId: string,
  expectedVersion: number | undefined,
  decide: (row: Row, state: ItemState, tx: Tx) => Promise<Change>,
): Promise<ItemDetailDto> {
  return withTx(async (tx) => {
    const { rows } = await tx.query('SELECT * FROM work_items WHERE id = $1 FOR UPDATE', [itemId]);
    const row = rows[0];
    if (!row || !can.viewItem(actor, { teamId: row.team_id })) throw notFound('Work item');
    const state = stateOf(row);

    if (expectedVersion !== undefined && expectedVersion !== row.version) {
      const current = await loadItem(tx, actor, itemId);
      const last = await tx.query(
        `SELECT e.type, e.created_at, u.name AS actor_name FROM activity_events e
         LEFT JOIN users u ON u.id = e.actor_id WHERE e.work_item_id = $1 ORDER BY e.id DESC LIMIT 1`,
        [itemId],
      );
      throw conflict('VERSION_CONFLICT', 'This item was changed by someone else since you loaded it.', {
        current,
        lastChange: last.rows[0] ?? null,
      });
    }

    const change = await decide(row, state, tx);
    const set = change.set ?? {};
    const cols = Object.keys(set);

    if (cols.length === 0 && change.events.length === 0) {
      return (await loadItem(tx, actor, itemId))!; // no-op: nothing to record
    }

    if (cols.length) {
      const assignments = cols.map((c, idx) => `${c} = $${idx + 2}`).join(', ');
      await tx.query(`UPDATE work_items SET ${assignments}, version = version + 1, updated_at = now() WHERE id = $1`, [
        itemId,
        ...cols.map((c) => set[c]),
      ]);
    } else {
      await tx.query('UPDATE work_items SET updated_at = now() WHERE id = $1', [itemId]);
    }

    await recordEvents(tx, actor.id, itemId, change.events);
    await addWatchers(tx, itemId, [actor.id, ...(change.addWatchers ?? [])]);

    const updated = (await loadItem(tx, actor, itemId))!;
    await publish(tx, {
      kind: 'item',
      itemId,
      teamId: row.team_id,
      version: updated.version,
      actorId: actor.id,
      event: change.events[0]?.type ?? 'UPDATED',
    });
    return updated;
  });
}

async function recordEvents(tx: Tx, actorId: string | null, itemId: string, events: EventSpec[]) {
  for (const e of events) {
    const { rows } = await tx.query(
      'INSERT INTO activity_events(work_item_id, actor_id, type, payload) VALUES ($1, $2, $3, $4) RETURNING id',
      [itemId, actorId, e.type, JSON.stringify(e.payload ?? {})],
    );
    await enqueue(tx, 'notify', { eventId: rows[0].id });
  }
}

async function addWatchers(tx: Tx, itemId: string, userIds: (string | null | undefined)[]) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))];
  if (!ids.length) return;
  await tx.query(`INSERT INTO watchers(work_item_id, user_id) SELECT $1, unnest($2::uuid[]) ON CONFLICT DO NOTHING`, [
    itemId,
    ids,
  ]);
}

function assertNotClosed(state: ItemState) {
  if (TERMINAL_STATUSES.includes(state.status)) {
    throw ruleViolation('ITEM_CLOSED', `This item is ${state.status.toLowerCase()} and can no longer be changed.`);
  }
}

async function userName(tx: Db, id: string | null): Promise<string | null> {
  if (!id) return null;
  return (await tx.query('SELECT name FROM users WHERE id = $1', [id])).rows[0]?.name ?? null;
}

// ── Create ──

export interface CreateItemInput {
  teamId: string;
  type: ItemType;
  title: string;
  description?: string;
  priority: Priority;
  dueAt?: string | null;
  requiresApproval?: boolean;
  assignToMe?: boolean;
}

export async function createItem(actor: Actor, input: CreateItemInput, idempotencyKey?: string) {
  return withTx((tx) =>
    runIdempotent(tx, actor.id, idempotencyKey, 'create-item', input, async () => {
      if (!can.viewTeam(actor, input.teamId)) throw notFound('Team');
      if (!can.createItem(actor, input.teamId)) throw forbidden('Viewers cannot create work items in this team.');

      const defaultApproval = APPROVAL_TYPES_DEFAULT.includes(input.type);
      const isLead = actor.isAdmin || roleIn(actor, input.teamId) === 'LEAD';
      // Only leads may waive approval on types that need it by default.
      const requiresApproval = isLead
        ? (input.requiresApproval ?? defaultApproval)
        : defaultApproval || Boolean(input.requiresApproval);

      const team = await tx.query(
        'UPDATE teams SET next_number = next_number + 1 WHERE id = $1 RETURNING key, next_number - 1 AS n',
        [input.teamId],
      );
      if (!team.rowCount) throw notFound('Team');
      const { key: teamKey, n } = team.rows[0];

      const { rows } = await tx.query(
        `INSERT INTO work_items(team_id, number, key, type, title, description, priority, due_at,
                                requires_approval, created_by, owner_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          input.teamId,
          n,
          `${teamKey}-${n}`,
          input.type,
          input.title.trim(),
          input.description?.trim() ?? '',
          input.priority,
          input.dueAt ?? null,
          requiresApproval,
          actor.id,
          input.assignToMe ? actor.id : null,
        ],
      );
      const id = rows[0].id as string;
      await recordEvents(tx, actor.id, id, [
        {
          type: 'CREATED',
          payload: { title: input.title, priority: input.priority, type: input.type, requiresApproval },
        },
      ]);
      await addWatchers(tx, id, [actor.id]);
      await publish(tx, {
        kind: 'item',
        itemId: id,
        teamId: input.teamId,
        version: 1,
        actorId: actor.id,
        event: 'CREATED',
      });
      return { status: 201, body: (await loadItem(tx, actor, id))! };
    }),
  );
}

// ── Edit fields ──

export interface UpdateItemInput {
  title?: string;
  description?: string;
  priority?: Priority;
  type?: ItemType;
  dueAt?: string | null;
  requiresApproval?: boolean;
}

export function updateItem(actor: Actor, id: string, version: number, patch: UpdateItemInput) {
  return mutateItem(actor, id, version, async (row, state) => {
    assertNotClosed(state);
    if (!can.editItem(actor, state)) throw forbidden('Only the owner, creator or a team lead can edit this item.');

    const set: Record<string, unknown> = {};
    const events: EventSpec[] = [];
    const edits: Record<string, { from: unknown; to: unknown }> = {};

    if (patch.title !== undefined && patch.title.trim() !== row.title) {
      set.title = patch.title.trim();
      edits.title = { from: row.title, to: set.title };
    }
    if (patch.description !== undefined && patch.description.trim() !== row.description) {
      set.description = patch.description.trim();
      edits.description = { from: truncate(row.description), to: truncate(set.description as string) };
    }
    if (patch.type !== undefined && patch.type !== row.type) {
      set.type = patch.type;
      edits.type = { from: row.type, to: patch.type };
    }
    if (patch.dueAt !== undefined) {
      const next = patch.dueAt ? new Date(patch.dueAt) : null;
      const prev = row.due_at as Date | null;
      if ((next?.getTime() ?? null) !== (prev?.getTime() ?? null)) {
        set.due_at = next;
        set.sla_breached_at = null; // new deadline → re-arm the SLA check
        edits.dueAt = { from: prev, to: next };
      }
    }
    if (patch.requiresApproval !== undefined && patch.requiresApproval !== row.requires_approval) {
      if (!can.changeApprovalRequirement(actor, state))
        throw forbidden('Only a team lead can change approval requirements.');
      if (state.status === 'PENDING_APPROVAL')
        throw ruleViolation('APPROVAL_IN_PROGRESS', 'Cannot change approval requirement while approval is pending.');
      set.requires_approval = patch.requiresApproval;
      edits.requiresApproval = { from: row.requires_approval, to: patch.requiresApproval };
    }
    if (Object.keys(edits).length) events.push({ type: 'EDITED', payload: { changes: edits } });

    if (patch.priority !== undefined && patch.priority !== row.priority) {
      set.priority = patch.priority;
      events.push({ type: 'PRIORITY_CHANGED', payload: { from: row.priority, to: patch.priority } });
    }
    return { set, events };
  });
}

const truncate = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ── Ownership ──

/**
 * Take ownership of unowned work. Two people clicking "Claim" at the same
 * moment are serialized by the row lock; the second sees an owner and gets 409.
 * Claiming something you already own is a harmless no-op (safe to retry).
 */
export function claimItem(actor: Actor, id: string) {
  return mutateItem(actor, id, undefined, async (row, state, tx) => {
    assertNotClosed(state);
    if (!can.claim(actor, state)) throw forbidden('Viewers cannot take ownership of work.');
    if (state.ownerId === actor.id) return { events: [] };
    if (state.ownerId) {
      const owner = await userName(tx, state.ownerId);
      throw conflict('ALREADY_CLAIMED', `${owner ?? 'Someone else'} already owns this item.`, {
        owner: { id: state.ownerId, name: owner },
      });
    }
    if (state.status === 'RESOLVED') throw ruleViolation('ITEM_RESOLVED', 'Reopen the item before claiming it.');

    const events: EventSpec[] = [
      { type: 'ASSIGNED', payload: { from: null, to: { id: actor.id, name: actor.name }, claimed: true } },
    ];
    const set: Record<string, unknown> = { owner_id: actor.id };
    if (row.status === 'OPEN') {
      set.status = 'IN_PROGRESS';
      events.push({ type: 'STATUS_CHANGED', payload: { from: 'OPEN', to: 'IN_PROGRESS' } });
    }
    return { set, events };
  });
}

export function assignItem(actor: Actor, id: string, version: number | undefined, userId: string | null) {
  return mutateItem(actor, id, version, async (row, state, tx) => {
    assertNotClosed(state);
    if (state.ownerId === userId) return { events: [] };
    const fromName = await userName(tx, state.ownerId);
    const from = state.ownerId ? { id: state.ownerId, name: fromName } : null;

    if (userId === null) {
      if (!can.unassign(actor, state)) throw forbidden();
      if (state.status === 'PENDING_APPROVAL')
        throw ruleViolation('APPROVAL_IN_PROGRESS', 'Withdraw the approval request before unassigning.');
      const set: Record<string, unknown> = { owner_id: null };
      const events: EventSpec[] = [{ type: 'ASSIGNED', payload: { from, to: null } }];
      if (state.status === 'IN_PROGRESS' || state.status === 'BLOCKED') {
        set.status = 'OPEN';
        events.push({
          type: 'STATUS_CHANGED',
          payload: { from: row.status, to: 'OPEN', reason: 'Owner released the item' },
        });
      }
      return { set, events };
    }

    const selfClaim = userId === actor.id && can.claim(actor, state) && !state.ownerId;
    if (!selfClaim && !can.assign(actor, state)) throw forbidden('Only team leads can assign work to others.');
    if (state.status === 'RESOLVED') throw ruleViolation('ITEM_RESOLVED', 'Reopen the item before reassigning it.');

    const member = await tx.query(
      `SELECT u.name, m.role FROM users u LEFT JOIN team_members m ON m.user_id = u.id AND m.team_id = $2
       WHERE u.id = $1`,
      [userId, state.teamId],
    );
    const target = member.rows[0];
    if (!target) throw notFound('User');
    if (!canOwnWork(target.role)) {
      throw ruleViolation('INVALID_ASSIGNEE', `${target.name} is not a member of this team and cannot own its work.`);
    }
    return {
      set: { owner_id: userId },
      events: [{ type: 'ASSIGNED', payload: { from, to: { id: userId, name: target.name } } }],
      addWatchers: [userId],
    };
  });
}

// ── Workflow ──

export interface TransitionRequest {
  to: Status;
  version?: number;
  reason?: string;
  resolution?: string;
}

export function transitionItem(actor: Actor, id: string, req: TransitionRequest) {
  return mutateItem(actor, id, req.version, async (_row, state, tx) => {
    const allowed = req.to === 'CANCELLED' ? can.cancel(actor, state) : can.transition(actor, state);
    if (!allowed) {
      throw forbidden(
        req.to === 'CANCELLED'
          ? 'Only team leads can cancel work.'
          : 'Only the owner or a team lead can move this item through the workflow.',
      );
    }
    const plan = planTransition(state, req.to, req);
    const set: Record<string, unknown> = { status: plan.to };
    if (plan.setResolvedAt) {
      set.resolved_at = new Date();
      set.resolution = req.resolution!.trim();
    }
    if (plan.clearResolvedAt) {
      set.resolved_at = null;
      set.resolution = null;
    }
    if (plan.clearApproval && state.approvedAt) {
      set.approved_at = null;
      set.approved_by = null;
    }

    let type = 'STATUS_CHANGED';
    if (plan.withdrawApprovalRequest) {
      await tx.query(
        `UPDATE approvals SET decided_at = now(), decided_by = $2, decision = 'WITHDRAWN', reason = $3
         WHERE work_item_id = $1 AND decided_at IS NULL`,
        [id, actor.id, req.reason ?? null],
      );
      if (plan.to === 'IN_PROGRESS') type = 'APPROVAL_WITHDRAWN';
    }
    if (plan.openApprovalRequest) {
      await tx.query('INSERT INTO approvals(work_item_id, requested_by, note) VALUES ($1, $2, $3)', [
        id,
        actor.id,
        req.reason?.trim() || null,
      ]);
      type = 'APPROVAL_REQUESTED';
    }

    return {
      set,
      events: [
        {
          type,
          payload: {
            from: plan.from,
            to: plan.to,
            reason: req.reason?.trim() || undefined,
            resolution: plan.setResolvedAt ? req.resolution?.trim() : undefined,
            approvalCleared: plan.clearApproval && !!state.approvedAt ? true : undefined,
          },
        },
      ],
    };
  });
}

/**
 * Approve or reject a pending request. Two leads deciding at the same time are
 * serialized by the item row lock; the loser finds the item no longer pending.
 */
export function decideApproval(actor: Actor, id: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
  return mutateItem(actor, id, undefined, async (_row, state, tx) => {
    const { rows } = await tx.query(
      'SELECT id, requested_by FROM approvals WHERE work_item_id = $1 AND decided_at IS NULL FOR UPDATE',
      [id],
    );
    const pending = rows[0];
    if (state.status !== 'PENDING_APPROVAL' || !pending) {
      throw conflict('NOT_PENDING_APPROVAL', 'This item is not awaiting approval (it may already have been decided).');
    }
    if (state.ownerId === actor.id || state.createdBy === actor.id || pending.requested_by === actor.id) {
      throw new AppError(403, 'SELF_APPROVAL', 'You cannot approve or reject work you own, created or requested.');
    }
    if (!can.decideApproval(actor, state, pending.requested_by))
      throw forbidden('Only team leads can decide approvals.');
    if (decision === 'REJECTED' && !reason?.trim()) {
      throw ruleViolation('REASON_REQUIRED', 'A reason is required to reject.');
    }

    await tx.query(
      'UPDATE approvals SET decided_at = now(), decided_by = $2, decision = $3, reason = $4 WHERE id = $1',
      [pending.id, actor.id, decision, reason?.trim() || null],
    );
    const set: Record<string, unknown> = { status: 'IN_PROGRESS' };
    if (decision === 'APPROVED') {
      set.approved_at = new Date();
      set.approved_by = actor.id;
    }
    return {
      set,
      events: [
        {
          type: decision,
          payload: { reason: reason?.trim() || undefined, from: 'PENDING_APPROVAL', to: 'IN_PROGRESS' },
        },
      ],
    };
  });
}

// ── Comments, watching, history ──

export async function addComment(actor: Actor, id: string, body: string, idempotencyKey?: string) {
  return withTx((tx) =>
    runIdempotent(tx, actor.id, idempotencyKey, `comment:${id}`, { body }, async () => {
      const { rows } = await tx.query('SELECT team_id FROM work_items WHERE id = $1', [id]);
      if (!rows[0] || !can.viewItem(actor, { teamId: rows[0].team_id })) throw notFound('Work item');
      await tx.query('UPDATE work_items SET updated_at = now() WHERE id = $1', [id]);
      const ev = await tx.query(
        `INSERT INTO activity_events(work_item_id, actor_id, type, payload)
         VALUES ($1, $2, 'COMMENTED', $3) RETURNING id, created_at`,
        [id, actor.id, JSON.stringify({ body: body.trim() })],
      );
      await enqueue(tx, 'notify', { eventId: ev.rows[0].id });
      await addWatchers(tx, id, [actor.id]);
      const version = (await tx.query('SELECT version FROM work_items WHERE id = $1', [id])).rows[0].version;
      await publish(tx, {
        kind: 'item',
        itemId: id,
        teamId: rows[0].team_id,
        version,
        actorId: actor.id,
        event: 'COMMENTED',
      });
      return {
        status: 201,
        body: {
          id: ev.rows[0].id as number,
          type: 'COMMENTED',
          actor: { id: actor.id, name: actor.name },
          payload: { body: body.trim() },
          createdAt: ev.rows[0].created_at,
        },
      };
    }),
  );
}

export async function setWatching(actor: Actor, id: string, watching: boolean) {
  const { rows } = await pool.query('SELECT team_id FROM work_items WHERE id = $1', [id]);
  if (!rows[0] || !can.viewItem(actor, { teamId: rows[0].team_id })) throw notFound('Work item');
  if (watching) await addWatchers(pool as unknown as Tx, id, [actor.id]);
  else await pool.query('DELETE FROM watchers WHERE work_item_id = $1 AND user_id = $2', [id, actor.id]);
  return { watching };
}

export async function listActivity(actor: Actor, id: string, before: number | undefined, limit: number) {
  const { rows: items } = await pool.query('SELECT team_id FROM work_items WHERE id = $1', [id]);
  if (!items[0] || !can.viewItem(actor, { teamId: items[0].team_id })) throw notFound('Work item');
  const { rows } = await pool.query(
    `SELECT e.id, e.type, e.payload, e.created_at, e.actor_id, u.name AS actor_name
     FROM activity_events e LEFT JOIN users u ON u.id = e.actor_id
     WHERE e.work_item_id = $1 ${before ? 'AND e.id < $3' : ''}
     ORDER BY e.id DESC LIMIT $2`,
    before ? [id, limit + 1, before] : [id, limit + 1],
  );
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return {
    events: page.map((r) => ({
      id: r.id as number,
      type: r.type as string,
      actor: r.actor_id ? { id: r.actor_id, name: r.actor_name } : null,
      payload: r.payload,
      createdAt: r.created_at,
    })),
    nextCursor: hasMore ? page[page.length - 1].id : null,
  };
}
