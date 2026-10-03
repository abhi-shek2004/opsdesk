import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router';
import { api } from '../api/client';
import { invalidateLists, qk } from '../api/hooks';
import type { Item, ItemDetail } from '../api/types';
import { relativeTime, TYPE_LABEL } from '../lib/format';
import { useToast } from '../lib/toast';
import { Avatar, Button, DueBadge, PriorityBadge, StatusBadge } from './ui';

export function ClaimButton({ item }: { item: Item }) {
  const qc = useQueryClient();
  const toast = useToast();
  const m = useMutation({
    mutationFn: () => api<ItemDetail>(`/items/${item.id}/claim`, { method: 'POST' }),
    onSuccess: (updated) => {
      qc.setQueryData(qk.item(item.id), updated);
      invalidateLists(qc);
      toast(`You now own ${item.key}`, 'success');
    },
    onError: (e: Error) => {
      toast(e.message, 'error');
      invalidateLists(qc); // someone else got it — show the real owner
    },
  });
  return (
    <Button
      size="sm"
      variant="primary"
      loading={m.isPending}
      onClick={(e) => {
        e.stopPropagation();
        m.mutate();
      }}
    >
      Claim
    </Button>
  );
}

export function ItemTable({ items, showTeam = true, compact = false }: { items: Item[]; showTeam?: boolean; compact?: boolean }) {
  const navigate = useNavigate();
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="sr-only sm:not-sr-only">
          {!compact && (
            <tr className="border-b border-slate-200 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
              <th className="w-10 px-4 py-2">Pri</th>
              <th className="px-2 py-2">Item</th>
              <th className="hidden px-2 py-2 md:table-cell">Status</th>
              <th className="hidden px-2 py-2 lg:table-cell">Owner</th>
              <th className="hidden px-2 py-2 lg:table-cell">Updated</th>
              <th className="px-4 py-2" />
            </tr>
          )}
        </thead>
        <tbody className="divide-y divide-slate-100">
          {items.map((item) => (
            <tr
              key={item.id}
              className="cursor-pointer hover:bg-slate-50"
              onClick={() => navigate(`/items/${item.id}`)}
            >
              <td className="px-4 py-2.5 align-top">
                <PriorityBadge priority={item.priority} />
              </td>
              <td className="w-full max-w-0 px-2 py-2.5 align-top">
                <div className="flex min-w-0 items-baseline gap-2">
                  <span className="shrink-0 font-mono text-xs text-slate-500">{item.key}</span>
                  <Link
                    to={`/items/${item.id}`}
                    className="truncate font-medium text-slate-900 hover:text-brand-700"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {item.title}
                  </Link>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-slate-500">
                  {showTeam && <span>{item.team.name}</span>}
                  {showTeam && <span aria-hidden>·</span>}
                  <span>{TYPE_LABEL[item.type]}</span>
                  <span className="md:hidden">
                    <StatusBadge status={item.status} />
                  </span>
                  <DueBadge dueAt={item.dueAt} status={item.status} />
                  {item.requiresApproval && !item.approvedAt && item.status !== 'CANCELLED' && (
                    <span className="rounded bg-amber-50 px-1.5 text-amber-700 ring-1 ring-amber-200 ring-inset">needs approval</span>
                  )}
                </div>
              </td>
              <td className="hidden px-2 py-2.5 align-top md:table-cell">
                <StatusBadge status={item.status} />
              </td>
              <td className="hidden px-2 py-2.5 align-top lg:table-cell">
                {item.owner ? (
                  <span className="flex items-center gap-1.5 whitespace-nowrap">
                    <Avatar name={item.owner.name} />
                    {item.owner.name}
                  </span>
                ) : (
                  <span className="text-slate-400">Unassigned</span>
                )}
              </td>
              <td className="hidden whitespace-nowrap px-2 py-2.5 align-top text-slate-500 lg:table-cell" title={item.updatedAt}>
                {relativeTime(item.updatedAt)}
              </td>
              <td className="px-4 py-2 text-right align-top">{item.permissions.claim && <ClaimButton item={item} />}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
