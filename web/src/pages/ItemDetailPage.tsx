import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { api, ApiError } from '../api/client';
import { useItem, useItemMutation, useMe, useMembers } from '../api/hooks';
import { PRIORITIES, type ItemDetail, type Priority, type Status } from '../api/types';
import { Timeline } from '../components/Timeline';
import { Avatar, Button, Card, DueBadge, ErrorState, Modal, PriorityBadge, Spinner, StatusBadge } from '../components/ui';
import { fromLocalInput, fullDate, PRIORITY_LABEL, relativeTime, STATUS_LABEL, toLocalInput, transitionVerb, TYPE_LABEL } from '../lib/format';
import { onItemChange } from '../lib/live';
import { nextStep } from '../lib/nextStep';

type Patch = Partial<Pick<ItemDetail, 'title' | 'description' | 'priority' | 'requiresApproval'>> & { dueAt?: string | null };

interface ConflictState {
  patch: Patch;
  theirs: ItemDetail;
  lastChange?: { actor_name: string | null; type: string; created_at: string } | null;
}

export function ItemDetailPage() {
  const { id = '' } = useParams();
  const { data: me } = useMe();
  const { data: item, error, isLoading, refetch } = useItem(id);
  const members = useMembers(item?.team.id);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [transition, setTransition] = useState<Status | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [liveNotice, setLiveNotice] = useState<string | null>(null);

  // Tell the user when someone else changes this item while they're looking at it.
  useEffect(
    () =>
      onItemChange((c) => {
        if (c.itemId !== id) return;
        const who = members.data?.members.find((m) => m.id === c.actorId)?.name ?? (c.actorId ? 'Someone' : 'The system');
        setLiveNotice(`${who} just ${c.event === 'COMMENTED' ? 'commented' : 'updated this item'} — you're seeing the latest version.`);
      }),
    [id, members.data],
  );
  useEffect(() => {
    if (!liveNotice) return;
    const t = setTimeout(() => setLiveNotice(null), 8000);
    return () => clearTimeout(t);
  }, [liveNotice]);

  // ── Writes (all go through the same optimistic/conflict policy) ──
  const edit = useItemMutation<{ version: number; patch: Patch }>(id, {
    request: ({ version, patch }) => api(`/items/${id}`, { method: 'PATCH', body: { version, ...patch } }),
    optimistic: (cur, { patch }) => ({ ...cur, ...patch }),
    onConflict: (err, { patch }) =>
      setConflict({ patch, theirs: err.details.current, lastChange: err.details.lastChange }),
  });
  const claim = useItemMutation<void>(id, {
    request: () => api(`/items/${id}/claim`, { method: 'POST' }),
    optimistic: (cur) => ({
      ...cur,
      owner: me ? { id: me.id, name: me.name } : cur.owner,
      status: cur.status === 'OPEN' ? 'IN_PROGRESS' : cur.status,
      permissions: { ...cur.permissions, claim: false },
    }),
    successMessage: (i) => `You now own ${i.key}`,
  });
  const assign = useItemMutation<{ userId: string | null; version: number }>(id, {
    request: (body) => api(`/items/${id}/assign`, { method: 'POST', body }),
    onConflict: () => setConflict(null),
    successMessage: (i) => (i.owner ? `Assigned to ${i.owner.name}` : 'Unassigned'),
  });
  const move = useItemMutation<{ to: Status; version: number; reason?: string; resolution?: string }>(id, {
    request: (body) => api(`/items/${id}/transition`, { method: 'POST', body }),
    successMessage: (i) => `${i.key} is now ${STATUS_LABEL[i.status].toLowerCase()}`,
  });
  const decide = useItemMutation<{ decision: 'APPROVED' | 'REJECTED'; reason?: string }>(id, {
    request: (body) => api(`/items/${id}/approval`, { method: 'POST', body }),
    successMessage: (i) => (i.approvedAt ? 'Approved' : 'Rejected — sent back to the owner'),
  });
  const watch = useItemMutation<boolean>(id, {
    request: async (on) => {
      await api(`/items/${id}/watch`, { method: on ? 'PUT' : 'DELETE' });
      return api<ItemDetail>(`/items/${id}`);
    },
    optimistic: (cur, on) => ({ ...cur, watching: on, watcherCount: cur.watcherCount + (on ? 1 : -1) }),
  });

  if (isLoading) {
    return (
      <div className="flex justify-center p-16 text-slate-400">
        <Spinner />
      </div>
    );
  }
  if (error instanceof ApiError && error.status === 404) {
    return (
      <div className="mx-auto max-w-lg p-10 text-center">
        <h1 className="text-lg font-semibold">Item not found</h1>
        <p className="mt-1 text-sm text-slate-500">It doesn't exist or you don't have access to its team.</p>
        <Link to="/items?active=true" className="mt-4 inline-block text-sm font-medium text-brand-600 hover:underline">
          Back to work items
        </Link>
      </div>
    );
  }
  if (error || !item) return <ErrorState error={error} onRetry={refetch} />;

  const p = item.permissions;
  const step = nextStep(item, me?.id);
  const save = (patch: Patch, version = item.version) => edit.mutate({ version, patch });
  const busy = edit.isPending || claim.isPending || assign.isPending || move.isPending || decide.isPending;
  const assignable = (members.data?.members ?? []).filter((m) => m.role !== 'VIEWER');

  const runTransition = (to: Status) => {
    const needsInput = to === 'BLOCKED' || to === 'CANCELLED' || to === 'RESOLVED' || (item.status === 'RESOLVED' && to === 'IN_PROGRESS') || to === 'PENDING_APPROVAL';
    if (needsInput) setTransition(to);
    else move.mutate({ to, version: item.version });
  };

  return (
    <div className="mx-auto max-w-7xl p-4 sm:p-6">
      <nav className="mb-3 flex items-center gap-1.5 text-xs text-slate-500">
        <Link to={`/items?team=${item.team.id}&active=true`} className="hover:text-slate-800">
          {item.team.name}
        </Link>
        <span>/</span>
        <span className="font-mono">{item.key}</span>
      </nav>

      {liveNotice && (
        <div className="animate-slide-in mb-4 flex items-center justify-between gap-3 rounded-md border border-blue-200 bg-blue-50 px-4 py-2 text-sm text-blue-800" role="status">
          <span>{liveNotice}</span>
          <button className="text-blue-600 hover:text-blue-900" onClick={() => setLiveNotice(null)} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        {/* ── Main column ── */}
        <div className="min-w-0 space-y-6">
          <div>
            <EditableTitle item={item} canEdit={p.edit} onSave={(title, version) => save({ title }, version)} />
            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              <StatusBadge status={item.status} />
              <PriorityBadge priority={item.priority} />
              <span className="text-slate-500">{TYPE_LABEL[item.type]}</span>
              <DueBadge dueAt={item.dueAt} status={item.status} />
              {item.slaBreachedAt && !['RESOLVED', 'CLOSED', 'CANCELLED'].includes(item.status) && (
                <span className="rounded-full bg-red-600 px-2 py-0.5 text-xs font-medium text-white">SLA breached</span>
              )}
            </div>
          </div>

          {step && (
            <div
              className={`flex items-start gap-2 rounded-lg border px-4 py-3 text-sm ${
                {
                  action: 'border-brand-100 bg-brand-50 text-brand-700',
                  waiting: 'border-slate-200 bg-white text-slate-600',
                  warning: 'border-red-200 bg-red-50 text-red-800',
                  done: 'border-emerald-200 bg-emerald-50 text-emerald-800',
                }[step.tone]
              }`}
              role="status"
            >
              <span className="font-semibold">Next:</span>
              <span>{step.text}</span>
            </div>
          )}

          {item.status === 'PENDING_APPROVAL' && item.pendingApproval && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
              <p className="text-sm font-medium text-amber-900">
                Waiting for approval · requested by {item.pendingApproval.requestedBy.name} {relativeTime(item.pendingApproval.requestedAt)}
              </p>
              {item.pendingApproval.note && <p className="mt-1 text-sm text-amber-800">“{item.pendingApproval.note}”</p>}
              {p.decideApproval ? (
                <div className="mt-3 flex gap-2">
                  <Button variant="success" loading={decide.isPending} onClick={() => decide.mutate({ decision: 'APPROVED' })}>
                    Approve
                  </Button>
                  <Button variant="danger" disabled={decide.isPending} onClick={() => setRejecting(true)}>
                    Reject…
                  </Button>
                </div>
              ) : (
                <p className="mt-2 text-xs text-amber-700">
                  A team lead who is not the owner, creator or requester must decide.
                </p>
              )}
            </div>
          )}

          {item.resolution && (
            <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 text-sm">
              <p className="font-medium text-emerald-900">Resolution</p>
              <p className="mt-1 whitespace-pre-wrap text-emerald-800">{item.resolution}</p>
            </div>
          )}

          <EditableDescription item={item} canEdit={p.edit} onSave={(description, version) => save({ description }, version)} />
          <Timeline itemId={item.id} canComment={p.comment} />
        </div>

        {/* ── Side panel ── */}
        <aside className="space-y-4">
          <Card>
            <div className="space-y-4 p-4">
              <div>
                <p className="label">Status</p>
                <StatusBadge status={item.status} />
                {p.transitions.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {p.transitions.map((to) => (
                      <Button
                        key={to}
                        size="sm"
                        variant={to === 'CANCELLED' ? 'ghost' : to === 'RESOLVED' ? 'success' : 'secondary'}
                        disabled={busy}
                        onClick={() => runTransition(to)}
                      >
                        {transitionVerb(item.status, to)}
                      </Button>
                    ))}
                  </div>
                )}
                {item.requiresApproval && !item.approvedAt && item.status === 'IN_PROGRESS' && (
                  <p className="mt-2 text-xs text-amber-700">Needs approval before it can be resolved.</p>
                )}
              </div>

              <div>
                <p className="label">Owner</p>
                {item.owner ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Avatar name={item.owner.name} />
                    <span className="font-medium">{item.owner.name}</span>
                    {item.owner.id === me?.id && <span className="text-xs text-slate-400">(you)</span>}
                  </div>
                ) : (
                  <p className="text-sm text-slate-400">Unassigned</p>
                )}
                <div className="mt-2 flex flex-wrap gap-2">
                  {p.claim && (
                    <Button size="sm" variant="primary" loading={claim.isPending} onClick={() => claim.mutate()}>
                      Claim it
                    </Button>
                  )}
                  {p.unassign && item.owner?.id === me?.id && (
                    <Button size="sm" disabled={busy} onClick={() => assign.mutate({ userId: null, version: item.version })}>
                      Release
                    </Button>
                  )}
                </div>
                {p.assign && (
                  <select
                    className="input mt-2 !py-1.5"
                    value=""
                    disabled={busy}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v) assign.mutate({ userId: v === '__none' ? null : v, version: item.version });
                    }}
                    aria-label="Assign to"
                  >
                    <option value="">Assign to…</option>
                    {item.owner && p.unassign && <option value="__none">— Unassign</option>}
                    {assignable
                      .filter((m) => m.id !== item.owner?.id)
                      .map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name} · {m.openItems} open
                        </option>
                      ))}
                  </select>
                )}
              </div>

              <div>
                <label className="label" htmlFor="priority">Priority</label>
                {p.edit ? (
                  <select
                    id="priority"
                    className="input !py-1.5"
                    value={item.priority}
                    disabled={edit.isPending}
                    onChange={(e) => save({ priority: e.target.value as Priority })}
                  >
                    {PRIORITIES.map((pr) => (
                      <option key={pr} value={pr}>
                        {PRIORITY_LABEL[pr]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <p className="text-sm">{PRIORITY_LABEL[item.priority]}</p>
                )}
              </div>

              <div>
                <label className="label" htmlFor="due">Due</label>
                {p.edit ? (
                  <input
                    id="due"
                    type="datetime-local"
                    className="input !py-1.5"
                    defaultValue={toLocalInput(item.dueAt)}
                    key={item.dueAt ?? 'none'}
                    onBlur={(e) => {
                      const next = fromLocalInput(e.target.value);
                      if ((next ?? null) !== (item.dueAt ? new Date(item.dueAt).toISOString() : null)) save({ dueAt: next });
                    }}
                  />
                ) : (
                  <p className="text-sm">{item.dueAt ? fullDate(item.dueAt) : '—'}</p>
                )}
              </div>

              <div>
                <p className="label">Approval</p>
                {p.changeApprovalRequirement ? (
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={item.requiresApproval}
                      disabled={edit.isPending || item.status === 'PENDING_APPROVAL'}
                      onChange={(e) => save({ requiresApproval: e.target.checked })}
                    />
                    Requires lead approval
                  </label>
                ) : (
                  <p className="text-sm">{item.requiresApproval ? 'Requires lead approval' : 'Not required'}</p>
                )}
                {item.approvedBy && (
                  <p className="mt-1 text-xs text-emerald-700">
                    ✔ Approved by {item.approvedBy.name} {item.approvedAt && relativeTime(item.approvedAt)}
                  </p>
                )}
              </div>
            </div>
          </Card>

          <Card>
            <dl className="space-y-2 p-4 text-sm">
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Team</dt>
                <dd>{item.team.name}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Created by</dt>
                <dd>{item.createdBy.name}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Created</dt>
                <dd title={fullDate(item.createdAt)}>{relativeTime(item.createdAt)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-slate-500">Updated</dt>
                <dd title={fullDate(item.updatedAt)}>{relativeTime(item.updatedAt)}</dd>
              </div>
              <div className="flex items-center justify-between gap-2 border-t border-slate-100 pt-3">
                <dt className="text-slate-500">
                  {item.watcherCount} watcher{item.watcherCount === 1 ? '' : 's'}
                </dt>
                <dd>
                  <Button size="sm" variant={item.watching ? 'secondary' : 'ghost'} onClick={() => watch.mutate(!item.watching)}>
                    {item.watching ? '👁 Watching' : 'Watch'}
                  </Button>
                </dd>
              </div>
            </dl>
          </Card>
          <p className="px-1 text-xs text-slate-400">Version {item.version}</p>
        </aside>
      </div>

      <TransitionDialog
        item={item}
        to={transition}
        onClose={() => setTransition(null)}
        pending={move.isPending}
        onSubmit={(input) =>
          move.mutate({ to: transition!, version: item.version, ...input }, { onSuccess: () => setTransition(null) })
        }
      />

      <ReasonDialog
        open={rejecting}
        title="Reject approval request"
        label="Why is this being rejected? The owner will see this."
        confirm="Reject"
        pending={decide.isPending}
        onClose={() => setRejecting(false)}
        onSubmit={(reason) => decide.mutate({ decision: 'REJECTED', reason }, { onSuccess: () => setRejecting(false) })}
      />

      {conflict && (
        <ConflictDialog
          conflict={conflict}
          onDiscard={() => setConflict(null)}
          onReapply={() => {
            save(conflict.patch, conflict.theirs.version);
            setConflict(null);
          }}
        />
      )}
    </div>
  );
}

// ───────────────────────── Sub-components ─────────────────────────

function EditableTitle({ item, canEdit, onSave }: { item: ItemDetail; canEdit: boolean; onSave: (title: string, version: number) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.title);
  // Remember which version the user started editing from, so a concurrent change is detected.
  const [baseVersion, setBaseVersion] = useState(item.version);

  if (!editing) {
    return (
      <h1
        className={`text-2xl font-semibold tracking-tight text-slate-900 ${canEdit ? 'cursor-text rounded hover:bg-slate-100' : ''}`}
        onClick={() => {
          if (!canEdit) return;
          setDraft(item.title);
          setBaseVersion(item.version);
          setEditing(true);
        }}
        title={canEdit ? 'Click to edit' : undefined}
      >
        {item.title}
      </h1>
    );
  }
  const commit = () => {
    setEditing(false);
    if (draft.trim() && draft.trim() !== item.title) onSave(draft.trim(), baseVersion);
  };
  return (
    <input
      className="input !text-2xl !font-semibold"
      value={draft}
      maxLength={200}
      autoFocus
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') commit();
        if (e.key === 'Escape') setEditing(false);
      }}
      aria-label="Title"
    />
  );
}

function EditableDescription({
  item,
  canEdit,
  onSave,
}: {
  item: ItemDetail;
  canEdit: boolean;
  onSave: (description: string, version: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [baseVersion, setBaseVersion] = useState(item.version);
  const changedUnderneath = editing && item.version !== baseVersion;

  return (
    <Card
      title="Description"
      action={
        canEdit &&
        !editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setDraft(item.description);
              setBaseVersion(item.version);
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )
      }
    >
      <div className="p-4">
        {editing ? (
          <div className="space-y-2">
            {changedUnderneath && (
              <p className="rounded bg-amber-50 px-2 py-1 text-xs text-amber-800">
                Heads up: this item changed while you were editing. Saving will ask you to resolve the conflict.
              </p>
            )}
            <textarea className="input min-h-40" value={draft} onChange={(e) => setDraft(e.target.value)} autoFocus aria-label="Description" />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  setEditing(false);
                  if (draft !== item.description) onSave(draft, baseVersion);
                }}
              >
                Save
              </Button>
            </div>
          </div>
        ) : item.description ? (
          <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700">{item.description}</p>
        ) : (
          <p className="text-sm text-slate-400">No description.</p>
        )}
      </div>
    </Card>
  );
}

function TransitionDialog({
  item,
  to,
  onClose,
  onSubmit,
  pending,
}: {
  item: ItemDetail;
  to: Status | null;
  onClose: () => void;
  onSubmit: (input: { reason?: string; resolution?: string }) => void;
  pending: boolean;
}) {
  const [text, setText] = useState('');
  useEffect(() => setText(''), [to]);
  if (!to) return null;
  const isResolve = to === 'RESOLVED';
  const optional = to === 'PENDING_APPROVAL';
  const prompt = {
    RESOLVED: 'How was this resolved?',
    BLOCKED: 'What is blocking progress?',
    CANCELLED: 'Why is this being cancelled?',
    PENDING_APPROVAL: 'Note for the approver (optional)',
    IN_PROGRESS: 'Why is this being reopened?',
  }[to as string];

  return (
    <Modal
      open
      onClose={onClose}
      title={`${transitionVerb(item.status, to)} · ${item.key}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={to === 'CANCELLED' ? 'danger' : 'primary'}
            loading={pending}
            disabled={!optional && !text.trim()}
            onClick={() => onSubmit(isResolve ? { resolution: text } : { reason: text || undefined })}
          >
            {transitionVerb(item.status, to)}
          </Button>
        </>
      }
    >
      <label className="label" htmlFor="transition-text">{prompt}</label>
      <textarea id="transition-text" className="input min-h-24" value={text} onChange={(e) => setText(e.target.value)} />
      {to === 'PENDING_APPROVAL' && <p className="mt-2 text-xs text-slate-500">Team leads will be notified. You cannot approve your own request.</p>}
    </Modal>
  );
}

function ReasonDialog(props: {
  open: boolean;
  title: string;
  label: string;
  confirm: string;
  pending: boolean;
  onClose: () => void;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  useEffect(() => setReason(''), [props.open]);
  return (
    <Modal
      open={props.open}
      onClose={props.onClose}
      title={props.title}
      footer={
        <>
          <Button variant="ghost" onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={props.pending} disabled={!reason.trim()} onClick={() => props.onSubmit(reason)}>
            {props.confirm}
          </Button>
        </>
      }
    >
      <label className="label" htmlFor="reason">{props.label}</label>
      <textarea id="reason" className="input min-h-24" value={reason} onChange={(e) => setReason(e.target.value)} />
    </Modal>
  );
}

const FIELD_NAMES: Record<string, string> = {
  title: 'Title',
  description: 'Description',
  priority: 'Priority',
  dueAt: 'Due date',
  requiresApproval: 'Requires approval',
};

function show(field: string, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (field === 'dueAt') return fullDate(String(v));
  if (field === 'requiresApproval') return v ? 'Yes' : 'No';
  const s = String(v);
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

/**
 * Shown when the server rejects an edit because someone else changed the item first.
 * The user sees exactly what differs and chooses: keep the other person's version,
 * or deliberately re-apply their own change on top of it.
 */
function ConflictDialog({ conflict, onDiscard, onReapply }: { conflict: ConflictState; onDiscard: () => void; onReapply: () => void }) {
  const { patch, theirs, lastChange } = conflict;
  return (
    <Modal
      open
      onClose={onDiscard}
      title="This item was changed by someone else"
      width="max-w-xl"
      footer={
        <>
          <Button onClick={onDiscard}>Keep their version</Button>
          <Button variant="primary" onClick={onReapply}>
            Apply my change anyway
          </Button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        {lastChange?.actor_name ?? 'Another user'} updated <span className="font-mono">{theirs.key}</span>
        {lastChange?.created_at && ` ${relativeTime(lastChange.created_at)}`} while you were editing. Your change has <b>not</b> been saved.
      </p>
      <table className="mt-4 w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-slate-500">
            <th className="py-1 pr-2 font-medium">Field</th>
            <th className="py-1 pr-2 font-medium">Current (theirs)</th>
            <th className="py-1 font-medium">Yours</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 align-top">
          {Object.entries(patch).map(([field, mine]) => (
            <tr key={field}>
              <td className="py-2 pr-2 text-slate-500">{FIELD_NAMES[field] ?? field}</td>
              <td className="py-2 pr-2">{show(field, (theirs as unknown as Record<string, unknown>)[field])}</td>
              <td className="py-2 font-medium text-brand-700">{show(field, mine)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-slate-500">
        Status is now <b>{STATUS_LABEL[theirs.status]}</b>, owner {theirs.owner?.name ?? 'unassigned'}, priority {theirs.priority}.
      </p>
    </Modal>
  );
}
