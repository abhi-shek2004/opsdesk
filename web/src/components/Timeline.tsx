import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api, newIdempotencyKey } from '../api/client';
import { qk, useActivity } from '../api/hooks';
import type { ActivityEvent } from '../api/types';
import { fullDate, PRIORITY_LABEL, relativeTime } from '../lib/format';
import { useToast } from '../lib/toast';
import { describeEvent, fieldLabel } from './NotificationBell';
import { Avatar, Button, Spinner } from './ui';

const ICON: Record<string, string> = {
  CREATED: '✦',
  ASSIGNED: '👤',
  STATUS_CHANGED: '⇄',
  PRIORITY_CHANGED: '⚑',
  EDITED: '✎',
  APPROVAL_REQUESTED: '✋',
  APPROVAL_WITHDRAWN: '↩',
  APPROVED: '✔',
  REJECTED: '✖',
  SLA_BREACHED: '⏰',
};

function formatValue(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'dueAt') return fullDate(String(v));
  if (field === 'requiresApproval') return v ? 'required' : 'not required';
  return String(v);
}

function EventRow({ e }: { e: ActivityEvent }) {
  const p = e.payload;
  return (
    <li className="relative flex gap-3 pb-4 pl-1">
      <span
        className={`z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11px] ring-4 ring-white ${
          e.type === 'APPROVED'
            ? 'bg-emerald-100 text-emerald-700'
            : e.type === 'REJECTED' || e.type === 'SLA_BREACHED'
              ? 'bg-red-100 text-red-700'
              : e.type === 'APPROVAL_REQUESTED'
                ? 'bg-amber-100 text-amber-700'
                : 'bg-slate-100 text-slate-500'
        }`}
        aria-hidden
      >
        {ICON[e.type] ?? '•'}
      </span>
      <div className="min-w-0 pt-0.5 text-sm">
        <p className="text-slate-700">
          {describeEvent(e.type, p, e.actor?.name ?? null)}
          <span className="ml-2 text-xs text-slate-400" title={fullDate(e.createdAt)}>
            {relativeTime(e.createdAt)}
          </span>
        </p>
        {e.type === 'PRIORITY_CHANGED' && (
          <p className="text-xs text-slate-500">
            {PRIORITY_LABEL[p.from as keyof typeof PRIORITY_LABEL]} → {PRIORITY_LABEL[p.to as keyof typeof PRIORITY_LABEL]}
          </p>
        )}
        {e.type === 'EDITED' && p.changes && (
          <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
            {Object.entries(p.changes as Record<string, { from: unknown; to: unknown }>).map(([field, ch]) => (
              <li key={field} className="truncate">
                <span className="font-medium">{fieldLabel(field)}:</span>{' '}
                {field === 'description' ? 'updated' : (
                  <>
                    <span className="line-through">{formatValue(field, ch.from)}</span> → {formatValue(field, ch.to)}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        {(p.reason || p.resolution) && (
          <blockquote className="mt-1 border-l-2 border-slate-200 pl-2 text-xs text-slate-600">
            {p.resolution ? `Resolution: ${p.resolution}` : `“${p.reason}”`}
          </blockquote>
        )}
        {p.approvalCleared && <p className="text-xs text-amber-700">Previous approval revoked — must be re-approved.</p>}
      </div>
    </li>
  );
}

function CommentRow({ e }: { e: ActivityEvent }) {
  return (
    <li className="relative flex gap-3 pb-4">
      <span className="z-10 ring-4 ring-white rounded-full">
        <Avatar name={e.actor?.name ?? 'System'} />
      </span>
      <div className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 bg-slate-50 px-3 py-1.5 text-xs rounded-t-lg">
          <span className="font-medium text-slate-800">{e.actor?.name}</span>
          <span className="text-slate-400" title={fullDate(e.createdAt)}>
            {relativeTime(e.createdAt)}
          </span>
        </div>
        <p className="whitespace-pre-wrap break-words px-3 py-2 text-sm text-slate-800">{e.payload.body}</p>
      </div>
    </li>
  );
}

export function Timeline({ itemId, canComment }: { itemId: string; canComment: boolean }) {
  const activity = useActivity(itemId);
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const key = useRef(newIdempotencyKey());

  const comment = useMutation({
    mutationFn: (text: string) =>
      api<ActivityEvent>(`/items/${itemId}/comments`, { method: 'POST', body: { body: text }, idempotencyKey: key.current }),
    onSuccess: () => {
      setBody('');
      key.current = newIdempotencyKey(); // next comment is a new intent
      qc.invalidateQueries({ queryKey: qk.activity(itemId) });
    },
    // The key is kept on failure so a retry cannot post the comment twice.
    onError: (e: Error) => toast(e.message, 'error'),
  });

  // Newest first from the API; show oldest → newest like a conversation.
  const events = (activity.data?.pages.flatMap((p) => p.events) ?? []).slice().reverse();

  return (
    <section aria-label="Activity">
      <h2 className="mb-3 text-sm font-semibold text-slate-800">Activity</h2>
      {activity.hasNextPage && (
        <button className="mb-3 text-xs font-medium text-brand-600 hover:underline" onClick={() => activity.fetchNextPage()}>
          {activity.isFetchingNextPage ? 'Loading…' : 'Show earlier activity'}
        </button>
      )}
      {activity.isLoading ? (
        <Spinner className="h-5 w-5 text-slate-400" />
      ) : (
        <ol className="relative before:absolute before:bottom-4 before:left-[15px] before:top-1 before:w-px before:bg-slate-200">
          {events.map((e) => (e.type === 'COMMENTED' ? <CommentRow key={e.id} e={e} /> : <EventRow key={e.id} e={e} />))}
        </ol>
      )}
      {canComment && (
        <form
          className="mt-2 rounded-lg border border-slate-200 bg-white p-3 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-100"
          onSubmit={(e) => {
            e.preventDefault();
            if (body.trim() && !comment.isPending) comment.mutate(body);
          }}
        >
          <textarea
            className="w-full resize-y border-0 p-0 text-sm focus:outline-none focus:ring-0"
            rows={3}
            placeholder="Add a comment… (⌘/Ctrl + Enter to send)"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim() && !comment.isPending) comment.mutate(body);
            }}
            aria-label="Comment"
          />
          <div className="flex justify-end">
            <Button variant="primary" size="sm" type="submit" disabled={!body.trim()} loading={comment.isPending}>
              Comment
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}

