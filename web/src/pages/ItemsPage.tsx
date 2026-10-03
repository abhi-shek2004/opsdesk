import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useItems, useMe, useMembers } from '../api/hooks';
import { ITEM_TYPES, PRIORITIES, STATUSES, type Priority, type Status } from '../api/types';
import { ItemTable } from '../components/ItemTable';
import { Button, Card, EmptyState, ErrorState, Spinner } from '../components/ui';
import { STATUS_LABEL, TYPE_LABEL } from '../lib/format';

const FILTER_KEYS = [
  'team',
  'status',
  'priority',
  'type',
  'owner',
  'q',
  'active',
  'overdue',
  'watching',
  'sort',
  'createdBy',
];

const VIEWS = [
  { label: 'My open work', params: 'owner=me&active=true&sort=priority' },
  { label: 'Unassigned urgent', params: 'owner=none&active=true&priority=P1,P2&sort=priority' },
  { label: 'Pending approval', params: 'status=PENDING_APPROVAL&sort=priority' },
  { label: 'Overdue', params: 'overdue=true&sort=priority' },
  { label: 'Blocked', params: 'status=BLOCKED' },
  { label: 'Created by me', params: 'createdBy=me' },
];

function Chip({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition ${
        active ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-slate-600 ring-slate-300 hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}

export function ItemsPage() {
  const { data: me } = useMe();
  const [params, setParams] = useSearchParams();

  // The URL is the source of truth for filters: shareable, bookmarkable, survives refresh.
  const filters = useMemo(() => {
    const f: Record<string, string> = {};
    for (const k of FILTER_KEYS) {
      const v = params.get(k);
      if (v) f[k] = v;
    }
    return f;
  }, [params]);

  const [q, setQ] = useState(filters.q ?? '');
  useEffect(() => setQ(filters.q ?? ''), [filters.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.q ?? '') !== q.trim()) update({ q: q.trim() || null });
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k);
      else next.set(k, v);
    }
    setParams(next, { replace: true });
  };

  const toggleList = (key: 'status' | 'priority', value: string) => {
    const current = new Set((filters[key] ?? '').split(',').filter(Boolean));
    if (current.has(value)) current.delete(value);
    else current.add(value);
    const patch: Record<string, string | null> = { [key]: [...current].join(',') || null };
    if (key === 'status') patch.active = null; // explicit statuses replace "active only"
    update(patch);
  };

  const query = useItems(filters);
  const members = useMembers(filters.team);
  const rows = query.data?.pages.flatMap((p) => p.items) ?? [];
  const total = query.data?.pages[0]?.total;
  const capped = !!query.data?.pages[0]?.totalCapped;
  const totalLabel = total === undefined ? '…' : `${total.toLocaleString()}${capped ? '+' : ''}`;
  const selectedStatuses = new Set((filters.status ?? '').split(',').filter(Boolean) as Status[]);
  const selectedPriorities = new Set((filters.priority ?? '').split(',').filter(Boolean) as Priority[]);
  const team = me?.teams.find((t) => t.id === filters.team);
  const hasFilters = Object.keys(filters).some((k) => k !== 'sort');

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">{team ? `${team.name} work` : 'Work items'}</h1>
          <p className="text-sm text-slate-500">
            {total !== undefined ? `${totalLabel} matching item${total === 1 && !capped ? '' : 's'}` : ' '}
            {query.isFetching && !query.isFetchingNextPage && <span className="ml-2 text-slate-400">· updating…</span>}
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {VIEWS.map((v) => (
            <Link
              key={v.label}
              to={`/items?${v.params}`}
              className="rounded-md px-2 py-1 text-xs text-slate-600 hover:bg-slate-200/60"
            >
              {v.label}
            </Link>
          ))}
        </div>
      </div>

      <Card>
        <div className="space-y-3 border-b border-slate-100 p-4">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-6">
            <input
              type="search"
              className="input lg:col-span-2"
              placeholder="Search title, description, key…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              aria-label="Search"
            />
            <select
              className="input"
              value={filters.team ?? ''}
              onChange={(e) => update({ team: e.target.value || null, owner: null })}
              aria-label="Team"
            >
              <option value="">All my teams</option>
              {me?.teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={filters.owner ?? ''}
              onChange={(e) => update({ owner: e.target.value || null })}
              aria-label="Owner"
            >
              <option value="">Any owner</option>
              <option value="me">Me</option>
              <option value="none">Unassigned</option>
              {members.data?.members
                .filter((m) => m.id !== me?.id && m.role !== 'VIEWER')
                .map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
            </select>
            <select
              className="input"
              value={filters.type ?? ''}
              onChange={(e) => update({ type: e.target.value || null })}
              aria-label="Type"
            >
              <option value="">All types</option>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <select
              className="input"
              value={filters.sort ?? 'updated'}
              onChange={(e) => update({ sort: e.target.value })}
              aria-label="Sort"
            >
              <option value="updated">Recently updated</option>
              <option value="priority">Most urgent</option>
              <option value="created">Newest</option>
            </select>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip
              active={filters.active === 'true'}
              onClick={() => update({ active: filters.active === 'true' ? null : 'true', status: null })}
            >
              Active only
            </Chip>
            <span className="mx-1 h-4 w-px bg-slate-200" />
            {STATUSES.map((s) => (
              <Chip key={s} active={selectedStatuses.has(s)} onClick={() => toggleList('status', s)}>
                {STATUS_LABEL[s]}
              </Chip>
            ))}
            <span className="mx-1 h-4 w-px bg-slate-200" />
            {PRIORITIES.map((p) => (
              <Chip key={p} active={selectedPriorities.has(p)} onClick={() => toggleList('priority', p)}>
                {p}
              </Chip>
            ))}
            <Chip
              active={filters.overdue === 'true'}
              onClick={() => update({ overdue: filters.overdue === 'true' ? null : 'true' })}
            >
              Overdue
            </Chip>
            {hasFilters && (
              <button
                className="ml-auto text-xs font-medium text-slate-500 hover:text-slate-800"
                onClick={() => setParams(new URLSearchParams(), { replace: true })}
              >
                Clear filters
              </button>
            )}
          </div>
        </div>

        {query.isLoading ? (
          <div className="flex justify-center p-12 text-slate-400">
            <Spinner />
          </div>
        ) : query.error ? (
          <ErrorState error={query.error} onRetry={query.refetch} />
        ) : rows.length === 0 ? (
          <EmptyState
            title="No work items match these filters."
            hint="Try clearing a filter or searching for different words."
          />
        ) : (
          <div className={query.isPlaceholderData ? 'opacity-60 transition-opacity' : ''}>
            <ItemTable items={rows} showTeam={!filters.team} />
          </div>
        )}
        {query.hasNextPage && (
          <div className="border-t border-slate-100 p-3 text-center">
            <Button onClick={() => query.fetchNextPage()} loading={query.isFetchingNextPage}>
              Load more ({rows.length.toLocaleString()} of {totalLabel})
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}
