import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { api } from '../api/client';
import { qk, useNotifications } from '../api/hooks';
import type { NotificationEntry } from '../api/types';
import { relativeTime, STATUS_LABEL } from '../lib/format';

export function describeEvent(type: string, p: Record<string, any>, actor: string | null): string {
  const who = actor ?? 'System';
  switch (type) {
    case 'CREATED':
      return `${who} created this item`;
    case 'ASSIGNED':
      if (!p.to) return `${who} unassigned ${p.from?.name ?? 'the owner'}`;
      if (p.claimed) return `${who} took ownership`;
      return `${who} assigned it to ${p.to.name}`;
    case 'STATUS_CHANGED':
      return `${who} moved it ${p.from ? `from ${STATUS_LABEL[p.from as keyof typeof STATUS_LABEL]} ` : ''}to ${STATUS_LABEL[p.to as keyof typeof STATUS_LABEL] ?? p.to}`;
    case 'PRIORITY_CHANGED':
      return `${who} changed priority ${p.from} → ${p.to}`;
    case 'EDITED':
      return `${who} edited ${Object.keys(p.changes ?? {}).map(fieldLabel).join(', ')}`;
    case 'COMMENTED':
      return `${who} commented`;
    case 'APPROVAL_REQUESTED':
      return `${who} requested approval`;
    case 'APPROVAL_WITHDRAWN':
      return `${who} withdrew the approval request`;
    case 'APPROVED':
      return `${who} approved`;
    case 'REJECTED':
      return `${who} rejected the request`;
    case 'SLA_BREACHED':
      return 'Due date passed — item is overdue';
    default:
      return `${who} updated the item`;
  }
}

export function fieldLabel(f: string): string {
  return ({ dueAt: 'due date', requiresApproval: 'approval requirement' } as Record<string, string>)[f] ?? f;
}

export function NotificationBell() {
  const { data } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const qc = useQueryClient();

  const markRead = useMutation({
    mutationFn: (body: { ids?: number[]; all?: boolean }) => api('/notifications/read', { method: 'POST', body }),
    onMutate: (body) => {
      // Optimistic: the badge drops immediately.
      qc.setQueryData(qk.notifications, (old: typeof data) =>
        old && {
          unreadCount: body.all ? 0 : Math.max(0, old.unreadCount - (body.ids?.length ?? 0)),
          notifications: old.notifications.map((n) => (body.all || body.ids?.includes(n.id) ? { ...n, read: true } : n)),
        },
      );
    },
    onSettled: () => qc.invalidateQueries({ queryKey: qk.notifications }),
  });

  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  const unread = data?.unreadCount ?? 0;
  const go = (n: NotificationEntry) => {
    if (!n.read) markRead.mutate({ ids: [n.id] });
    setOpen(false);
    navigate(`/items/${n.item.id}`);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        className="relative rounded-md p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
        onClick={() => setOpen((o) => !o)}
        aria-label={`Notifications${unread ? ` (${unread} unread)` : ''}`}
      >
        <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 0 0 5.454-1.31A8.967 8.967 0 0 1 18 9.75V9A6 6 0 0 0 6 9v.75a8.967 8.967 0 0 1-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 0 1-5.714 0m5.714 0a3 3 0 1 1-5.714 0" />
        </svg>
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-red-600 px-1 text-center text-[10px] font-bold leading-4 text-white">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="animate-slide-in absolute right-0 z-40 mt-2 w-[min(24rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && (
              <button className="text-xs font-medium text-brand-600 hover:underline" onClick={() => markRead.mutate({ all: true })}>
                Mark all read
              </button>
            )}
          </div>
          <ul className="max-h-[60vh] divide-y divide-slate-100 overflow-y-auto">
            {data?.notifications.length === 0 && <li className="px-4 py-8 text-center text-sm text-slate-500">You're all caught up.</li>}
            {data?.notifications.map((n) => (
              <li key={n.id}>
                <button className={`flex w-full gap-3 px-4 py-3 text-left hover:bg-slate-50 ${n.read ? '' : 'bg-brand-50/50'}`} onClick={() => go(n)}>
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.read ? 'bg-transparent' : 'bg-brand-600'}`} />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-800">{describeEvent(n.type, n.payload, n.actorName)}</span>
                    <span className="block truncate text-xs text-slate-500">
                      <span className="font-mono">{n.item.key}</span> {n.item.title}
                    </span>
                    <span className="text-xs text-slate-400">{relativeTime(n.createdAt)}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
