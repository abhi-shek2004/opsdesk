import type { ItemType, Priority, Status } from '../api/types';

export const STATUS_LABEL: Record<Status, string> = {
  OPEN: 'Open',
  IN_PROGRESS: 'In progress',
  BLOCKED: 'Blocked',
  PENDING_APPROVAL: 'Pending approval',
  RESOLVED: 'Resolved',
  CLOSED: 'Closed',
  CANCELLED: 'Cancelled',
};

export const TYPE_LABEL: Record<ItemType, string> = {
  INCIDENT: 'Incident',
  CUSTOMER_ISSUE: 'Customer issue',
  PAYMENT: 'Payment',
  ENGINEERING: 'Engineering',
  COMPLIANCE: 'Compliance',
  TASK: 'Task',
};

export const PRIORITY_LABEL: Record<Priority, string> = { P1: 'P1 · Critical', P2: 'P2 · High', P3: 'P3 · Normal', P4: 'P4 · Low' };

/** Label used on the action button that performs a transition. */
export function transitionVerb(from: Status, to: Status): string {
  if (to === 'IN_PROGRESS') {
    if (from === 'OPEN') return 'Start work';
    if (from === 'BLOCKED') return 'Unblock';
    if (from === 'PENDING_APPROVAL') return 'Withdraw request';
    if (from === 'RESOLVED') return 'Reopen';
  }
  return (
    {
      BLOCKED: 'Mark blocked',
      PENDING_APPROVAL: 'Request approval',
      RESOLVED: 'Resolve',
      CLOSED: 'Close',
      CANCELLED: 'Cancel item',
      OPEN: 'Move to open',
      IN_PROGRESS: 'Start',
    } as Record<Status, string>
  )[to];
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto', style: 'short' });

export function relativeTime(iso: string | Date, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return 'just now';
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['minute', 60_000],
    ['hour', 3_600_000],
    ['day', 86_400_000],
    ['week', 604_800_000],
    ['month', 2_592_000_000],
    ['year', 31_536_000_000],
  ];
  let unit: [Intl.RelativeTimeFormatUnit, number] = units[0];
  for (const u of units) if (abs >= u[1]) unit = u;
  return rtf.format(Math.round(diff / unit[1]), unit[0]);
}

export function dueLabel(dueAt: string | null, status: Status): { text: string; tone: 'overdue' | 'soon' | 'normal' } | null {
  if (!dueAt || ['RESOLVED', 'CLOSED', 'CANCELLED'].includes(status)) return null;
  const ms = new Date(dueAt).getTime() - Date.now();
  if (ms < 0) return { text: `Overdue ${relativeTime(dueAt).replace(' ago', '')}`, tone: 'overdue' };
  return { text: `Due ${relativeTime(dueAt)}`, tone: ms < 4 * 3_600_000 ? 'soon' : 'normal' };
}

export function fullDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null;
}
