import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  setupIntegrationTestDb,
  shouldSkipIntegrationTests,
  type IntegrationTestContext,
} from './setup';
import { createDatabase, users, privacyRequests, auditLog } from '@uttily/database';
import {
  startPrivacyRequestReview,
  flagPrivacyRequestIdentityCheck,
  extendPrivacyRequestDeadline,
  recordExtensionNotification,
  recordPrivacyDecision,
  recordPrivacyResponseNotification,
  resolvePrivacyRequest,
  listPrivacyRequestsSupport,
  PrivacySupportActionError,
} from '../index';

describe('Lot 21-P1A — Concurrence, Invariants & Clôture RGPD (Integration)', () => {
  if (shouldSkipIntegrationTests()) {
    it.skip('PostgreSQL integration tests skippés (DATABASE_URL absente ou SKIP_INTEGRATION_TESTS=1)', () => {});
    return;
  }

  let ctx: IntegrationTestContext | null = null;
  let dbA: ReturnType<typeof createDatabase>;
  let dbB: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    ctx = await setupIntegrationTestDb('privacy_concurrency');
    if (ctx) {
      dbA = createDatabase(ctx.databaseUrl);
      dbB = createDatabase(ctx.databaseUrl);
    }
  });

  afterAll(async () => {
    if (ctx) {
      await ctx.cleanup();
    }
  });

  async function createTestFixture() {
    const [clientUser] = await dbA
      .insert(users)
      .values({
        email: `client-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
        displayName: 'Client Test',
      })
      .returning();

    const [adminUser] = await dbA
      .insert(users)
      .values({
        email: `admin-${Date.now()}-${Math.random().toString(36).slice(2)}@uttily.com`,
        displayName: 'Admin DPO',
        isPlatformAdmin: true,
      })
      .returning();

    const [req] = await dbA
      .insert(privacyRequests)
      .values({
        userId: clientUser!.id,
        requestType: 'ERASURE',
        status: 'RECEIVED',
        details: 'Demande d’effacement',
        responseDueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      })
      .returning();

    return { clientUser: clientUser!, adminUser: adminUser!, request: req! };
  }

  it('P1.1 — Concurrence réelle : deux connexions simultanées ne peuvent pas écraser une décision', async () => {
    const { adminUser, request } = await createTestFixture();

    await startPrivacyRequestReview(dbA, {
      requestId: request.id,
      actorUserId: adminUser.id,
    });

    // Opérateur A (dbA) et Opérateur B (dbB) tentent simultanément deux décisions divergentes
    const results = await Promise.allSettled([
      recordPrivacyDecision(dbA, {
        requestId: request.id,
        actorUserId: adminUser.id,
        resolution: 'FULFILLED',
        resolutionNotes: 'Données supprimées après validation',
      }),
      recordPrivacyDecision(dbB, {
        requestId: request.id,
        actorUserId: adminUser.id,
        resolution: 'REFUSED',
        decisionReasonCode: 'LEGAL_RETENTION_OBLIGATION',
        resolutionNotes: 'Refus : factures sous délai de conservation légale',
      }),
    ]);

    const succeeded = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    const failureReason = (rejected[0] as PromiseRejectedResult).reason;
    expect(failureReason).toBeInstanceOf(PrivacySupportActionError);
    expect(failureReason.code).toBe('INVALID_STATE_TRANSITION');

    const [finalRow] = await dbA
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, request.id));

    expect(finalRow!.status).toBe('DECISION_READY');
    expect(['FULFILLED', 'REFUSED']).toContain(finalRow!.resolution);

    const auditEntries = await dbA.select().from(auditLog).where(eq(auditLog.targetId, request.id));

    const decisionAudits = auditEntries.filter(
      (a) => a.action === 'PRIVACY_REQUEST_DECISION_RECORDED',
    );
    expect(decisionAudits).toHaveLength(1);
  });

  it('P1.2 — Rollback transactionnel complet si l’audit échoue', async () => {
    const { request } = await createTestFixture();

    let errorCaught = false;
    try {
      await dbA.transaction(async (tx) => {
        await tx
          .update(privacyRequests)
          .set({
            status: 'IN_REVIEW',
            updatedAt: new Date(),
          })
          .where(eq(privacyRequests.id, request.id));

        throw new Error('SIMULATED_AUDIT_FAILURE');
      });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === 'SIMULATED_AUDIT_FAILURE') {
        errorCaught = true;
      }
    }

    expect(errorCaught).toBe(true);

    const [rowAfterRollback] = await dbA
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, request.id));

    expect(rowAfterRollback!.status).toBe('RECEIVED');
  });

  it('P1.3 — Notification tardive (> responseDueAt) : ne régularise JAMAIS rétroactivement le délai initial', async () => {
    const { adminUser, clientUser } = await createTestFixture();

    const pastReceived = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
    const pastDue = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const futureExtension = new Date(Date.now() + 25 * 24 * 60 * 60 * 1000);

    const [expiredReq] = await dbA
      .insert(privacyRequests)
      .values({
        userId: clientUser.id,
        requestType: 'ACCESS',
        status: 'IN_REVIEW',
        details: 'Demande d’accès',
        receivedAt: pastReceived,
        responseDueAt: pastDue,
        extendedUntil: futureExtension,
        extensionReason: 'Recherche archives complexes',
        extendedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000),
        extendedByUserId: adminUser.id,
        // Information demandeur enregistrée AUJOURD'HUI (> pastDue)
        extensionNotifiedAt: new Date(),
      })
      .returning();

    const result = await listPrivacyRequestsSupport(dbA, { tab: 'ACTIVE' });
    const item = result.items.find((i) => i.id === expiredReq!.id);

    expect(item).toBeDefined();
    expect(item!.extensionCompliance).toBe('NOTIFIED_LATE');
    expect(item!.effectiveDueAt.getTime()).toBe(pastDue.getTime());
    expect(item!.urgency).toBe('DUE_OVERDUE');
  });

  it('P1.4 — Distinction stricte Décision interne vs Réponse communiquée (Art. 12.3 & 12.4 RGPD)', async () => {
    const { adminUser, request } = await createTestFixture();

    // 1. Passage en IN_REVIEW
    await startPrivacyRequestReview(dbA, {
      requestId: request.id,
      actorUserId: adminUser.id,
    });

    // Tentative d'attester de la réponse avant que la décision soit prête -> REJET
    await expect(
      recordPrivacyResponseNotification(dbA, {
        requestId: request.id,
        actorUserId: adminUser.id,
      }),
    ).rejects.toThrow(
      'Une décision interne motivée (DECISION_READY) doit être préalablement arrêtée',
    );

    // 2. Décision interne arrêtée -> passe en DECISION_READY
    const decisionRes = await recordPrivacyDecision(dbA, {
      requestId: request.id,
      actorUserId: adminUser.id,
      resolution: 'REFUSED',
      decisionReasonCode: 'LEGAL_RETENTION_OBLIGATION',
      resolutionNotes: 'Factures conservées 10 ans selon Code de commerce L123-22',
    });
    expect(decisionRes.status).toBe('DECISION_READY');
    expect(decisionRes.resolution).toBe('REFUSED');

    // La demande reste ACTIVE dans le cockpit (la personne n'a pas encore été informée !)
    const activeList = await listPrivacyRequestsSupport(dbA, { tab: 'ACTIVE' });
    const activeItem = activeList.items.find((i) => i.id === request.id);
    expect(activeItem).toBeDefined();
    expect(activeItem!.status).toBe('DECISION_READY');
    expect(activeItem!.resolution).toBe('REFUSED');

    // 3. Attestation de l'envoi de la réponse au demandeur -> passe en COMPLETED
    const firstNotifiedDate = new Date('2026-09-15T14:00:00Z');
    const responseRes = await recordPrivacyResponseNotification(dbA, {
      requestId: request.id,
      actorUserId: adminUser.id,
      responseNotifiedAt: firstNotifiedDate,
    });
    expect(responseRes.status).toBe('COMPLETED');
    expect(responseRes.responseNotifiedAt.toISOString()).toBe(firstNotifiedDate.toISOString());

    // La demande est maintenant clôturée (CLOSED)
    const closedList = await listPrivacyRequestsSupport(dbA, { tab: 'CLOSED' });
    const closedItem = closedList.items.find((i) => i.id === request.id);
    expect(closedItem).toBeDefined();
    expect(closedItem!.status).toBe('COMPLETED');
    expect(closedItem!.resolvedAt?.toISOString()).toBe(firstNotifiedDate.toISOString());

    // 4. Idempotence : un second appel conserve impérativement firstNotifiedDate et n'émet aucun nouvel audit
    const retryRes = await recordPrivacyResponseNotification(dbB, {
      requestId: request.id,
      actorUserId: adminUser.id,
      responseNotifiedAt: new Date('2026-09-25T18:00:00Z'), // Date ultérieure ignorée
    });
    expect(retryRes.responseNotifiedAt.toISOString()).toBe(firstNotifiedDate.toISOString());

    const audits = await dbA.select().from(auditLog).where(eq(auditLog.targetId, request.id));

    expect(audits.filter((a) => a.action === 'PRIVACY_REQUEST_COMPLETED')).toHaveLength(1);
  });

  it('P2.1 — Invariants structurels PostgreSQL (CHECK privacy_requests_decision_consistency)', async () => {
    const { clientUser, adminUser } = await createTestFixture();
    const baseDue = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    // Invariant A : status = 'COMPLETED' sans response_notified_at -> REJET
    await expect(
      dbA.insert(privacyRequests).values({
        userId: clientUser.id,
        requestType: 'ACCESS',
        status: 'COMPLETED',
        resolution: 'FULFILLED',
        decisionAt: new Date(),
        decisionByUserId: adminUser.id,
        responseDueAt: baseDue,
        responseNotifiedAt: null, // Violation
        resolvedAt: new Date(),
      }),
    ).rejects.toThrow();

    // Invariant B : status = 'COMPLETED' sans resolution -> REJET
    await expect(
      dbA.insert(privacyRequests).values({
        userId: clientUser.id,
        requestType: 'ACCESS',
        status: 'COMPLETED',
        resolution: null, // Violation
        decisionAt: new Date(),
        decisionByUserId: adminUser.id,
        responseDueAt: baseDue,
        responseNotifiedAt: new Date(),
        responseNotifiedByUserId: adminUser.id,
        resolvedAt: new Date(),
      }),
    ).rejects.toThrow();

    // Invariant C : resolution = 'REFUSED' sans decision_reason_code -> REJET
    await expect(
      dbA.insert(privacyRequests).values({
        userId: clientUser.id,
        requestType: 'ACCESS',
        status: 'DECISION_READY',
        resolution: 'REFUSED',
        decisionReasonCode: null, // Violation (Art. 12.4 RGPD)
        decisionAt: new Date(),
        decisionByUserId: adminUser.id,
        responseDueAt: baseDue,
      }),
    ).rejects.toThrow();

    // Invariant D : status = 'DECISION_READY' avec response_notified_at présent -> REJET
    await expect(
      dbA.insert(privacyRequests).values({
        userId: clientUser.id,
        requestType: 'ACCESS',
        status: 'DECISION_READY',
        resolution: 'FULFILLED',
        decisionAt: new Date(),
        decisionByUserId: adminUser.id,
        responseDueAt: baseDue,
        responseNotifiedAt: new Date(), // Violation : doit être COMPLETED
      }),
    ).rejects.toThrow();

    // Invariant E : status = 'RECEIVED' avec resolution présente -> REJET
    await expect(
      dbA.insert(privacyRequests).values({
        userId: clientUser.id,
        requestType: 'ACCESS',
        status: 'RECEIVED',
        resolution: 'FULFILLED', // Violation
        responseDueAt: baseDue,
      }),
    ).rejects.toThrow();
  });

  it('P2.2 — Parité stricte des calculs calendaires : TypeScript addCalendarMonths vs PostgreSQL interval 2 months', async () => {
    const { clientUser, adminUser } = await createTestFixture();

    // Dates charnières : fins de mois et années bissextiles
    const testDates = [
      new Date('2024-01-31T12:00:00Z'), // Année bissextile (février à 29 jours) -> 31 mars
      new Date('2025-01-31T12:00:00Z'), // Année non bissextile -> 31 mars
      new Date('2026-03-31T12:00:00Z'), // Fin mars -> 31 mai
      new Date('2026-05-31T12:00:00Z'), // Fin mai -> 31 juillet
      new Date('2026-08-31T12:00:00Z'), // Fin août -> 31 octobre
      new Date('2026-10-31T12:00:00Z'), // Fin octobre -> 31 décembre
    ];

    for (const baseDate of testDates) {
      // 1. Calcul PostgreSQL : baseDate + interval '2 months'
      const [pgRow] = await dbA.execute<{ pg_limit: Date }>(
        sql`SELECT (${baseDate.toISOString()}::timestamptz + interval '2 months') as pg_limit`,
      );
      const pgLimit = new Date(pgRow!.pg_limit);

      // 2. Insertion de la date limite exacte : DOIT être acceptée par le CHECK PostgreSQL
      const [created] = await dbA
        .insert(privacyRequests)
        .values({
          userId: clientUser.id,
          requestType: 'ACCESS',
          status: 'IN_REVIEW',
          responseDueAt: baseDate,
          extendedUntil: pgLimit,
          extensionReason: 'Prorogation calendaire',
          extendedAt: new Date(),
          extendedByUserId: adminUser.id,
        })
        .returning();

      expect(created).toBeDefined();

      // 3. Insertion d'une date dépassant ne serait-ce que d'une seconde : DOIT être rejetée
      const oneSecondBeyond = new Date(pgLimit.getTime() + 1000);
      await expect(
        dbA.insert(privacyRequests).values({
          userId: clientUser.id,
          requestType: 'ACCESS',
          status: 'IN_REVIEW',
          responseDueAt: baseDate,
          extendedUntil: oneSecondBeyond,
          extensionReason: 'Dépassement interdit',
          extendedAt: new Date(),
          extendedByUserId: adminUser.id,
        }),
      ).rejects.toThrow();
    }
  });

  it('P2.3 — Idempotence exhaustive des mutations de traitement et préservation historique', async () => {
    const { adminUser, request } = await createTestFixture();

    // 1. flagPrivacyRequestIdentityCheck : répétition sans 2e audit
    await flagPrivacyRequestIdentityCheck(dbA, {
      requestId: request.id,
      actorUserId: adminUser.id,
    });
    const flagRetry = await flagPrivacyRequestIdentityCheck(dbB, {
      requestId: request.id,
      actorUserId: adminUser.id,
    });
    expect(flagRetry.status).toBe('IDENTITY_CHECK_REQUIRED');

    // 2. Passage à IN_REVIEW
    await startPrivacyRequestReview(dbA, {
      requestId: request.id,
      actorUserId: adminUser.id,
    });

    // 3. extendPrivacyRequestDeadline : rejeu identique vs modification interdite
    const extensionDate = new Date(request.responseDueAt.getTime() + 20 * 24 * 60 * 60 * 1000);
    const ext1 = await extendPrivacyRequestDeadline(dbA, {
      requestId: request.id,
      actorUserId: adminUser.id,
      extendedUntil: extensionDate,
      reason: 'Volume archives',
    });
    expect(ext1.ok).toBe(true);

    const extRetry = await extendPrivacyRequestDeadline(dbB, {
      requestId: request.id,
      actorUserId: adminUser.id,
      extendedUntil: extensionDate,
      reason: 'Volume archives',
    });
    expect(extRetry.ok).toBe(true);

    // Tentative de re-prorogation ou motif divergent -> conflit
    await expect(
      extendPrivacyRequestDeadline(dbA, {
        requestId: request.id,
        actorUserId: adminUser.id,
        extendedUntil: new Date(extensionDate.getTime() + 5 * 24 * 60 * 60 * 1000),
        reason: 'Autre motif',
      }),
    ).rejects.toThrow('déjà fait l’objet d’une prorogation');

    // 4. recordExtensionNotification : conservation du premier timestamp
    const firstExtNotif = new Date('2026-09-10T09:00:00Z');
    const notif1 = await recordExtensionNotification(dbA, {
      requestId: request.id,
      actorUserId: adminUser.id,
      notifiedAt: firstExtNotif,
    });
    expect(notif1.notifiedAt.toISOString()).toBe(firstExtNotif.toISOString());

    const notifRetry = await recordExtensionNotification(dbB, {
      requestId: request.id,
      actorUserId: adminUser.id,
      notifiedAt: new Date('2026-09-12T10:00:00Z'), // Date ultérieure ignorée
    });
    expect(notifRetry.notifiedAt.toISOString()).toBe(firstExtNotif.toISOString());

    // 5. resolvePrivacyRequest (alias de recordPrivacyDecision) : idempotence
    const resolve1 = await resolvePrivacyRequest(dbA, {
      requestId: request.id,
      actorUserId: adminUser.id,
      resolutionStatus: 'FULFILLED',
      resolutionNotes: 'Données supprimées avec succès',
    });
    expect(resolve1.status).toBe('DECISION_READY');
    expect(resolve1.resolution).toBe('FULFILLED');

    const resolveRetry = await resolvePrivacyRequest(dbB, {
      requestId: request.id,
      actorUserId: adminUser.id,
      resolutionStatus: 'FULFILLED',
      resolutionNotes: 'Données supprimées avec succès',
    });
    expect(resolveRetry.status).toBe('DECISION_READY');

    // Comptage des audits pour vérifier l'absence absolue de doublon
    const audits = await dbA.select().from(auditLog).where(eq(auditLog.targetId, request.id));

    expect(
      audits.filter((a) => a.action === 'PRIVACY_REQUEST_IDENTITY_CHECK_REQUIRED'),
    ).toHaveLength(1);
    expect(audits.filter((a) => a.action === 'PRIVACY_REQUEST_DEADLINE_EXTENDED')).toHaveLength(1);
    expect(audits.filter((a) => a.action === 'PRIVACY_REQUEST_EXTENSION_NOTIFIED')).toHaveLength(1);
    expect(audits.filter((a) => a.action === 'PRIVACY_REQUEST_DECISION_RECORDED')).toHaveLength(1);
  });

  it('P2.4 — Invariant de traçabilité : une demande répondue hors délai conserve durablement RESPONSE_LATE en COMPLETED', async () => {
    const { adminUser, clientUser } = await createTestFixture();

    const pastReceived = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000);
    const pastDue = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);

    // Demande répondue AUJOURD'HUI (> pastDue)
    const [lateReq] = await dbA
      .insert(privacyRequests)
      .values({
        userId: clientUser.id,
        requestType: 'RECTIFICATION',
        status: 'COMPLETED',
        resolution: 'FULFILLED',
        decisionAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000),
        decisionByUserId: adminUser.id,
        receivedAt: pastReceived,
        responseDueAt: pastDue,
        responseNotifiedAt: new Date(),
        responseNotifiedByUserId: adminUser.id,
        resolvedAt: new Date(),
      })
      .returning();

    const closedList = await listPrivacyRequestsSupport(dbA, { tab: 'CLOSED' });
    const lateItem = closedList.items.find((i) => i.id === lateReq!.id);

    expect(lateItem).toBeDefined();
    expect(lateItem!.status).toBe('COMPLETED');
    expect(lateItem!.responseCompliance).toBe('RESPONSE_LATE');
  });
});
