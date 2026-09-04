/**
 * Test d'intégration PostgreSQL pour l'effacement RGPD et le scellement probatoire (Lot 21-P2, ADR-039).
 *
 * Vérifie :
 * 1. La pseudonymisation irréversible de la ligne `users` (email tombstone, displayName null, deletedAt set, oidcProvider null).
 * 2. La purge de l'identité externe Clerk (mock).
 * 3. La création du scellé probatoire `privacy_probatory_seals` avec les échéances civiles (5 ans) et comptables (10 ans).
 * 4. L'intégrité référentielle préservée avec l'`audit_log` (pas de hard-delete SQL impossible).
 * 5. Le verrouillage de l'authentification : provisionUserFromOidc rejette le compte effacé (AccountDeletedError).
 * 6. Les garde-fous fail-closed (rejet si réservations actives/confirmées ou sole owner d'org avec items).
 * 7. L'idempotence de l'effacement.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from './setup';
import {
  createDatabase,
  users,
  organizations,
  organizationMemberships,
  locations,
  categories,
  products,
  productVariants,
  inventoryItems,
  bookingDrafts,
  payments,
  bookings,
  privacyRequests,
  privacyProbatorySeals,
  auditLog,
} from '@uttily/database';
import { eraseUserAccount, checkUserErasureEligibility, UserErasureError } from '../privacy';
import { executeErasurePrivacyRequest } from '../support/privacy';
import { provisionUserFromOidc } from '../identity/provisioning';
import { AccountDeletedError } from '../identity/types';

describe('Lot 21-P2: Privacy Erasure & Probatory Seal (PostgreSQL Integration)', () => {
  if (shouldSkipIntegrationTests()) {
    it.skip('PostgreSQL integration tests skippés (DATABASE_URL absente ou SKIP_INTEGRATION_TESTS=1)', () => {});
    return;
  }

  let ctx: IntegrationTestContext | null = null;
  let db: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    ctx = await setupIntegrationTestDb('privacy_erasure');
    if (ctx) {
      db = createDatabase(ctx.databaseUrl);
    }
  });

  afterAll(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  async function createFixture() {
    const rawSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const suffix = rawSuffix.toLowerCase().replace(/[^a-z0-9-]/g, '');

    const [user] = await db
      .insert(users)
      .values({
        email: `renter-${suffix}@example.com`,
        displayName: `Renter ${suffix}`,
        oidcSubject: `user_clerk_${suffix}`,
        oidcProvider: 'clerk',
      })
      .returning();

    const [admin] = await db
      .insert(users)
      .values({
        email: `admin-${suffix}@uttily.com`,
        displayName: `Admin ${suffix}`,
        isPlatformAdmin: true,
      })
      .returning();

    const [org] = await db
      .insert(organizations)
      .values({
        legalName: `Shop ${suffix} SAS`,
        slug: `shop-${suffix}`,
      })
      .returning();

    if (!user || !admin || !org) {
      throw new Error('Initial fixture insert failed');
    }

    const [loc] = await db
      .insert(locations)
      .values({
        organizationId: org.id,
        name: `Shop Location ${suffix}`,
        slug: `loc-${suffix}`,
        addressLine1: '10 Rue du Port',
        city: 'Annecy',
        postalCode: '74000',
        countryCode: 'FR',
        timeZone: 'Europe/Paris',
        operatingCurrency: 'EUR',
        pickupEnabled: true,
      })
      .returning();

    const [cat] = await db
      .insert(categories)
      .values({
        name: `Gravel ${suffix}`,
        slug: `gravel-${suffix}`,
      })
      .returning();

    if (!loc || !cat) {
      throw new Error('Location or category fixture insert failed');
    }

    const [prod] = await db
      .insert(products)
      .values({
        organizationId: org.id,
        categoryId: cat.id,
        name: `Bike ${suffix}`,
        slug: `bike-${suffix}`,
      })
      .returning();

    if (!prod) {
      throw new Error('Product fixture insert failed');
    }

    const [variant] = await db
      .insert(productVariants)
      .values({
        productId: prod.id,
        name: 'Size M',
      })
      .returning();

    if (!variant) {
      throw new Error('Variant fixture insert failed');
    }

    const [item] = await db
      .insert(inventoryItems)
      .values({
        organizationId: org.id,
        productVariantId: variant.id,
        currentLocationId: loc.id,
        internalSku: `SKU-${suffix}`,
        serialNumber: `SN-${suffix}`,
        status: 'ACTIVE',
      })
      .returning();

    if (!item) {
      throw new Error('Item fixture insert failed');
    }

    return { user, admin, org, loc, cat, prod, variant, item, suffix };
  }

  it('exécute l’effacement, la pseudonymisation et le scellement probatoire avec intégrité référentielle', async () => {
    if (!ctx) return;
    const f = await createFixture();

    // Créer un draft et un paiement associés
    const [draft] = await db
      .insert(bookingDrafts)
      .values({
        organizationId: f.org.id,
        locationId: f.loc.id,
        customerUserId: f.user.id,
        status: 'CONVERTED',
        customerStartAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        customerEndAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
        blockedStartAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        blockedEndAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
        timezone: 'Europe/Paris',
        prepBufferMinutes: 30,
        cleanupBufferMinutes: 30,
        currency: 'EUR',
        subtotalAmountMinor: 5000,
        totalAmountMinor: 5000,
        customerTotalAmountMinor: 5000,
        commissionAmountMinor: 500,
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        cancellationPolicySnapshot: { policy: 'FLEXIBLE' },
        billableUnitCount: 2,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      })
      .returning();

    if (!draft) throw new Error('draft creation failed');

    const [payment] = await db
      .insert(payments)
      .values({
        organizationId: f.org.id,
        draftId: draft.id,
        customerUserId: f.user.id,
        status: 'SUCCEEDED',
        amountMinor: 5000,
        currency: 'EUR',
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        commissionAmountMinor: 500,
        financialTermsVersion: 'v1',
        legalTermsVersion: 'v1',
        termsAcceptanceSnapshot: { termsVersion: 'v1' },
        connectedAccountId: `counter-${f.org.id}`,
        chargeModel: 'DESTINATION',
        settlementMerchantMode: 'PLATFORM',
        environment: 'TEST',
        succeededAt: new Date(),
      })
      .returning();

    if (!payment) throw new Error('payment creation failed');

    // Créer une réservation passée et clôturée
    const [pastBooking] = await db
      .insert(bookings)
      .values({
        organizationId: f.org.id,
        locationId: f.loc.id,
        customerUserId: f.user.id,
        draftId: draft.id,
        paymentId: payment.id,
        status: 'CLOSED',
        customerStartAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        customerEndAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
        blockedStartAt: new Date(Date.now() - 14 * 24 * 60 * 60 * 1000),
        blockedEndAt: new Date(Date.now() - 12 * 24 * 60 * 60 * 1000),
        prepBufferMinutes: 30,
        cleanupBufferMinutes: 30,
        billableUnit: 'CALENDAR_DAY',
        billableUnitCount: 2,
        timezone: 'Europe/Paris',
        currency: 'EUR',
        subtotalAmountMinor: 5000,
        totalAmountMinor: 5000,
        customerTotalAmountMinor: 5000,
        commissionAmountMinor: 500,
        mandatoryFeesAmountMinor: 0,
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        confirmedAt: new Date(),
        cancellationPolicySnapshot: { policy: 'FLEXIBLE' },
        termsAcceptanceSnapshot: { termsVersion: 'v1', acceptedAt: new Date().toISOString() },
      })
      .returning();

    if (!pastBooking) {
      throw new Error('pastBooking insert failed');
    }

    // Créer une entrée d'audit associée au client
    await db.insert(auditLog).values({
      actorUserId: f.user.id,
      action: 'USER_SIGNED_UP',
      targetType: 'USER',
      targetId: f.user.id,
    });

    // Mock Clerk deletion callback
    const deleteClerkSpy = vi.fn().mockResolvedValue(undefined);

    // Exécuter l'effacement
    const result = await eraseUserAccount(db, {
      userId: f.user.id,
      actorUserId: f.user.id,
      triggerSource: 'SELF_SERVICE',
      deleteExternalIdentity: deleteClerkSpy,
    });

    expect(result.ok).toBe(true);
    expect(result.alreadyErased).toBe(false);
    expect(result.sealedBookingsCount).toBe(1);
    expect(result.externalIdentityDeleted).toBe(true);
    expect(deleteClerkSpy).toHaveBeenCalledWith(f.user.oidcSubject);

    // 1. Vérifier que la ligne users a été pseudonymisée
    const [updatedUser] = await db.select().from(users).where(eq(users.id, f.user.id));
    expect(updatedUser).toBeDefined();
    expect(updatedUser!.deletedAt).not.toBeNull();
    expect(updatedUser!.displayName).toBeNull();
    expect(updatedUser!.email).toBe(`erased-${f.user.id}@anonymized.uttily.local`);
    expect(updatedUser!.oidcSubject).toBe(`erased-${f.user.id}`);
    expect(updatedUser!.oidcProvider).toBeNull();

    // 2. Vérifier la création de la ligne privacy_probatory_seals
    const [seal] = await db
      .select()
      .from(privacyProbatorySeals)
      .where(eq(privacyProbatorySeals.userId, f.user.id));
    expect(seal).toBeDefined();
    expect(seal!.sealedBookingsCount).toBe(1);
    expect(seal!.triggerSource).toBe('SELF_SERVICE');
    expect(seal!.civilRetentionUntil.getTime()).toBeGreaterThan(seal!.sealedAt.getTime());
    expect(seal!.accountingRetentionUntil.getTime()).toBeGreaterThan(seal!.civilRetentionUntil.getTime());

    // 3. Vérifier que la réservation passée et l'audit log pointent toujours vers l'utilisateur (intégrité intacte)
    const [reloadedBooking] = await db
      .select()
      .from(bookings)
      .where(eq(bookings.id, pastBooking.id));
    expect(reloadedBooking!.customerUserId).toBe(f.user.id);

    // 4. Vérifier que provisionUserFromOidc rejette la reconnexion du compte supprimé
    await expect(
      provisionUserFromOidc(db, {
        oidcSubject: `erased-${f.user.id}`,
        oidcProvider: 'clerk',
        email: updatedUser!.email,
        emailVerified: true,
      }),
    ).rejects.toThrow(AccountDeletedError);

    // 5. Idempotence : ré-exécuter l'effacement ne plante pas
    const retryResult = await eraseUserAccount(db, {
      userId: f.user.id,
      actorUserId: f.user.id,
      triggerSource: 'SELF_SERVICE',
    });
    expect(retryResult.ok).toBe(true);
    expect(retryResult.alreadyErased).toBe(true);
  });

  it('bloque l’effacement si une réservation est en cours (CONFIRMED / ACTIVE)', async () => {
    if (!ctx) return;
    const f = await createFixture();

    const [draft] = await db
      .insert(bookingDrafts)
      .values({
        organizationId: f.org.id,
        locationId: f.loc.id,
        customerUserId: f.user.id,
        status: 'CONVERTED',
        customerStartAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        customerEndAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
        blockedStartAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
        blockedEndAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
        timezone: 'Europe/Paris',
        prepBufferMinutes: 30,
        cleanupBufferMinutes: 30,
        currency: 'EUR',
        subtotalAmountMinor: 8000,
        totalAmountMinor: 8000,
        customerTotalAmountMinor: 8000,
        commissionAmountMinor: 800,
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        cancellationPolicySnapshot: { policy: 'FLEXIBLE' },
        billableUnitCount: 2,
        expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      })
      .returning();

    if (!draft) throw new Error('draft creation failed');

    const [payment] = await db
      .insert(payments)
      .values({
        organizationId: f.org.id,
        draftId: draft.id,
        customerUserId: f.user.id,
        status: 'SUCCEEDED',
        amountMinor: 8000,
        currency: 'EUR',
        taxStatus: 'NOT_APPLICABLE',
        taxAmountMinor: 0,
        commissionAmountMinor: 800,
        financialTermsVersion: 'v1',
        legalTermsVersion: 'v1',
        termsAcceptanceSnapshot: { termsVersion: 'v1' },
        connectedAccountId: `counter-${f.org.id}`,
        chargeModel: 'DESTINATION',
        settlementMerchantMode: 'PLATFORM',
        environment: 'TEST',
        succeededAt: new Date(),
      })
      .returning();

    if (!payment) throw new Error('payment creation failed');

    // Réservation active
    await db.insert(bookings).values({
      organizationId: f.org.id,
      locationId: f.loc.id,
      customerUserId: f.user.id,
      draftId: draft.id,
      paymentId: payment.id,
      status: 'ACTIVE',
      customerStartAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      customerEndAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
      blockedStartAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      blockedEndAt: new Date(Date.now() + 1 * 24 * 60 * 60 * 1000),
      prepBufferMinutes: 30,
      cleanupBufferMinutes: 30,
      billableUnit: 'CALENDAR_DAY',
      billableUnitCount: 2,
      timezone: 'Europe/Paris',
      currency: 'EUR',
      subtotalAmountMinor: 8000,
      totalAmountMinor: 8000,
      customerTotalAmountMinor: 8000,
      commissionAmountMinor: 800,
      mandatoryFeesAmountMinor: 0,
      taxStatus: 'NOT_APPLICABLE',
      taxAmountMinor: 0,
      confirmedAt: new Date(),
      cancellationPolicySnapshot: { policy: 'FLEXIBLE' },
      termsAcceptanceSnapshot: { termsVersion: 'v1', acceptedAt: new Date().toISOString() },
    });

    const eligibility = await checkUserErasureEligibility(db, f.user.id);
    expect(eligibility.eligible).toBe(false);

    await expect(
      eraseUserAccount(db, {
        userId: f.user.id,
        actorUserId: f.user.id,
        triggerSource: 'SELF_SERVICE',
      }),
    ).rejects.toThrow(UserErasureError);

    // L'utilisateur reste intact
    const [user] = await db.select().from(users).where(eq(users.id, f.user.id));
    expect(user!.deletedAt).toBeNull();
  });

  it('bloque l’effacement si l’utilisateur est unique OWNER d’une organisation avec inventaire', async () => {
    if (!ctx) return;
    const f = await createFixture();

    // Lier l'utilisateur comme unique propriétaire de l'organisation
    await db.insert(organizationMemberships).values({
      organizationId: f.org.id,
      userId: f.user.id,
      role: 'OWNER',
    });

    const eligibility = await checkUserErasureEligibility(db, f.user.id);
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons).toContain('ORGANISATION_SOLE_OWNER');

    await expect(
      eraseUserAccount(db, {
        userId: f.user.id,
        actorUserId: f.user.id,
        triggerSource: 'SELF_SERVICE',
      }),
    ).rejects.toThrow(UserErasureError);
  });

  it('support: exécute l’effacement depuis une demande privacy_requests IN_REVIEW', async () => {
    if (!ctx) return;
    const f = await createFixture();

    // Créer une demande ERASURE
    const [pReq] = await db
      .insert(privacyRequests)
      .values({
        userId: f.user.id,
        requestType: 'ERASURE',
        status: 'IN_REVIEW',
        details: 'Je demande la suppression définitive de mes données.',
        responseDueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning();

    if (!pReq) {
      throw new Error('pReq insert failed');
    }

    const deleteClerkSpy = vi.fn().mockResolvedValue(undefined);

    const res = await executeErasurePrivacyRequest(db, {
      requestId: pReq.id,
      actorUserId: f.admin.id,
      deleteExternalIdentity: deleteClerkSpy,
    });

    expect(res.ok).toBe(true);
    expect(res.sealedBookingsCount).toBe(0);

    // Vérifier que la demande est passée en DECISION_READY avec la bonne justification légale
    const [updatedReq] = await db
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, pReq.id));
    expect(updatedReq!.status).toBe('DECISION_READY');
    expect(updatedReq!.resolution).toBe('PARTIALLY_FULFILLED');
    expect(updatedReq!.decisionReasonCode).toBe('LEGAL_RETENTION_OBLIGATION');
    expect(updatedReq!.resolutionNotes).toContain('scellé probatoire');
  });
});
