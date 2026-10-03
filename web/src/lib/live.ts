import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { invalidateLists, qk } from '../api/hooks';
import type { ItemDetail } from '../api/types';

export interface ItemChange {
  itemId: string;
  version: number;
  actorId: string | null;
  event: string;
}

// Tiny pub/sub so pages can react to changes on the item they are showing.
const listeners = new Set<(c: ItemChange) => void>();
export function onItemChange(fn: (c: ItemChange) => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export type LiveStatus = 'connecting' | 'live' | 'offline';

/**
 * Subscribes to server-sent events and keeps the query cache fresh.
 *  - item changes: refetch that item if our cached version is older;
 *    lists/dashboard are refreshed at most every few seconds (not per event).
 *  - after a reconnect we may have missed events, so everything is refetched.
 */
export function useLiveUpdates(myId: string | undefined): LiveStatus {
  const qc = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>('connecting');

  useEffect(() => {
    if (!myId) return;
    let listsTimer: ReturnType<typeof setTimeout> | null = null;
    let wasDisconnected = false;
    const es = new EventSource('/api/events');

    const scheduleListRefresh = () => {
      if (listsTimer) return;
      listsTimer = setTimeout(() => {
        listsTimer = null;
        invalidateLists(qc);
      }, 3000);
    };

    es.addEventListener('ready', () => {
      setStatus('live');
      if (wasDisconnected) {
        qc.invalidateQueries();
        wasDisconnected = false;
      }
    });
    es.addEventListener('item', (e) => {
      const change = JSON.parse((e as MessageEvent).data) as ItemChange;
      const cached = qc.getQueryData<ItemDetail>(qk.item(change.itemId));
      if (
        cached &&
        (cached.version < change.version || change.event === 'COMMENTED' || change.event === 'SLA_BREACHED')
      ) {
        qc.invalidateQueries({ queryKey: qk.item(change.itemId) });
      }
      qc.invalidateQueries({ queryKey: qk.activity(change.itemId) });
      if (change.actorId !== myId) listeners.forEach((fn) => fn(change));
      scheduleListRefresh();
    });
    es.addEventListener('notification', () => qc.invalidateQueries({ queryKey: qk.notifications }));
    // An admin changed my team roles: what I can see and do may have changed everywhere.
    es.addEventListener('membership', () => qc.invalidateQueries());
    es.onerror = () => {
      setStatus('offline');
      wasDisconnected = true; // EventSource reconnects automatically
    };

    return () => {
      es.close();
      if (listsTimer) clearTimeout(listsTimer);
    };
  }, [myId, qc]);

  return status;
}
