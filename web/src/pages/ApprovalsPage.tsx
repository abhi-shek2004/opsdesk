import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { invalidateLists, qk, useApprovals } from '../api/hooks';
import type { ApprovalEntry, ItemDetail } from '../api/types';
import { Button, Card, DueBadge, EmptyState, ErrorState, Modal, PriorityBadge, Spinner } from '../components/ui';
import { relativeTime, TYPE_LABEL } from '../lib/format';
import { useToast } from '../lib/toast';

function Row({ a, onReject }: { a: ApprovalEntry; onReject: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const approve = useMutation({
    mutationFn: () =>
      api<ItemDetail>(`/items/${a.item.id}/approval`, { method: 'POST', body: { decision: 'APPROVED' } }),
    onSuccess: (item) => {
      qc.setQueryData(qk.item(item.id), item);
      toast(`Approved ${a.item.key}`, 'success');
    },
    onError: (e: Error) => toast(e.message, 'error'),
    onSettled: () => invalidateLists(qc),
  });

  return (
    <li className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <PriorityBadge priority={a.item.priority} />
          <span className="font-mono text-xs text-slate-500">{a.item.key}</span>
          <Link to={`/items/${a.item.id}`} className="truncate font-medium hover:text-brand-700">
            {a.item.title}
          </Link>
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {a.item.team.name} · {TYPE_LABEL[a.item.type]} · requested by <b>{a.requestedBy.name}</b>{' '}
          {relativeTime(a.requestedAt)}
          {a.item.ownerName && a.item.ownerName !== a.requestedBy.name && <> · owner {a.item.ownerName}</>}
        </p>
        {a.note && <p className="mt-1 text-sm text-slate-700">“{a.note}”</p>}
        <div className="mt-1">
          <DueBadge dueAt={a.item.dueAt} status="PENDING_APPROVAL" />
        </div>
      </div>
      {a.canDecide ? (
        <div className="flex shrink-0 gap-2">
          <Button variant="success" size="sm" loading={approve.isPending} onClick={() => approve.mutate()}>
            Approve
          </Button>
          <Button variant="secondary" size="sm" disabled={approve.isPending} onClick={onReject}>
            Reject…
          </Button>
        </div>
      ) : (
        <span className="shrink-0 text-xs text-slate-400">
          You're involved in this item — another lead must decide.
        </span>
      )}
    </li>
  );
}

export function ApprovalsPage() {
  const { data, isLoading, error, refetch } = useApprovals();
  const [rejecting, setRejecting] = useState<ApprovalEntry | null>(null);
  const [reason, setReason] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const reject = useMutation({
    mutationFn: (a: ApprovalEntry) =>
      api<ItemDetail>(`/items/${a.item.id}/approval`, { method: 'POST', body: { decision: 'REJECTED', reason } }),
    onSuccess: (item) => {
      qc.setQueryData(qk.item(item.id), item);
      toast(`Rejected ${item.key}`, 'success');
      setRejecting(null);
      setReason('');
    },
    onError: (e: Error) => toast(e.message, 'error'),
    onSettled: () => invalidateLists(qc),
  });

  const mine = data?.approvals.filter((a) => a.canDecide) ?? [];
  const others = data?.approvals.filter((a) => !a.canDecide) ?? [];

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Approvals</h1>
        <p className="text-sm text-slate-500">Work in your teams waiting for a lead's sign-off, oldest first.</p>
      </div>
      {isLoading ? (
        <div className="flex justify-center p-12 text-slate-400">
          <Spinner />
        </div>
      ) : error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : (
        <>
          <Card title={`Waiting for you (${mine.length})`}>
            {mine.length ? (
              <ul className="divide-y divide-slate-100">
                {mine.map((a) => (
                  <Row key={a.item.id} a={a} onReject={() => setRejecting(a)} />
                ))}
              </ul>
            ) : (
              <EmptyState title="Nothing waiting on you." hint="New requests appear here and in your notifications." />
            )}
          </Card>
          {others.length > 0 && (
            <Card title={`Needs another lead (${others.length})`}>
              <ul className="divide-y divide-slate-100">
                {others.map((a) => (
                  <Row key={a.item.id} a={a} onReject={() => {}} />
                ))}
              </ul>
            </Card>
          )}
        </>
      )}
      <Modal
        open={!!rejecting}
        onClose={() => setRejecting(null)}
        title={`Reject ${rejecting?.item.key ?? ''}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!reason.trim()}
              loading={reject.isPending}
              onClick={() => rejecting && reject.mutate(rejecting)}
            >
              Reject
            </Button>
          </>
        }
      >
        <label className="label" htmlFor="reject-reason">
          Reason (the owner will see this)
        </label>
        <textarea
          id="reject-reason"
          className="input min-h-24"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </Modal>
    </div>
  );
}
