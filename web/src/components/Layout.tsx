import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { api } from '../api/client';
import { setSession, useApprovals, useMe } from '../api/hooks';
import { useLiveUpdates } from '../lib/live';
import { CreateItemModal } from './CreateItemModal';
import { NotificationBell } from './NotificationBell';
import { Avatar, Button } from './ui';

function NavItem({ to, children, badge }: { to: string; children: ReactNode; badge?: number }) {
  const location = useLocation();
  const [path, search] = to.split('?');
  // Compare the query string too: several entries are the same page with different filters.
  const active =
    location.pathname === path &&
    (search === undefined ? path !== '/items' || !location.search : sameParams(location.search, search));
  return (
    <Link
      to={to}
      aria-current={active ? 'page' : undefined}
      className={`flex items-center justify-between rounded-md px-3 py-1.5 text-sm ${
        active ? 'bg-white font-medium text-slate-900 shadow-xs ring-1 ring-slate-200' : 'text-slate-600 hover:bg-slate-200/60'
      }`}
    >
      <span>{children}</span>
      {!!badge && <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold text-white">{badge}</span>}
    </Link>
  );
}

function sameParams(a: string, b: string) {
  const norm = (s: string) => [...new URLSearchParams(s)].sort(([x], [y]) => x.localeCompare(y)).join('&');
  return norm(a) === norm(b);
}

export function Layout() {
  const { data: me } = useMe();
  const live = useLiveUpdates(me?.id);
  const isLead = !!me && (me.isAdmin || me.teams.some((t) => t.role === 'LEAD'));
  const approvals = useApprovals(isLead);
  const pendingForMe = approvals.data?.approvals.filter((a) => a.canDecide).length ?? 0;
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [params] = useSearchParams();
  const [search, setSearch] = useState(params.get('q') ?? '');
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();

  useEffect(() => setMenuOpen(false), [location.pathname, location.search]);

  // Keyboard shortcuts: "c" to create, "/" to search.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.metaKey || e.ctrlKey) return;
      if (e.key === 'c') {
        e.preventDefault();
        setCreating(true);
      }
      if (e.key === '/') {
        e.preventDefault();
        document.getElementById('global-search')?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => {});
    setSession(qc, null);
    navigate('/login');
  };

  if (!me) return null;
  const teamFromUrl = location.pathname === '/items' ? (params.get('team') ?? undefined) : undefined;

  const sidebar = (
    <nav className="flex h-full flex-col gap-6 p-3">
      <div className="flex items-center gap-2 px-2 pt-1">
        <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-600 text-white">
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
            <path d="M5 12.5l4.5 4.5L19 7.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
        <span className="font-semibold tracking-tight">OpsDesk</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <NavItem to="/">Dashboard</NavItem>
        <NavItem to="/items?owner=me&active=true">My work</NavItem>
        <NavItem to="/items?active=true">All active work</NavItem>
        <NavItem to="/items?owner=none&active=true&sort=priority">Unassigned</NavItem>
        <NavItem to="/items?watching=true">Watching</NavItem>
        {isLead && (
          <NavItem to="/approvals" badge={pendingForMe}>
            Approvals
          </NavItem>
        )}
        <NavItem to="/teams">Teams{me.isAdmin ? ' & admin' : ''}</NavItem>
      </div>
      <div>
        <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Teams</p>
        <div className="flex flex-col gap-0.5">
          {me.teams.map((t) => (
            <NavLink
              key={t.id}
              to={`/items?team=${t.id}&active=true`}
              className={`flex items-center justify-between rounded-md px-3 py-1.5 text-sm hover:bg-slate-200/60 ${
                teamFromUrl === t.id ? 'font-medium text-slate-900' : 'text-slate-600'
              }`}
            >
              <span className="truncate">{t.name}</span>
              <span className="text-[10px] font-medium uppercase text-slate-400">{t.role?.toLowerCase() ?? 'admin'}</span>
            </NavLink>
          ))}
        </div>
      </div>
      <div className="mt-auto flex items-center gap-2 rounded-md px-2 py-2">
        <Avatar name={me.name} size="md" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">{me.name}</p>
          <p className="truncate text-xs text-slate-500">{me.isAdmin ? 'Administrator' : me.email}</p>
        </div>
        <button onClick={logout} className="rounded p-1.5 text-xs text-slate-500 hover:bg-slate-200" title="Sign out">
          Sign out
        </button>
      </div>
    </nav>
  );

  return (
    <div className="flex h-full">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-slate-100/70 md:block">{sidebar}</aside>
      {menuOpen && (
        <div className="fixed inset-0 z-40 md:hidden" onClick={() => setMenuOpen(false)}>
          <div className="absolute inset-0 bg-slate-900/30" />
          <aside className="absolute inset-y-0 left-0 w-64 bg-slate-100 shadow-xl" onClick={(e) => e.stopPropagation()}>
            {sidebar}
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-2 border-b border-slate-200 bg-white/90 px-4 py-2.5 backdrop-blur">
          <button className="rounded p-1.5 text-slate-600 hover:bg-slate-100 md:hidden" onClick={() => setMenuOpen(true)} aria-label="Open menu">
            ☰
          </button>
          <form
            className="max-w-md flex-1"
            onSubmit={(e) => {
              e.preventDefault();
              const q = search.trim();
              navigate(q ? `/items?q=${encodeURIComponent(q)}` : '/items?active=true');
            }}
          >
            <input
              id="global-search"
              type="search"
              className="input !py-1.5"
              placeholder="Search by title, description or key (e.g. PAY-12)…  /"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </form>
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <span
              className={`hidden items-center gap-1.5 text-xs sm:flex ${live === 'live' ? 'text-emerald-600' : 'text-slate-400'}`}
              title={live === 'live' ? 'Receiving live updates' : 'Reconnecting… data may be stale'}
            >
              <span className={`h-2 w-2 rounded-full ${live === 'live' ? 'bg-emerald-500' : 'animate-pulse bg-amber-400'}`} />
              {live === 'live' ? 'Live' : 'Reconnecting'}
            </span>
            <NotificationBell />
            <Button variant="primary" onClick={() => setCreating(true)} title="New item (c)">
              <span aria-hidden>＋</span>
              <span className="hidden sm:inline">New item</span>
            </Button>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
      <CreateItemModal open={creating} onClose={() => setCreating(false)} defaultTeamId={teamFromUrl} />
    </div>
  );
}
