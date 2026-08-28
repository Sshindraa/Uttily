import { describe, expect, it } from 'vitest';
import { buildOperationalHealth, classifyOperationalHealthSignal } from './operational-health';

const emptyCounts = {
  pendingCount: 0,
  dueCount: 0,
  failedCount: 0,
  manualReviewCount: 0,
  activeLeaseCount: 0,
  expiredLeaseCount: 0,
};

describe('operational health classification', () => {
  it('laisse un pending normal et un lease actif en état OK', () => {
    expect(
      classifyOperationalHealthSignal({
        ...emptyCounts,
        pendingCount: 3,
        activeLeaseCount: 1,
      }),
    ).toBe('OK');
  });

  it('classe un lease expiré sans travail dû comme À surveiller', () => {
    expect(classifyOperationalHealthSignal({ ...emptyCounts, expiredLeaseCount: 1 })).toBe(
      'À surveiller',
    );
  });

  it('classe une opération réellement due ou échouée comme Action requise', () => {
    expect(classifyOperationalHealthSignal({ ...emptyCounts, dueCount: 1 })).toBe('Action requise');
    expect(classifyOperationalHealthSignal({ ...emptyCounts, failedCount: 1 })).toBe(
      'Action requise',
    );
    expect(classifyOperationalHealthSignal({ ...emptyCounts, manualReviewCount: 1 })).toBe(
      'Action requise',
    );
  });

  it('projette uniquement des compteurs et labels sûrs depuis la lecture', () => {
    const health = buildOperationalHealth({
      read_at: '2026-08-28T10:00:00.000Z',
      notifications_pending: '2',
      notifications_due: '0',
      notifications_failed: '0',
      notifications_manual_review: '0',
      notifications_active_leases: '1',
      notifications_expired_leases: '0',
      transactional_emails_pending: '1',
      transactional_emails_due: '1',
      transactional_emails_failed: '0',
      transactional_emails_manual_review: '0',
      transactional_emails_active_leases: '0',
      transactional_emails_expired_leases: '0',
      payments_pending: '1',
      payments_due: '0',
      payments_failed: '0',
      payments_manual_review: 0,
      payments_active_leases: '1',
      payments_expired_leases: '0',
      refunds_pending: '0',
      refunds_due: '0',
      refunds_failed: '1',
      refunds_manual_review: '1',
      refunds_active_leases: '0',
      refunds_expired_leases: '0',
      outbox_pending: '0',
      outbox_due: '0',
      outbox_failed: '0',
      outbox_manual_review: 0,
      outbox_active_leases: '0',
      outbox_expired_leases: '0',
    });

    expect(health.readAt).toBe('2026-08-28T10:00:00.000Z');
    expect(health.signals).toHaveLength(5);
    expect(health.signals.find((signal) => signal.key === 'notifications')).toMatchObject({
      status: 'OK',
      counts: { pendingCount: 2, activeLeaseCount: 1 },
    });
    expect(health.signals.find((signal) => signal.key === 'transactionalEmails')).toMatchObject({
      status: 'Action requise',
      counts: { dueCount: 1 },
    });
    expect(health.signals.find((signal) => signal.key === 'refunds')).toMatchObject({
      status: 'Action requise',
      counts: { failedCount: 1, manualReviewCount: 1 },
    });
    expect(JSON.stringify(health)).not.toMatch(/email@|token|secret|payload/i);
  });
});
