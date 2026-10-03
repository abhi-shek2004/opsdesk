import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api, qs } from '../api/client';
import { qk, useMe, useMembers, useTeams } from '../api/hooks';
import type { Role } from '../api/types';
import { Avatar, Button, Card, EmptyState, Spinner } from '../components/ui';
import { relativeTime } from '../lib/format';
import { useToast } from '../lib/toast';

const ROLES: Role[] = ['VIEWER', 'MEMBER', 'LEAD'];
const ROLE_HELP: Record<Role, string> = {
  VIEWER: 'Read & comment',
  MEMBER: 'Create, claim and work items',
  LEAD: 'Assign, cancel and approve',
};

export function TeamsPage() {
  const { data: me } = useMe();
  const teams = useTeams();
  const [selected, setSelected] = useState<string | null>(null);
  const teamId = selected ?? teams.data?.teams[0]?.id ?? null;
  const team = teams.data?.teams.find((t) => t.id === teamId);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Teams</h1>
        <p className="text-sm text-slate-500">
          Roles are per team.{' '}
          {me?.isAdmin ? 'As an admin you can change membership.' : 'Ask an admin to change membership.'}
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card>
          {teams.isLoading ? (
            <div className="p-6 text-slate-400">
              <Spinner />
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {teams.data?.teams.map((t) => (
                <li key={t.id}>
                  <button
                    onClick={() => setSelected(t.id)}
                    className={`flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50 ${t.id === teamId ? 'bg-brand-50/60' : ''}`}
                  >
                    <span>
                      <span className="block text-sm font-medium">{t.name}</span>
                      <span className="text-xs text-slate-500">
                        {t.memberCount} members · {t.activeItems} active items
                      </span>
                    </span>
                    <span className="font-mono text-xs text-slate-400">{t.key}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
        {team && <TeamMembers teamId={team.id} teamName={team.name} canManage={!!me?.isAdmin} />}
      </div>
      {me?.isAdmin && <JobsPanel />}
    </div>
  );
}

function TeamMembers({ teamId, teamName, canManage }: { teamId: string; teamName: string; canManage: boolean }) {
  const members = useMembers(teamId);
  const qc = useQueryClient();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const users = useQuery({
    queryKey: ['users', search],
    queryFn: () => api<{ users: { id: string; name: string; email: string }[] }>(`/users${qs({ q: search })}`),
    enabled: canManage && search.length >= 2,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.members(teamId) });
    qc.invalidateQueries({ queryKey: qk.teams });
  };
  const setRole = useMutation({
    mutationFn: ({ userId, role }: { userId: string; role: Role }) =>
      api(`/teams/${teamId}/members/${userId}`, { method: 'PUT', body: { role } }),
    onSuccess: () => {
      refresh();
      toast('Membership updated', 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });
  const remove = useMutation({
    mutationFn: (userId: string) => api(`/teams/${teamId}/members/${userId}`, { method: 'DELETE' }),
    onSuccess: () => {
      refresh();
      toast('Member removed', 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const memberIds = new Set(members.data?.members.map((m) => m.id));

  return (
    <Card
      title={`${teamName} members`}
      action={
        <Link to={`/items?team=${teamId}&active=true`} className="text-xs font-medium text-brand-600 hover:underline">
          View team work →
        </Link>
      }
    >
      {canManage && (
        <div className="border-b border-slate-100 p-4">
          <label className="label" htmlFor="add-member">
            Add a person
          </label>
          <input
            id="add-member"
            className="input"
            placeholder="Search by name or email…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {users.data && (
            <ul className="mt-2 divide-y divide-slate-100 rounded-md border border-slate-200">
              {users.data.users
                .filter((u) => !memberIds.has(u.id))
                .slice(0, 6)
                .map((u) => (
                  <li key={u.id} className="flex items-center justify-between px-3 py-2 text-sm">
                    <span>
                      {u.name} <span className="text-xs text-slate-500">{u.email}</span>
                    </span>
                    <Button
                      size="sm"
                      onClick={() =>
                        setRole.mutate({ userId: u.id, role: 'MEMBER' }, { onSuccess: () => setSearch('') })
                      }
                    >
                      Add as member
                    </Button>
                  </li>
                ))}
              {users.data.users.filter((u) => !memberIds.has(u.id)).length === 0 && (
                <li className="px-3 py-2 text-sm text-slate-500">No matching people outside this team.</li>
              )}
            </ul>
          )}
        </div>
      )}
      {members.isLoading ? (
        <div className="p-6 text-slate-400">
          <Spinner />
        </div>
      ) : members.data?.members.length === 0 ? (
        <EmptyState title="No members yet." />
      ) : (
        <ul className="divide-y divide-slate-100">
          {members.data?.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <Avatar name={m.name} size="md" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{m.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {m.email} · {m.openItems} active item{m.openItems === 1 ? '' : 's'}
                </p>
              </div>
              {canManage ? (
                <div className="flex items-center gap-2">
                  <select
                    className="input !w-auto !py-1"
                    value={m.role}
                    onChange={(e) => setRole.mutate({ userId: m.id, role: e.target.value as Role })}
                    aria-label={`Role for ${m.name}`}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>
                        {r.charAt(0) + r.slice(1).toLowerCase()}
                      </option>
                    ))}
                  </select>
                  <Button size="sm" variant="ghost" onClick={() => remove.mutate(m.id)}>
                    Remove
                  </Button>
                </div>
              ) : (
                <span className="text-right">
                  <span className="block text-xs font-semibold uppercase text-slate-600">{m.role}</span>
                  <span className="text-xs text-slate-400">{ROLE_HELP[m.role]}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

interface JobsResponse {
  stats: Record<string, number>;
  jobs: {
    id: number;
    type: string;
    attempts: number;
    lastError: string | null;
    createdAt: string;
    processedAt: string | null;
    payload: unknown;
  }[];
}

function JobsPanel() {
  const qc = useQueryClient();
  const toast = useToast();
  const jobs = useQuery({
    queryKey: ['jobs', 'DEAD'],
    queryFn: () => api<JobsResponse>('/admin/jobs?status=DEAD'),
    refetchInterval: 15_000,
  });
  const retry = useMutation({
    mutationFn: (id: number) => api(`/admin/jobs/${id}/retry`, { method: 'POST' }),
    onSuccess: () => {
      toast('Job re-queued', 'success');
      qc.invalidateQueries({ queryKey: ['jobs'] });
    },
  });
  const s = jobs.data?.stats ?? {};
  return (
    <Card
      title="Background jobs"
      action={
        <span className="text-xs text-slate-500">
          {s.PENDING ?? 0} pending · {s.DONE ?? 0} done ·{' '}
          <span className={s.DEAD ? 'font-semibold text-red-600' : ''}>{s.DEAD ?? 0} failed</span>
        </span>
      }
    >
      {jobs.data?.jobs.length ? (
        <ul className="divide-y divide-slate-100">
          {jobs.data.jobs.map((j) => (
            <li key={j.id} className="flex items-center gap-3 px-4 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  #{j.id} · {j.type}{' '}
                  <span className="text-xs font-normal text-slate-500">after {j.attempts} attempts</span>
                </p>
                <p className="truncate font-mono text-xs text-red-700">{j.lastError}</p>
                <p className="text-xs text-slate-400">created {relativeTime(j.createdAt)}</p>
              </div>
              <Button size="sm" loading={retry.isPending} onClick={() => retry.mutate(j.id)}>
                Retry
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState
          title="No failed jobs."
          hint="Jobs that fail 5 times are parked here for inspection instead of being lost."
        />
      )}
    </Card>
  );
}
