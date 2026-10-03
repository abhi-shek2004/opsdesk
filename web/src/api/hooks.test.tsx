// @vitest-environment jsdom
/**
 * Reconciling optimistic UI with server decisions: when the server rejects a
 * write, the screen must not keep showing a change that never happened.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { qk, useItemMutation } from './hooks';
import type { ItemDetail } from './types';

const base = { id: 'i1', key: 'PAY-1', priority: 'P3', title: 'Original', version: 3 } as unknown as ItemDetail;

function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(qk.item('i1'), base);
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  return { qc, wrapper };
}

function respond(status: number, body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe('useItemMutation', () => {
  it('shows the change immediately, then adopts the server result', async () => {
    const { qc, wrapper } = setup();
    let release!: () => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise<Response>((r) => (release = () => r(new Response(JSON.stringify({ ...base, priority: 'P1', version: 4 }), { status: 200 }))))),
    );
    const { result } = renderHook(
      () =>
        useItemMutation<{ priority: string }>('i1', {
          request: (v) => api(`/items/i1`, { method: 'PATCH', body: { version: 3, ...v } }),
          optimistic: (cur, v) => ({ ...cur, ...(v as Partial<ItemDetail>) }),
        }),
      { wrapper },
    );
    act(() => result.current.mutate({ priority: 'P1' }));
    await waitFor(() => expect(qc.getQueryData<ItemDetail>(qk.item('i1'))?.priority).toBe('P1'));
    expect(qc.getQueryData<ItemDetail>(qk.item('i1'))?.version).toBe(3); // still optimistic
    release();
    await waitFor(() => expect(qc.getQueryData<ItemDetail>(qk.item('i1'))?.version).toBe(4));
  });

  it('rolls back when the server refuses (403)', async () => {
    const { qc, wrapper } = setup();
    respond(403, { error: { code: 'FORBIDDEN', message: 'No' } });
    const { result } = renderHook(
      () =>
        useItemMutation<{ priority: string }>('i1', {
          request: (v) => api(`/items/i1`, { method: 'PATCH', body: v }),
          optimistic: (cur, v) => ({ ...cur, ...(v as Partial<ItemDetail>) }),
        }),
      { wrapper },
    );
    act(() => result.current.mutate({ priority: 'P1' }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(qc.getQueryData<ItemDetail>(qk.item('i1'))?.priority).toBe('P3');
  });

  it('on VERSION_CONFLICT adopts the server copy and hands the user their change back', async () => {
    const { qc, wrapper } = setup();
    const theirs = { ...base, title: 'Changed by Priya', version: 4 };
    respond(409, { error: { code: 'VERSION_CONFLICT', message: 'Conflict', details: { current: theirs } } });
    const onConflict = vi.fn();
    const { result } = renderHook(
      () =>
        useItemMutation<{ title: string }>('i1', {
          request: (v) => api(`/items/i1`, { method: 'PATCH', body: { version: 3, ...v } }),
          optimistic: (cur, v) => ({ ...cur, ...v }),
          onConflict,
        }),
      { wrapper },
    );
    act(() => result.current.mutate({ title: 'Mine' }));
    await waitFor(() => expect(onConflict).toHaveBeenCalled());
    expect(onConflict.mock.calls[0][1]).toEqual({ title: 'Mine' });
    expect(qc.getQueryData<ItemDetail>(qk.item('i1'))).toMatchObject({ title: 'Changed by Priya', version: 4 });
  });
});
