import { describe, it, expect } from 'vitest';
import { generateCommissionStatementCsv } from './commission-statement';
import type { MerchantFinanceOverview } from './types';

describe('generateCommissionStatementCsv', () => {
  const mockOverview: MerchantFinanceOverview = {
    currency: 'EUR',
    period: {
      from: new Date('2026-08-01T00:00:00.000Z'),
      to: new Date('2026-08-31T23:59:59.999Z'),
      label: 'Août 2026',
    },
    sales: {
      grossAmountMinor: 10000,
      bookingCount: 1,
    },
    payments: {
      succeededAmountMinor: 10000,
      pendingAmountMinor: 0,
      refundedAmountMinor: 0,
    },
    commissions: {
      platformAmountMinor: 1300,
      platformApplicationFeeAmountMinor: 1300,
    },
    merchant: {
      netAfterCommissionMinor: 8700,
    },
    payouts: {
      totalPaidAmountMinor: 8700,
      inTransitAmountMinor: 0,
      lastPayout: null,
      nextPayoutSchedule: 'Quotidien',
      history: [],
    },
    activity: [
      {
        id: 'act-1',
        date: new Date('2026-08-15T14:30:00.000Z'),
        type: 'PAYMENT',
        bookingReference: 'BK-2026-001',
        productName: 'Vélo Gravel Électrique',
        customerEmail: 'client@example.com',
        grossAmountMinor: 10000,
        commissionAmountMinor: 1300,
        netAmountMinor: 8700,
        currency: 'EUR',
        status: 'PAID',
        statusLabel: 'Payé',
      },
    ],
  };

  it('génère un décompte avec en-tête légal émetteur et partenaire', () => {
    const csv = generateCommissionStatementCsv({
      organization: {
        legalName: 'Outdoor Rent SAS',
        legalForm: 'SAS',
        registrationNumber: '73282932000074',
        vatNumber: 'FR44732829320',
        registryCity: 'Annecy',
        registeredOfficeAddress: '15 Quai de la Tournette',
        registeredOfficePostalCode: '74000',
        registeredOfficeCity: 'Annecy',
      },
      overview: mockOverview,
    });

    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv).toContain('DÉCOMPTE OFFICIEL DE COMMISSIONS ET REVERSEMENTS');
    expect(csv).toContain('Uttily SAS');
    expect(csv).toContain('Outdoor Rent SAS (SAS)');
    expect(csv).toContain('SIRET/SIREN : 73282932000074');
    expect(csv).toContain('RCS : Annecy');
    expect(csv).toContain('N° TVA Intracommunautaire : FR44732829320');
    expect(csv).toContain('15 Quai de la Tournette 74000 Annecy');
    expect(csv).toContain('100.00'); // Chiffre d'affaires brut
    expect(csv).toContain('13.00'); // Commission 13%
    expect(csv).toContain('87.00'); // Net reversé
    expect(csv).toContain('BK-2026-001');
  });

  it('gère le cas franchise en base de TVA pour les micro-entrepreneurs', () => {
    const csv = generateCommissionStatementCsv({
      organization: {
        legalName: 'Jean Dupont',
        legalForm: 'EI',
        registrationNumber: '80090229800028',
        vatNumber: null,
      },
      overview: mockOverview,
    });

    expect(csv).toContain('Jean Dupont (EI)');
    expect(csv).toContain('Franchise en base de TVA (art. 293 B du CGI)');
  });
});
