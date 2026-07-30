import { describe, it, expect } from 'vitest';
import { resolveFinancialTerms } from './resolve-financial-terms';
import { FinancialTermsError } from './errors';
import type {
  CommissionConfig,
  ConnectedAccountConfig,
  FinancialTermsConfig,
  FinancialTermsInput,
  TaxConfig,
  TermsAcceptanceProof,
} from './types';

/**
 * Fixtures de test uniquement. Aucune fixture n'est chargeable en production.
 */

const LEGAL_TERMS_VERSION = '2024-01-01';

function baseTaxConfig(overrides: Partial<TaxConfig> = {}): TaxConfig {
  return {
    version: 'tax-v1',
    status: 'NOT_APPLICABLE',
    amountMinor: null,
    rateBps: null,
    invoiceIssuer: 'Uttily SAS',
    ...overrides,
  };
}

function baseCommissionConfig(overrides: Partial<CommissionConfig> = {}): CommissionConfig {
  return {
    version: 'commission-v1',
    basis: 'total_amount_minor',
    amountMinor: 0,
    ...overrides,
  };
}

function baseConnectedAccountConfig(
  overrides: Partial<ConnectedAccountConfig> = {},
): ConnectedAccountConfig {
  return {
    accountId: 'acct_123',
    chargesEnabled: true,
    transfersCapabilityStatus: 'ACTIVE',
    settlementMerchantMode: 'CONNECTED_ACCOUNT',
    onBehalfOfAccountId: null,
    ...overrides,
  };
}

function baseConfig(overrides: Partial<FinancialTermsConfig> = {}): FinancialTermsConfig {
  return {
    tax: baseTaxConfig(),
    commission: baseCommissionConfig(),
    connectedAccount: baseConnectedAccountConfig(),
    legalTermsVersion: LEGAL_TERMS_VERSION,
    ...overrides,
  };
}

function baseInput(overrides: Partial<FinancialTermsInput> = {}): FinancialTermsInput {
  return {
    organizationId: 'org_123',
    draftTotalAmountMinor: 10000,
    draftCurrency: 'EUR',
    ...overrides,
  };
}

function baseAcceptance(overrides: Partial<TermsAcceptanceProof> = {}): TermsAcceptanceProof {
  return {
    termsVersion: LEGAL_TERMS_VERSION,
    userId: 'user_123',
    acceptedAt: '2024-06-01T12:00:00.000Z',
    ...overrides,
  };
}

describe('resolveFinancialTerms', () => {
  // --- Happy path ---

  it('résout avec tax NOT_APPLICABLE et commission zéro', () => {
    const snapshot = resolveFinancialTerms(baseInput(), baseConfig(), baseAcceptance());
    expect(snapshot.taxStatus).toBe('NOT_APPLICABLE');
    expect(snapshot.taxAmountMinor).toBe(0);
    expect(snapshot.taxRateBps).toBeNull();
    expect(snapshot.commissionAmountMinor).toBe(0);
    expect(snapshot.currency).toBe('EUR');
    expect(snapshot.chargeModel).toBe('DESTINATION');
    expect(snapshot.version).toBe('v1');
  });

  it('résout avec tax APPLIED et commission positive', () => {
    const snapshot = resolveFinancialTerms(
      baseInput(),
      baseConfig({
        tax: baseTaxConfig({
          status: 'APPLIED',
          amountMinor: 2000,
          rateBps: 2000,
        }),
        commission: baseCommissionConfig({ amountMinor: 1000 }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.taxStatus).toBe('APPLIED');
    expect(snapshot.taxAmountMinor).toBe(2000);
    expect(snapshot.taxRateBps).toBe(2000);
    expect(snapshot.commissionAmountMinor).toBe(1000);
  });

  it('résout avec on_behalf_of_account_id défini', () => {
    const snapshot = resolveFinancialTerms(
      baseInput(),
      baseConfig({
        connectedAccount: baseConnectedAccountConfig({ onBehalfOfAccountId: 'acct_onbehalf' }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.onBehalfOfAccountId).toBe('acct_onbehalf');
  });

  it('résout avec on_behalf_of_account_id null', () => {
    const snapshot = resolveFinancialTerms(baseInput(), baseConfig(), baseAcceptance());
    expect(snapshot.onBehalfOfAccountId).toBeNull();
  });

  it('total du snapshot égal au total immuable du brouillon', () => {
    const snapshot = resolveFinancialTerms(
      baseInput({ draftTotalAmountMinor: 4242 }),
      baseConfig(),
      baseAcceptance(),
    );
    expect(snapshot.totalAmountMinor).toBe(4242);
  });

  it('taxRateBps null quand NOT_APPLICABLE', () => {
    const snapshot = resolveFinancialTerms(baseInput(), baseConfig(), baseAcceptance());
    expect(snapshot.taxRateBps).toBeNull();
  });

  it('taxRateBps défini quand APPLIED', () => {
    const snapshot = resolveFinancialTerms(
      baseInput(),
      baseConfig({
        tax: baseTaxConfig({ status: 'APPLIED', amountMinor: 500, rateBps: 500 }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.taxRateBps).toBe(500);
  });

  it('taxRateBps null autorisé quand APPLIED (non pertinent)', () => {
    const snapshot = resolveFinancialTerms(
      baseInput(),
      baseConfig({
        tax: baseTaxConfig({ status: 'APPLIED', amountMinor: 500, rateBps: null }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.taxRateBps).toBeNull();
  });

  it('propage settlementMerchantMode depuis la configuration', () => {
    const snapshot = resolveFinancialTerms(
      baseInput(),
      baseConfig({
        connectedAccount: baseConnectedAccountConfig({ settlementMerchantMode: 'PLATFORM' }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.settlementMerchantMode).toBe('PLATFORM');
  });

  it('propage connectedAccountId depuis la configuration', () => {
    const snapshot = resolveFinancialTerms(
      baseInput(),
      baseConfig({
        connectedAccount: baseConnectedAccountConfig({ accountId: 'acct_custom' }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.connectedAccountId).toBe('acct_custom');
  });

  it('propage legalTermsVersion depuis la configuration', () => {
    const snapshot = resolveFinancialTerms(
      baseInput(),
      baseConfig({ legalTermsVersion: '2025-03-01' }),
      baseAcceptance({ termsVersion: '2025-03-01' }),
    );
    expect(snapshot.legalTermsVersion).toBe('2025-03-01');
  });

  it('construit taxRuleSnapshot avec version et invoiceIssuer', () => {
    const snapshot = resolveFinancialTerms(
      baseInput(),
      baseConfig({
        tax: baseTaxConfig({ version: 'tax-v2', invoiceIssuer: 'RentalCo SARL' }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.taxRuleSnapshot.version).toBe('tax-v2');
    expect(snapshot.taxRuleSnapshot.invoiceIssuer).toBe('RentalCo SARL');
  });

  it('construit commissionRuleSnapshot avec version et basis', () => {
    const snapshot = resolveFinancialTerms(
      baseInput(),
      baseConfig({
        commission: baseCommissionConfig({ version: 'commission-v2', basis: 'subtotal' }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.commissionRuleSnapshot.version).toBe('commission-v2');
    expect(snapshot.commissionRuleSnapshot.basis).toBe('subtotal');
  });

  // --- FINANCIAL_TERMS_UNRESOLVED ---

  it('tax config null → FINANCIAL_TERMS_UNRESOLVED', () => {
    expect(() =>
      resolveFinancialTerms(baseInput(), baseConfig({ tax: null }), baseAcceptance()),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(baseInput(), baseConfig({ tax: null }), baseAcceptance());
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('FINANCIAL_TERMS_UNRESOLVED');
    }
  });

  it('tax config null → message mentionne configuration fiscale manquante', () => {
    expect(() =>
      resolveFinancialTerms(baseInput(), baseConfig({ tax: null }), baseAcceptance()),
    ).toThrow(/Configuration fiscale manquante/);
  });

  it('commission config null → FINANCIAL_TERMS_UNRESOLVED', () => {
    expect(() =>
      resolveFinancialTerms(baseInput(), baseConfig({ commission: null }), baseAcceptance()),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(baseInput(), baseConfig({ commission: null }), baseAcceptance());
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('FINANCIAL_TERMS_UNRESOLVED');
    }
  });

  it('commission config null → message mentionne configuration de commission manquante', () => {
    expect(() =>
      resolveFinancialTerms(baseInput(), baseConfig({ commission: null }), baseAcceptance()),
    ).toThrow(/Configuration de commission manquante/);
  });

  it('connected account config null → FINANCIAL_TERMS_UNRESOLVED', () => {
    expect(() =>
      resolveFinancialTerms(baseInput(), baseConfig({ connectedAccount: null }), baseAcceptance()),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(baseInput(), baseConfig({ connectedAccount: null }), baseAcceptance());
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('FINANCIAL_TERMS_UNRESOLVED');
    }
  });

  it('connected account config null → message mentionne compte connecté non configuré', () => {
    expect(() =>
      resolveFinancialTerms(baseInput(), baseConfig({ connectedAccount: null }), baseAcceptance()),
    ).toThrow(/Compte connecté non configuré/);
  });

  it('tax status invalide (simulé via cast) → FINANCIAL_TERMS_UNRESOLVED', () => {
    // Le type TaxConfig.status est une union fermée ; on simule une valeur
    // corrompue via un cast pour tester la robustesse du résolveur.
    const badTax = { ...baseTaxConfig(), status: 'UNDETERMINED' as unknown as 'NOT_APPLICABLE' };
    expect(() =>
      resolveFinancialTerms(baseInput(), baseConfig({ tax: badTax }), baseAcceptance()),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(baseInput(), baseConfig({ tax: badTax }), baseAcceptance());
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('FINANCIAL_TERMS_UNRESOLVED');
    }
  });

  it('legal terms version vide → FINANCIAL_TERMS_UNRESOLVED', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({ legalTermsVersion: '' }),
        baseAcceptance({ termsVersion: '' }),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({ legalTermsVersion: '' }),
        baseAcceptance({ termsVersion: '' }),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('FINANCIAL_TERMS_UNRESOLVED');
    }
  });

  it("legal terms version composée d'espaces → FINANCIAL_TERMS_UNRESOLVED", () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({ legalTermsVersion: '   ' }),
        baseAcceptance({ termsVersion: '   ' }),
      ),
    ).toThrow(FinancialTermsError);
  });

  // --- PAYMENT_ACCOUNT_NOT_READY ---

  it('chargesEnabled false → PAYMENT_ACCOUNT_NOT_READY', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({ chargesEnabled: false }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({ chargesEnabled: false }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('PAYMENT_ACCOUNT_NOT_READY');
    }
  });

  it('chargesEnabled false → message mentionne non autorisé à encaisser', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({ chargesEnabled: false }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(/pas autorisé à encaisser/);
  });

  it('transfers capability INACTIVE → PAYMENT_ACCOUNT_NOT_READY', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({
            transfersCapabilityStatus: 'INACTIVE',
          }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({
            transfersCapabilityStatus: 'INACTIVE',
          }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('PAYMENT_ACCOUNT_NOT_READY');
    }
  });

  it('transfers capability PENDING → PAYMENT_ACCOUNT_NOT_READY', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({
            transfersCapabilityStatus: 'PENDING',
          }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({
            transfersCapabilityStatus: 'PENDING',
          }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('PAYMENT_ACCOUNT_NOT_READY');
    }
  });

  it('transfers capability UNREQUESTED → PAYMENT_ACCOUNT_NOT_READY', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({
            transfersCapabilityStatus: 'UNREQUESTED',
          }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({
            transfersCapabilityStatus: 'UNREQUESTED',
          }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('PAYMENT_ACCOUNT_NOT_READY');
    }
  });

  // --- VALIDATION ---

  it('devise non EUR (USD) → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(baseInput({ draftCurrency: 'USD' }), baseConfig(), baseAcceptance()),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(baseInput({ draftCurrency: 'USD' }), baseConfig(), baseAcceptance());
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('devise non EUR → message mentionne devise non supportée', () => {
    expect(() =>
      resolveFinancialTerms(baseInput({ draftCurrency: 'USD' }), baseConfig(), baseAcceptance()),
    ).toThrow(/devise non supportée/);
  });

  it('total non safe integer (1.5) → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput({ draftTotalAmountMinor: 1.5 }),
        baseConfig(),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput({ draftTotalAmountMinor: 1.5 }),
        baseConfig(),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('total négatif (-1) → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput({ draftTotalAmountMinor: -1 }),
        baseConfig(),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput({ draftTotalAmountMinor: -1 }),
        baseConfig(),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('commission > total → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput({ draftTotalAmountMinor: 500 }),
        baseConfig({
          commission: baseCommissionConfig({ amountMinor: 501 }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput({ draftTotalAmountMinor: 500 }),
        baseConfig({
          commission: baseCommissionConfig({ amountMinor: 501 }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('commission > total → message mentionne commission supérieure au total', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput({ draftTotalAmountMinor: 500 }),
        baseConfig({
          commission: baseCommissionConfig({ amountMinor: 501 }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(/commission supérieure au total/);
  });

  it('commission non safe integer (1.5) → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          commission: baseCommissionConfig({ amountMinor: 1.5 as number }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          commission: baseCommissionConfig({ amountMinor: 1.5 as number }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('commission négative (-1) → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          commission: baseCommissionConfig({ amountMinor: -1 }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          commission: baseCommissionConfig({ amountMinor: -1 }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('tax APPLIED avec montant null → VALIDATION', () => {
    // Choix documenté : un statut APPLIED sans montant est une erreur de
    // VALIDATION (la configuration est présente mais incohérente), et non
    // une FINANCIAL_TERMS_UNRESOLVED (qui signifie « configuration absente »).
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'APPLIED', amountMinor: null, rateBps: 2000 }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'APPLIED', amountMinor: null, rateBps: 2000 }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('tax APPLIED avec montant négatif → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'APPLIED', amountMinor: -1, rateBps: 2000 }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'APPLIED', amountMinor: -1, rateBps: 2000 }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('tax APPLIED avec montant > MAX_SAFE_INTEGER → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({
            status: 'APPLIED',
            amountMinor: Number.MAX_SAFE_INTEGER + 1,
            rateBps: 2000,
          }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({
            status: 'APPLIED',
            amountMinor: Number.MAX_SAFE_INTEGER + 1,
            rateBps: 2000,
          }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('tax NOT_APPLICABLE avec montant non nul → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'NOT_APPLICABLE', amountMinor: 100, rateBps: null }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'NOT_APPLICABLE', amountMinor: 100, rateBps: null }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('tax NOT_APPLICABLE avec rateBps non null → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'NOT_APPLICABLE', amountMinor: null, rateBps: 2000 }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'NOT_APPLICABLE', amountMinor: null, rateBps: 2000 }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('tax APPLIED avec rateBps négatif → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'APPLIED', amountMinor: 500, rateBps: -1 }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'APPLIED', amountMinor: 500, rateBps: -1 }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('tax APPLIED avec rateBps non safe integer → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'APPLIED', amountMinor: 500, rateBps: 1.5 }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          tax: baseTaxConfig({ status: 'APPLIED', amountMinor: 500, rateBps: 1.5 }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('terms acceptance version mismatch → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({ legalTermsVersion: '2024-01-01' }),
        baseAcceptance({ termsVersion: '2023-01-01' }),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({ legalTermsVersion: '2024-01-01' }),
        baseAcceptance({ termsVersion: '2023-01-01' }),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('terms acceptance version mismatch → message mentionne ne correspond pas', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({ legalTermsVersion: '2024-01-01' }),
        baseAcceptance({ termsVersion: '2023-01-01' }),
      ),
    ).toThrow(/ne correspond pas/);
  });

  it('terms acceptance userId vide → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(baseInput(), baseConfig(), baseAcceptance({ userId: '' })),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(baseInput(), baseConfig(), baseAcceptance({ userId: '' }));
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it("terms acceptance userId composé d'espaces → VALIDATION", () => {
    expect(() =>
      resolveFinancialTerms(baseInput(), baseConfig(), baseAcceptance({ userId: '   ' })),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(baseInput(), baseConfig(), baseAcceptance({ userId: '   ' }));
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('terms acceptance acceptedAt invalide → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig(),
        baseAcceptance({ acceptedAt: 'not-a-date' }),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig(),
        baseAcceptance({ acceptedAt: 'not-a-date' }),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('terms acceptance acceptedAt vide → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(baseInput(), baseConfig(), baseAcceptance({ acceptedAt: '' })),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(baseInput(), baseConfig(), baseAcceptance({ acceptedAt: '' }));
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  it('on_behalf_of_account_id vide → VALIDATION', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({ onBehalfOfAccountId: '' }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
    try {
      resolveFinancialTerms(
        baseInput(),
        baseConfig({
          connectedAccount: baseConnectedAccountConfig({ onBehalfOfAccountId: '' }),
        }),
        baseAcceptance(),
      );
    } catch (err) {
      expect((err as FinancialTermsError).code).toBe('VALIDATION');
    }
  });

  // --- Overflow / bornes ---

  it('tax amount à MAX_SAFE_INTEGER (borne valide)', () => {
    const snapshot = resolveFinancialTerms(
      baseInput({ draftTotalAmountMinor: Number.MAX_SAFE_INTEGER }),
      baseConfig({
        tax: baseTaxConfig({
          status: 'APPLIED',
          amountMinor: Number.MAX_SAFE_INTEGER,
          rateBps: 2000,
        }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.taxAmountMinor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('tax amount à MAX_SAFE_INTEGER + 1 (invalide)', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput({ draftTotalAmountMinor: Number.MAX_SAFE_INTEGER }),
        baseConfig({
          tax: baseTaxConfig({
            status: 'APPLIED',
            amountMinor: Number.MAX_SAFE_INTEGER + 1,
            rateBps: 2000,
          }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
  });

  it('commission à MAX_SAFE_INTEGER (borne valide)', () => {
    const snapshot = resolveFinancialTerms(
      baseInput({ draftTotalAmountMinor: Number.MAX_SAFE_INTEGER }),
      baseConfig({
        commission: baseCommissionConfig({ amountMinor: Number.MAX_SAFE_INTEGER }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.commissionAmountMinor).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('commission == total (borne valide)', () => {
    const snapshot = resolveFinancialTerms(
      baseInput({ draftTotalAmountMinor: 10000 }),
      baseConfig({
        commission: baseCommissionConfig({ amountMinor: 10000 }),
      }),
      baseAcceptance(),
    );
    expect(snapshot.commissionAmountMinor).toBe(10000);
    expect(snapshot.totalAmountMinor).toBe(10000);
  });

  it('commission == total + 1 (invalide)', () => {
    expect(() =>
      resolveFinancialTerms(
        baseInput({ draftTotalAmountMinor: 10000 }),
        baseConfig({
          commission: baseCommissionConfig({ amountMinor: 10001 }),
        }),
        baseAcceptance(),
      ),
    ).toThrow(FinancialTermsError);
  });

  it('total à 0 (borne valide, commission 0)', () => {
    const snapshot = resolveFinancialTerms(
      baseInput({ draftTotalAmountMinor: 0 }),
      baseConfig(),
      baseAcceptance(),
    );
    expect(snapshot.totalAmountMinor).toBe(0);
    expect(snapshot.commissionAmountMinor).toBe(0);
  });

  // --- Immutabilité ---

  it("ne mute pas l'objet input", () => {
    const input = baseInput();
    const inputCopy = { ...input };
    resolveFinancialTerms(input, baseConfig(), baseAcceptance());
    expect(input).toEqual(inputCopy);
  });

  it("ne mute pas l'objet config", () => {
    const config = baseConfig();
    const configCopy = JSON.parse(JSON.stringify(config));
    resolveFinancialTerms(baseInput(), config, baseAcceptance());
    expect(config).toEqual(configCopy);
  });

  it("ne mute pas l'objet acceptance", () => {
    const acceptance = baseAcceptance();
    const acceptanceCopy = { ...acceptance };
    resolveFinancialTerms(baseInput(), baseConfig(), acceptance);
    expect(acceptance).toEqual(acceptanceCopy);
  });

  it('les snapshots de règles sont des recopies (pas des références)', () => {
    // Le résolveur construit de nouveaux objets pour taxRuleSnapshot et
    // commissionRuleSnapshot ; ils ne partagent pas de référence avec la config.
    const config = baseConfig();
    const snapshot = resolveFinancialTerms(baseInput(), config, baseAcceptance());
    expect(snapshot.taxRuleSnapshot).not.toBe(config.tax);
    expect(snapshot.commissionRuleSnapshot).not.toBe(config.commission);
  });
});
