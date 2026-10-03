import { describe, expect, it } from 'vitest';
import type { ItemDetail, Permissions } from '../api/types';
import { nextStep } from './nextStep';

const perms: Permissions = {
  edit: false,
  changeApprovalRequirement: false,
  claim: false,
  assign: false,
  unassign: false,
  comment: true,
  transitions: [],
  decideApproval: false,
};

const item = (over: Partial<ItemDetail> = {}): ItemDetail =>
  ({
    status: 'IN_PROGRESS',
    owner: { id: 'u1', name: 'Rahul' },
    requiresApproval: false,
    approvedAt: null,
    dueAt: null,
    pendingApproval: null,
    permissions: perms,
    ...over,
  }) as ItemDetail;

describe('nextStep', () => {
  it('asks for an owner when nobody owns the work', () => {
    expect(nextStep(item({ owner: null, status: 'OPEN', permissions: { ...perms, claim: true } }), 'u2')?.text).toMatch(
      /Claim it/,
    );
  });

  it('tells the owner to request approval on gated work, and others that it is waiting', () => {
    const gated = item({ requiresApproval: true });
    expect(nextStep(gated, 'u1')?.text).toMatch(/Request approval/);
    expect(nextStep(gated, 'u2')?.text).toMatch(/needs a lead's approval/);
  });

  it('asks a lead who may decide for a decision', () => {
    const pending = item({ status: 'PENDING_APPROVAL', permissions: { ...perms, decideApproval: true } });
    expect(nextStep(pending, 'lead')?.tone).toBe('action');
  });

  it('flags overdue work as a warning', () => {
    const now = Date.parse('2026-10-03T12:00:00Z');
    const s = nextStep(item({ dueAt: '2026-10-03T10:00:00Z' }), 'u1', now);
    expect(s?.tone).toBe('warning');
    expect(s?.text).toMatch(/^Overdue by 2 hr/);
  });

  it('says nothing for closed or cancelled work', () => {
    expect(nextStep(item({ status: 'CLOSED' }), 'u1')).toBeNull();
    expect(nextStep(item({ status: 'CANCELLED' }), 'u1')).toBeNull();
  });
});
