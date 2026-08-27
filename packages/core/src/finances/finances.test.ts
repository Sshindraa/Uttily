import { describe, it, expect } from 'vitest';
import type { DatabaseClient } from '@uttily/database';
import { getMerchantFinanceOverview } from './get-merchant-finance-overview';
import { exportFinancesCsv } from './export-finances-csv';
import { projectPayoutEvent } from './project-payout';
import type { MerchantFinanceOverview } from './types';

describe('Chantier 11 — Domaine Finances & Revenus', () => {
  it('rejette un organizationId invalide lors de la lecture', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    await expect(getMerchantFinanceOverview(fakeDb, 'not-a-uuid')).rejects.toThrow(
      'organizationId',
    );
  });

  it('rejette un organizationId invalide lors de la projection payout', async () => {
    const fakeDb = {} as unknown as DatabaseClient;
    await expect(
      projectPayoutEvent(fakeDb, {
        organizationId: 'not-a-uuid',
        providerPayoutId: 'po_123',
        providerAccountId: 'acct_123',
        amountMinor: 5000,
        status: 'PAID',
      }),
    ).rejects.toThrow('organizationId');
  });

  it('génère un export CSV correct avec les colonnes attendues', () => {
    const mockOverview: MerchantFinanceOverview = {
      currency: 'EUR',
      period: {
        from: new Date('2026-08-01T00:00:00Z'),
        to: new Date('2026-08-31T23:59:59Z'),
        label: 'Août 2026',
      },
      sales: {
        grossAmountMinor: 7500,
        bookingCount: 1,
      },
      payments: {
        succeededAmountMinor: 7500,
        pendingAmountMinor: 0,
        refundedAmountMinor: 0,
      },
      commissions: {
        platformAmountMinor: 750,
      },
      merchant: {
        netAfterCommissionMinor: 6750,
      },
      payouts: {
        totalPaidAmountMinor: 6750,
        inTransitAmountMinor: 0,
        lastPayout: null,
        nextPayoutSchedule: 'Quotidien',
      },
      activity: [
        {
          id: 'pay_1',
          type: 'PAYMENT',
          bookingId: '00000000-0000-0000-0000-000000000001',
          bookingReference: '#UT-1042',
          productName: 'Canyon Roadlite',
          customerEmail: 'client@example.com',
          grossAmountMinor: 7500,
          commissionAmountMinor: 750,
          netAmountMinor: 6750,
          currency: 'EUR',
          status: 'SUCCEEDED',
          statusLabel: '✓ Paiement confirmé',
          payoutStatus: 'PAID',
          date: new Date('2026-08-28T08:30:00Z'),
        },
      ],
    };

    const csv = exportFinancesCsv(mockOverview);
    expect(csv).toContain('Date;Reference;Type;Produit / Intitule;Client');
    expect(csv).toContain('#UT-1042');
    expect(csv).toContain('75.00');
    expect(csv).toContain('7.50');
    expect(csv).toContain('67.50');
  });
});
