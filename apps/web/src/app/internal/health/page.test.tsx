import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OperationalHealth } from '@uttily/core';

const mocks = vi.hoisted(() => ({
  requireSupportPlatformAdmin: vi.fn(),
  getOperationalHealth: vi.fn(),
  emitOperationalLog: vi.fn(),
}));

vi.mock('@/lib/support-auth', () => ({
  requireSupportPlatformAdmin: mocks.requireSupportPlatformAdmin,
}));

vi.mock('@uttily/core', () => ({
  getOperationalHealth: mocks.getOperationalHealth,
  emitOperationalLog: mocks.emitOperationalLog,
}));

const { default: InternalHealthPage } = await import('./page');

const health: OperationalHealth = {
  readAt: '2026-08-28T10:00:00.000Z',
  signals: [
    {
      key: 'notifications',
      label: 'Notifications',
      status: 'OK',
      counts: {
        pendingCount: 2,
        dueCount: 0,
        failedCount: 0,
        manualReviewCount: 0,
        activeLeaseCount: 1,
        expiredLeaseCount: 0,
      },
    },
    {
      key: 'transactionalEmails',
      label: 'Emails transactionnels',
      status: 'Action requise',
      counts: {
        pendingCount: 3,
        dueCount: 1,
        failedCount: 0,
        manualReviewCount: 0,
        activeLeaseCount: 0,
        expiredLeaseCount: 0,
      },
    },
  ],
};

describe('/internal/health', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSupportPlatformAdmin.mockResolvedValue({ db: {} });
    mocks.getOperationalHealth.mockResolvedValue(health);
  });

  it('rend les valeurs utiles et les états calculés', async () => {
    const markup = renderToStaticMarkup(await InternalHealthPage());

    expect(markup).toContain('Santé opérationnelle');
    expect(markup).toContain('Lecture : 28/08/2026 10:00:00 UTC');
    expect(markup).toContain('Notifications');
    expect(markup).toContain('Emails transactionnels');
    expect(markup).toContain('Action requise');
    expect(markup).toContain('Leases actifs');
    expect(markup).toContain('2');
    expect(markup).toContain('1');
  });

  it('délègue toujours la lecture à la garde interne, donc un Pro est refusé', async () => {
    mocks.requireSupportPlatformAdmin.mockRejectedValueOnce(new Error('FORBIDDEN'));

    await expect(InternalHealthPage()).rejects.toThrow('FORBIDDEN');
    expect(mocks.getOperationalHealth).not.toHaveBeenCalled();
  });

  it('affiche Action requise et journalise seulement un code si la lecture échoue', async () => {
    mocks.getOperationalHealth.mockRejectedValueOnce(new Error('database contains sensitive text'));

    const markup = renderToStaticMarkup(await InternalHealthPage());

    expect(markup).toContain('Action requise');
    expect(markup).not.toContain('database contains sensitive text');
    expect(mocks.emitOperationalLog).toHaveBeenCalledWith({
      operation: 'internal_health',
      outcome: 'failed',
      errorCode: 'HEALTH_READ_FAILED',
    });
  });
});
