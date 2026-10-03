import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { api, newIdempotencyKey, qs } from '../api/client';
import { invalidateLists, qk, useMe } from '../api/hooks';
import { APPROVAL_TYPES_DEFAULT, ITEM_TYPES, PRIORITIES, type ItemDetail, type ItemType, type Priority } from '../api/types';
import { fromLocalInput, PRIORITY_LABEL, STATUS_LABEL, TYPE_LABEL } from '../lib/format';
import { useToast } from '../lib/toast';
import { Button, Modal, PriorityBadge } from './ui';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function CreateItemModal({ open, onClose, defaultTeamId }: { open: boolean; onClose: () => void; defaultTeamId?: string }) {
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();

  const writableTeams = useMemo(
    () => (me?.teams ?? []).filter((t) => me?.isAdmin || t.role === 'MEMBER' || t.role === 'LEAD'),
    [me],
  );
  const [teamId, setTeamId] = useState('');
  const [type, setType] = useState<ItemType>('TASK');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<Priority>('P3');
  const [dueAt, setDueAt] = useState('');
  const [requiresApproval, setRequiresApproval] = useState(false);
  const [assignToMe, setAssignToMe] = useState(false);

  // One key per "intent to create". Double clicks and network retries reuse it,
  // so the server creates at most one item. A fresh key is minted on each open.
  const idemKey = useRef(newIdempotencyKey());

  useEffect(() => {
    if (!open) return;
    idemKey.current = newIdempotencyKey();
    setTeamId(defaultTeamId && writableTeams.some((t) => t.id === defaultTeamId) ? defaultTeamId : (writableTeams[0]?.id ?? ''));
    setType('TASK');
    setTitle('');
    setDescription('');
    setPriority('P3');
    setDueAt('');
    setRequiresApproval(false);
    setAssignToMe(false);
  }, [open, defaultTeamId, writableTeams]);

  const role = me?.teams.find((t) => t.id === teamId)?.role;
  const isLead = !!me?.isAdmin || role === 'LEAD';
  const approvalByDefault = APPROVAL_TYPES_DEFAULT.includes(type);
  useEffect(() => setRequiresApproval(approvalByDefault), [approvalByDefault]);

  const debouncedTitle = useDebounced(title.trim(), 350);
  const similar = useQuery({
    queryKey: ['similar', teamId, debouncedTitle],
    queryFn: () =>
      api<{ items: { id: string; key: string; title: string; status: keyof typeof STATUS_LABEL; priority: Priority }[] }>(
        `/items/similar${qs({ q: debouncedTitle, team: teamId })}`,
      ),
    enabled: open && debouncedTitle.length >= 4,
    staleTime: 30_000,
  });

  const create = useMutation({
    mutationFn: () =>
      api<ItemDetail>('/items', {
        method: 'POST',
        idempotencyKey: idemKey.current,
        body: {
          teamId,
          type,
          title,
          description,
          priority,
          dueAt: fromLocalInput(dueAt),
          requiresApproval,
          assignToMe,
        },
      }),
    onSuccess: (item) => {
      qc.setQueryData(qk.item(item.id), item);
      invalidateLists(qc);
      toast(`Created ${item.key}`, 'success');
      onClose();
      navigate(`/items/${item.id}`);
    },
    onError: (e: Error) => toast(e.message, 'error'),
  });

  const canSubmit = !!teamId && title.trim().length > 0 && !create.isPending;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New work item"
      width="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" form="create-item" type="submit" disabled={!canSubmit} loading={create.isPending}>
            Create item
          </Button>
        </>
      }
    >
      {writableTeams.length === 0 ? (
        <p className="text-sm text-slate-600">You are a viewer in all your teams, so you cannot create work items.</p>
      ) : (
        <form
          id="create-item"
          className="grid gap-4 sm:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSubmit) create.mutate();
          }}
        >
          <div>
            <label className="label" htmlFor="ci-team">Team</label>
            <select id="ci-team" className="input" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {writableTeams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ci-type">Type</label>
            <select id="ci-type" className="input" value={type} onChange={(e) => setType(e.target.value as ItemType)}>
              {ITEM_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="ci-title">Title</label>
            <input
              id="ci-title"
              className="input"
              value={title}
              maxLength={200}
              placeholder="What needs investigation or action?"
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
            {similar.data && similar.data.items.length > 0 && (
              <div className="mt-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-xs">
                <p className="mb-1.5 font-medium text-amber-900">Possible duplicates — is someone already on this?</p>
                <ul className="space-y-1">
                  {similar.data.items.map((s) => (
                    <li key={s.id} className="flex items-center gap-2">
                      <PriorityBadge priority={s.priority} />
                      <Link to={`/items/${s.id}`} onClick={onClose} className="truncate text-amber-900 underline-offset-2 hover:underline">
                        <span className="font-mono">{s.key}</span> {s.title}
                      </Link>
                      <span className="shrink-0 text-amber-700">· {STATUS_LABEL[s.status]}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
          <div className="sm:col-span-2">
            <label className="label" htmlFor="ci-desc">Description</label>
            <textarea
              id="ci-desc"
              className="input min-h-28"
              value={description}
              placeholder="Why does this exist? Context, links, customer impact…"
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="ci-pri">Priority</label>
            <select id="ci-pri" className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)}>
              {PRIORITIES.map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label" htmlFor="ci-due">Due (optional)</label>
            <input id="ci-due" type="datetime-local" className="input" value={dueAt} onChange={(e) => setDueAt(e.target.value)} />
          </div>
          <div className="flex flex-col gap-2 sm:col-span-2">
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={requiresApproval}
                disabled={approvalByDefault && !isLead}
                onChange={(e) => setRequiresApproval(e.target.checked)}
              />
              <span>
                Requires approval before it can be resolved
                {approvalByDefault && !isLead && (
                  <span className="block text-xs text-slate-500">{TYPE_LABEL[type]} items always need a lead's sign-off.</span>
                )}
              </span>
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={assignToMe} onChange={(e) => setAssignToMe(e.target.checked)} />
              Assign to me
            </label>
          </div>
        </form>
      )}
    </Modal>
  );
}
