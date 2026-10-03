import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useToast } from '../lib/toast';
import { api, ApiError, qs } from './client';
import type {
  ActivityEvent,
  ApprovalEntry,
  Dashboard,
  ItemDetail,
  ItemPage,
  Me,
  Member,
  NotificationEntry,
  Team,
} from './types';

export const qk = {
  me: ['me'] as const,
  dashboard: ['dashboard'] as const,
  items: (filters: Record<string, string>) => ['items', filters] as const,
  item: (id: string) => ['item', id] as const,
  activity: (id: string) => ['activity', id] as const,
  notifications: ['notifications'] as const,
  approvals: ['approvals'] as const,
  teams: ['teams'] as const,
  members: (teamId: string) => ['members', teamId] as const,
};

// ───────── Queries ─────────

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await api<Me>('/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 5 * 60_000,
  });
}

export function useDashboard() {
  return useQuery({ queryKey: qk.dashboard, queryFn: () => api<Dashboard>('/dashboard'), refetchInterval: 60_000 });
}

export function useItems(filters: Record<string, string>) {
  return useInfiniteQuery({
    queryKey: qk.items(filters),
    queryFn: ({ pageParam, signal }) =>
      api<ItemPage>(`/items${qs({ ...filters, cursor: pageParam, limit: 50 })}`, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData, // keep showing old results while new filters load
  });
}

export function useItem(id: string) {
  return useQuery({ queryKey: qk.item(id), queryFn: () => api<ItemDetail>(`/items/${id}`) });
}

export function useActivity(id: string) {
  return useInfiniteQuery({
    queryKey: qk.activity(id),
    queryFn: ({ pageParam }) =>
      api<{ events: ActivityEvent[]; nextCursor: number | null }>(
        `/items/${id}/activity${qs({ before: pageParam, limit: 50 })}`,
      ),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: qk.notifications,
    queryFn: () => api<{ unreadCount: number; notifications: NotificationEntry[] }>('/notifications?limit=20'),
    refetchInterval: 120_000,
  });
}

export function useApprovals(enabled = true) {
  return useQuery({
    queryKey: qk.approvals,
    queryFn: () => api<{ approvals: ApprovalEntry[] }>('/approvals'),
    enabled,
  });
}

export function useTeams() {
  return useQuery({ queryKey: qk.teams, queryFn: () => api<{ teams: Team[] }>('/teams'), staleTime: 60_000 });
}

export function useMembers(teamId: string | undefined) {
  return useQuery({
    queryKey: qk.members(teamId ?? ''),
    queryFn: () => api<{ members: Member[] }>(`/teams/${teamId}/members`),
    enabled: !!teamId,
    staleTime: 60_000,
  });
}

/**
 * Switch the signed-in user. Drops every cached query except `me` (clearing the whole
 * cache would detach the mounted `me` observer), then sets the new identity.
 */
export function setSession(qc: QueryClient, me: Me | null) {
  qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });
  qc.setQueryData(qk.me, me);
}

// ───────── Mutations ─────────

/** Mark every list-like view stale (they refetch when next shown / immediately if visible). */
export function invalidateLists(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ['items'] });
  qc.invalidateQueries({ queryKey: qk.dashboard });
  qc.invalidateQueries({ queryKey: qk.approvals });
}

export interface ItemMutationOptions<V> {
  request: (vars: V) => Promise<ItemDetail>;
  /** Apply the expected result to the cache immediately; rolled back on failure. */
  optimistic?: (item: ItemDetail, vars: V) => ItemDetail;
  /** Called when the server reports our copy was stale; the cache already holds the server's version. */
  onConflict?: (err: ApiError, vars: V) => void;
  successMessage?: string | ((item: ItemDetail) => string);
}

/**
 * Wraps every item write with the same reconciliation policy:
 *  optimistic apply → server decides → on success replace with the server's item,
 *  on failure roll back and explain; on VERSION_CONFLICT adopt the server's
 *  current copy and let the caller offer "reapply my change".
 */
export function useItemMutation<V>(itemId: string, opts: ItemMutationOptions<V>) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: opts.request,
    onMutate: async (vars: V) => {
      await qc.cancelQueries({ queryKey: qk.item(itemId) });
      const previous = qc.getQueryData<ItemDetail>(qk.item(itemId));
      if (previous && opts.optimistic) qc.setQueryData(qk.item(itemId), opts.optimistic(previous, vars));
      return { previous };
    },
    onError: (err, vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(qk.item(itemId), ctx.previous);
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT' && err.details?.current) {
        qc.setQueryData(qk.item(itemId), err.details.current);
        qc.invalidateQueries({ queryKey: qk.activity(itemId) });
        if (opts.onConflict) return opts.onConflict(err, vars);
      }
      if (err instanceof ApiError && ['ALREADY_CLAIMED', 'NOT_PENDING_APPROVAL'].includes(err.code)) {
        qc.invalidateQueries({ queryKey: qk.item(itemId) });
        qc.invalidateQueries({ queryKey: qk.activity(itemId) });
      }
      toast(err instanceof Error ? err.message : 'Something went wrong', 'error');
    },
    onSuccess: (item) => {
      qc.setQueryData(qk.item(itemId), item);
      qc.invalidateQueries({ queryKey: qk.activity(itemId) });
      invalidateLists(qc);
      if (opts.successMessage) {
        toast(typeof opts.successMessage === 'function' ? opts.successMessage(item) : opts.successMessage, 'success');
      }
    },
  });
}
