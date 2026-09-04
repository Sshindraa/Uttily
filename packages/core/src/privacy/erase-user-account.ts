import { and, count, eq, inArray, isNull, ne } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  bookingDrafts,
  bookings,
  documents,
  inventoryItems,
  organizationMemberships,
  payments,
  privacyProbatorySeals,
  privacyRequests,
  users,
} from '@uttily/database';
import { writeAuditEntry } from '../identity/audit';

export interface EraseUserAccountInput {
  readonly userId: string;
  readonly actorUserId: string;
  readonly triggerSource: 'SELF_SERVICE' | 'SUPPORT_REQUEST';
  readonly privacyRequestId?: string | null | undefined;
  readonly deleteExternalIdentity?: ((oidcSubject: string) => Promise<void>) | undefined;
}

export interface EraseUserAccountResult {
  readonly ok: true;
  readonly userId: string;
  readonly alreadyErased?: boolean;
  readonly sealedAt: Date;
  readonly civilRetentionUntil: Date;
  readonly accountingRetentionUntil: Date;
  readonly sealedBookingsCount: number;
  readonly sealedPaymentsCount: number;
  readonly sealedDocumentsCount: number;
  readonly externalIdentityDeleted: boolean;
}

export type UserErasureErrorCode =
  | 'USER_NOT_FOUND'
  | 'ACTIVE_BOOKINGS_EXIST'
  | 'HELD_DRAFTS_EXIST'
  | 'SOLE_ORG_OWNER_CONFLICT'
  | 'INVALID_INPUT';

export class UserErasureError extends Error {
  readonly code: UserErasureErrorCode;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: UserErasureErrorCode,
    message: string,
    details?: Record<string, unknown> | undefined,
  ) {
    super(message);
    this.name = 'UserErasureError';
    this.code = code;
    this.details = details;
  }
}

function addCalendarYears(baseDate: Date, years: number): Date {
  const d = new Date(baseDate.getTime());
  const originalDay = d.getUTCDate();
  d.setUTCFullYear(d.getUTCFullYear() + years);
  // Gestion d'un éventuel débordement bissextile (ex: 29 février + 5 ans -> 28 février)
  if (d.getUTCDate() !== originalDay) {
    d.setUTCDate(0);
  }
  return d;
}

/**
 * Vérifie l'éligibilité d'un utilisateur à l'effacement de son compte.
 * Retourne la liste des éventuels motifs bloquants sans altérer les données.
 */
export async function checkUserErasureEligibility(
  db: DatabaseClient,
  userId: string,
): Promise<{ eligible: boolean; reasons: string[] }> {
  const reasons: string[] = [];

  const [user] = await db
    .select({ id: users.id, deletedAt: users.deletedAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return { eligible: false, reasons: ['Utilisateur introuvable'] };
  }

  if (user.deletedAt !== null) {
    return { eligible: true, reasons: [] }; // Déjà effacé, no-op idempotent
  }

  // 1. Réservations en cours ou à venir
  const activeBookings = await db
    .select({ id: bookings.id })
    .from(bookings)
    .where(
      and(
        eq(bookings.customerUserId, userId),
        inArray(bookings.status, ['CONFIRMED', 'READY_FOR_PICKUP', 'ACTIVE']),
      ),
    );

  if (activeBookings.length > 0) {
    reasons.push(
      `Des réservations sont en cours ou à venir (${activeBookings.length} active(s)). Veuillez achever vos locations avant de supprimer votre compte.`,
    );
  }

  // 2. Brouillons de réservation en hold ou en cours de paiement
  const heldDrafts = await db
    .select({ id: bookingDrafts.id })
    .from(bookingDrafts)
    .where(
      and(
        eq(bookingDrafts.customerUserId, userId),
        inArray(bookingDrafts.status, ['HELD', 'PAYMENT_PROCESSING']),
      ),
    );

  if (heldDrafts.length > 0) {
    reasons.push(
      'Une réservation est en cours de retenue ou de paiement. Veuillez patienter ou annuler votre commande en cours.',
    );
  }

  // 3. Propriétaire unique d'une organisation ayant des équipements actifs
  const ownerMemberships = await db
    .select({ organizationId: organizationMemberships.organizationId })
    .from(organizationMemberships)
    .where(
      and(
        eq(organizationMemberships.userId, userId),
        eq(organizationMemberships.role, 'OWNER'),
        eq(organizationMemberships.status, 'ACTIVE'),
      ),
    );

  for (const m of ownerMemberships) {
    const [otherOwner] = await db
      .select({ id: organizationMemberships.userId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.organizationId, m.organizationId),
          eq(organizationMemberships.role, 'OWNER'),
          eq(organizationMemberships.status, 'ACTIVE'),
          ne(organizationMemberships.userId, userId),
        ),
      )
      .limit(1);

    if (!otherOwner) {
      const [activeItem] = await db
        .select({ id: inventoryItems.id })
        .from(inventoryItems)
        .where(
          and(
            eq(inventoryItems.organizationId, m.organizationId),
            eq(inventoryItems.status, 'ACTIVE'),
            isNull(inventoryItems.deletedAt),
          ),
        )
        .limit(1);

      if (activeItem) {
        reasons.push(
          'Vous êtes le seul propriétaire d’une organisation disposant d’équipements actifs. Veuillez désigner un autre propriétaire avant de supprimer votre compte.',
        );
        break;
      }
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
  };
}

/**
 * Exécute l'effacement RGPD d'un compte utilisateur avec neutralisation irréversible
 * de ses identifiants directs et scellement d'archive probatoire 5/10 ans (ADR-039).
 */
export async function eraseUserAccount(
  db: DatabaseClient,
  input: EraseUserAccountInput,
): Promise<EraseUserAccountResult> {
  const { userId, actorUserId, triggerSource, privacyRequestId, deleteExternalIdentity } = input;

  if (!userId || userId.trim().length === 0) {
    throw new UserErasureError('INVALID_INPUT', 'L’identifiant utilisateur est requis.');
  }

  let externalIdentityDeleted = false;

  const result = await db.transaction(async (tx) => {
    // 1. Verrou sur la ligne utilisateur
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for('update').limit(1);

    if (!user) {
      throw new UserErasureError('USER_NOT_FOUND', 'Utilisateur introuvable.');
    }

    // 2. Idempotence : si le compte est déjà effacé
    if (user.deletedAt !== null) {
      const [seal] = await tx
        .select()
        .from(privacyProbatorySeals)
        .where(eq(privacyProbatorySeals.userId, userId))
        .limit(1);

      const sealedAt = user.deletedAt;
      return {
        ok: true as const,
        userId,
        alreadyErased: true,
        sealedAt,
        civilRetentionUntil: seal?.civilRetentionUntil ?? addCalendarYears(sealedAt, 5),
        accountingRetentionUntil: seal?.accountingRetentionUntil ?? addCalendarYears(sealedAt, 10),
        sealedBookingsCount: seal?.sealedBookingsCount ?? 0,
        sealedPaymentsCount: seal?.sealedPaymentsCount ?? 0,
        sealedDocumentsCount: seal?.sealedDocumentsCount ?? 0,
        externalIdentityDeleted: true,
        externalSubjectToPurge: null as string | null,
      };
    }

    // 3. Validation des garde-fous bloquants
    const activeBookings = await tx
      .select({ id: bookings.id })
      .from(bookings)
      .where(
        and(
          eq(bookings.customerUserId, userId),
          inArray(bookings.status, ['CONFIRMED', 'READY_FOR_PICKUP', 'ACTIVE']),
        ),
      );

    if (activeBookings.length > 0) {
      throw new UserErasureError(
        'ACTIVE_BOOKINGS_EXIST',
        'Le compte ne peut pas être supprimé car des réservations sont en cours ou à venir. Veuillez terminer vos locations avant de supprimer votre compte.',
        { activeBookingIds: activeBookings.map((b) => b.id) },
      );
    }

    const heldDrafts = await tx
      .select({ id: bookingDrafts.id })
      .from(bookingDrafts)
      .where(
        and(
          eq(bookingDrafts.customerUserId, userId),
          inArray(bookingDrafts.status, ['HELD', 'PAYMENT_PROCESSING']),
        ),
      );

    if (heldDrafts.length > 0) {
      throw new UserErasureError(
        'HELD_DRAFTS_EXIST',
        'Une réservation est en cours de retenue ou de paiement. Veuillez patienter ou annuler votre commande en cours.',
        { draftIds: heldDrafts.map((d) => d.id) },
      );
    }

    const ownerMemberships = await tx
      .select({ organizationId: organizationMemberships.organizationId })
      .from(organizationMemberships)
      .where(
        and(
          eq(organizationMemberships.userId, userId),
          eq(organizationMemberships.role, 'OWNER'),
          eq(organizationMemberships.status, 'ACTIVE'),
        ),
      );

    for (const m of ownerMemberships) {
      const [otherOwner] = await tx
        .select({ id: organizationMemberships.userId })
        .from(organizationMemberships)
        .where(
          and(
            eq(organizationMemberships.organizationId, m.organizationId),
            eq(organizationMemberships.role, 'OWNER'),
            eq(organizationMemberships.status, 'ACTIVE'),
            ne(organizationMemberships.userId, userId),
          ),
        )
        .limit(1);

      if (!otherOwner) {
        const [activeItem] = await tx
          .select({ id: inventoryItems.id })
          .from(inventoryItems)
          .where(
            and(
              eq(inventoryItems.organizationId, m.organizationId),
              eq(inventoryItems.status, 'ACTIVE'),
              isNull(inventoryItems.deletedAt),
            ),
          )
          .limit(1);

        if (activeItem) {
          throw new UserErasureError(
            'SOLE_ORG_OWNER_CONFLICT',
            'Vous êtes le seul propriétaire d’une organisation disposant d’équipements actifs. Veuillez désigner un autre propriétaire ou retirer vos équipements avant de supprimer votre compte.',
            { organizationId: m.organizationId },
          );
        }
      }
    }

    // 4. Décompte des pièces sous scellé probatoire
    const [bCount] = await tx
      .select({ count: count() })
      .from(bookings)
      .where(eq(bookings.customerUserId, userId));
    const sealedBookingsCount = bCount?.count ? Number(bCount.count) : 0;

    const [pCount] = await tx
      .select({ count: count() })
      .from(payments)
      .innerJoin(bookings, eq(payments.id, bookings.paymentId))
      .where(eq(bookings.customerUserId, userId));
    const sealedPaymentsCount = pCount?.count ? Number(pCount.count) : 0;

    const [dCount] = await tx
      .select({ count: count() })
      .from(documents)
      .innerJoin(bookings, eq(documents.bookingId, bookings.id))
      .where(eq(bookings.customerUserId, userId));
    const sealedDocumentsCount = dCount?.count ? Number(dCount.count) : 0;

    // 5. Calcul des échéances légales (DPO-003, ADR-039)
    const now = new Date();
    const civilRetentionUntil = addCalendarYears(now, 5); // Prescription civile Art. 2224 Code civil
    const accountingRetentionUntil = addCalendarYears(now, 10); // Rétention comptable Art. L. 123-22 Code de commerce

    const externalSubjectToPurge = user.oidcSubject;

    // 6. Neutralisation irréversible des identifiants dans users
    const tombstoneEmail = `erased-${user.id}@anonymized.uttily.local`;
    const tombstoneSubject = `erased-${user.id}`;

    await tx
      .update(users)
      .set({
        email: tombstoneEmail,
        displayName: null,
        oidcSubject: tombstoneSubject,
        oidcProvider: null,
        isPlatformAdmin: false,
        deletedAt: now,
        updatedAt: now,
      })
      .where(eq(users.id, user.id));

    // 7. Révocation des appartenances
    await tx
      .update(organizationMemberships)
      .set({
        status: 'REMOVED',
        updatedAt: now,
      })
      .where(eq(organizationMemberships.userId, user.id));

    // 8. Insertion du registre de scellement probatoire
    await tx.insert(privacyProbatorySeals).values({
      userId: user.id,
      sealedAt: now,
      civilRetentionUntil,
      accountingRetentionUntil,
      sealedBookingsCount,
      sealedPaymentsCount,
      sealedDocumentsCount,
      triggerSource,
      privacyRequestId: privacyRequestId ?? null,
    });

    // 9. Journal d'audit sans PII
    await writeAuditEntry(tx, {
      actorUserId,
      action: 'PRIVACY_USER_ACCOUNT_ERASED',
      targetType: 'USER',
      targetId: user.id,
      metadata: {
        erasedUserId: user.id,
        triggerSource,
        privacyRequestId: privacyRequestId ?? null,
        sealedBookingsCount,
        sealedPaymentsCount,
        sealedDocumentsCount,
        civilRetentionUntil: civilRetentionUntil.toISOString(),
        accountingRetentionUntil: accountingRetentionUntil.toISOString(),
      },
    });

    // 10. Mise à jour de la demande RGPD associée si existante
    if (privacyRequestId) {
      const [pReq] = await tx
        .select()
        .from(privacyRequests)
        .where(eq(privacyRequests.id, privacyRequestId))
        .for('update')
        .limit(1);

      if (pReq && pReq.status === 'IN_REVIEW') {
        await tx
          .update(privacyRequests)
          .set({
            status: 'DECISION_READY',
            resolution: 'PARTIALLY_FULFILLED',
            decisionReasonCode: 'LEGAL_RETENTION_OBLIGATION',
            resolutionNotes:
              'Compte utilisateur supprimé et pseudonymisé. Données contractuelles (5 ans, Art. 2224 Code civil) et pièces comptables (10 ans, Art. L. 123-22 Code de commerce) conservées sous scellé probatoire conformément à DPO-003 et ADR-039.',
            decisionAt: now,
            decisionByUserId: actorUserId,
            updatedAt: now,
          })
          .where(eq(privacyRequests.id, privacyRequestId));
      }
    }

    return {
      ok: true as const,
      userId,
      alreadyErased: false,
      sealedAt: now,
      civilRetentionUntil,
      accountingRetentionUntil,
      sealedBookingsCount,
      sealedPaymentsCount,
      sealedDocumentsCount,
      externalIdentityDeleted: false,
      externalSubjectToPurge,
    };
  });

  // 11. Purge de l'identité externe dans Clerk (hors transaction locale)
  if (
    deleteExternalIdentity &&
    result.externalSubjectToPurge &&
    !result.externalSubjectToPurge.startsWith('erased-')
  ) {
    try {
      await deleteExternalIdentity(result.externalSubjectToPurge);
      externalIdentityDeleted = true;
    } catch (clerkErr) {
      // Si déjà supprimé (404), on considère la suppression comme effective.
      const isNotFound =
        clerkErr instanceof Error &&
        (clerkErr.message.includes('404') || clerkErr.message.toLowerCase().includes('not found'));
      externalIdentityDeleted = isNotFound;
    }
  }

  return {
    ok: result.ok,
    userId: result.userId,
    alreadyErased: result.alreadyErased,
    sealedAt: result.sealedAt,
    civilRetentionUntil: result.civilRetentionUntil,
    accountingRetentionUntil: result.accountingRetentionUntil,
    sealedBookingsCount: result.sealedBookingsCount,
    sealedPaymentsCount: result.sealedPaymentsCount,
    sealedDocumentsCount: result.sealedDocumentsCount,
    externalIdentityDeleted: result.alreadyErased ? true : externalIdentityDeleted,
  };
}
