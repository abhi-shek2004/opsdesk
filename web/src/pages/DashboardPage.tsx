import { Link } from 'react-router';
import { useDashboard, useMe } from '../api/hooks';
import type { Item } from '../api/types';
import { ItemTable } from '../components/ItemTable';
import { describeEvent } from '../components/NotificationBell';
import { Card, EmptyState, ErrorState, Spinner } from '../components/ui';
import { relativeTime } from '../lib/format';

function Stat({ label, value, to, tone }: { label: string; value: number; to: string; tone: string }) {
  return (
    <Link
      to={to}
      className="group rounded-lg border border-slate-200 bg-white p-4 shadow-xs transition hover:border-slate-300 hover:shadow-sm"
    >
      <p className="text-xs font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-3xl font-semibold tabular-nums ${value > 0 ? tone : 'text-slate-300'}`}>{value}</p>
      <p className="mt-1 text-xs text-brand-600 opacity-0 transition group-hover:opacity-100">View →</p>
    </Link>
  );
}

function Section({ title, items, to, empty }: { title: string; items: Item[]; to: string; empty: string }) {
  return (
    <Card
      title={title}
      action={
        <Link to={to} className="text-xs font-medium text-brand-600 hover:underline">
          View all
        </Link>
      }
    >
      {items.length ? <ItemTable items={items} compact /> : <EmptyState title={empty} />}
    </Card>
  );
}

export function DashboardPage() {
  const { data: me } = useMe();
  const { data, error, isLoading, refetch } = useDashboard();

  if (isLoading) {
    return (
      <div className="flex justify-center p-16 text-slate-400">
        <Spinner />
      </div>
    );
  }
  if (error || !data) return <ErrorState error={error} onRetry={refetch} />;

  const c = data.counts;
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const isLead = !!me && (me.isAdmin || me.teams.some((t) => t.role === 'LEAD'));

  return (
    <div className="mx-auto max-w-7xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">
          {greeting}, {me?.name.split(' ')[0]}
        </h1>
        <p className="text-sm text-slate-500">Here's what needs your attention.</p>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat
          label="My open work"
          value={c.myOpen}
          to="/items?owner=me&active=true&sort=priority"
          tone="text-slate-900"
        />
        {isLead && (
          <Stat label="Awaiting my approval" value={c.awaitingMyApproval} to="/approvals" tone="text-amber-600" />
        )}
        <Stat label="Overdue" value={c.overdue} to="/items?overdue=true&sort=priority" tone="text-red-600" />
        <Stat
          label="Unassigned P1/P2"
          value={c.unassignedUrgent}
          to="/items?owner=none&active=true&priority=P1,P2&sort=priority"
          tone="text-orange-600"
        />
        <Stat label="Blocked" value={c.blocked} to="/items?status=BLOCKED&sort=priority" tone="text-red-600" />
      </div>

      <div className="grid gap-6 xl:grid-cols-3">
        <div className="space-y-6 xl:col-span-2">
          {data.overdue.length > 0 && (
            <Section
              title="🔴 Overdue"
              items={data.overdue}
              to="/items?overdue=true&sort=priority"
              empty="Nothing overdue."
            />
          )}
          {isLead && (
            <Section
              title="Waiting for your approval"
              items={data.awaitingApproval}
              to="/approvals"
              empty="No approvals waiting on you."
            />
          )}
          <Section
            title="Unassigned urgent work"
            items={data.unassignedUrgent}
            to="/items?owner=none&active=true&priority=P1,P2&sort=priority"
            empty="Every urgent item has an owner."
          />
          <Section
            title="My work"
            items={data.myWork}
            to="/items?owner=me&active=true&sort=priority"
            empty="You don't own any active work."
          />
        </div>
        <Card title="Recent activity on items you watch" className="self-start">
          {data.recentActivity.length === 0 ? (
            <EmptyState
              title="No recent activity."
              hint="Items you create, own or comment on are watched automatically."
            />
          ) : (
            <ul className="divide-y divide-slate-100">
              {data.recentActivity.map((e) => (
                <li key={e.id} className="px-4 py-3">
                  <Link to={`/items/${e.item.id}`} className="block hover:text-brand-700">
                    <p className="text-sm text-slate-800">{describeEvent(e.type, e.payload, e.actor?.name ?? null)}</p>
                    <p className="truncate text-xs text-slate-500">
                      <span className="font-mono">{e.item.key}</span> {e.item.title}
                    </p>
                    <p className="text-xs text-slate-400">{relativeTime(e.createdAt)}</p>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
