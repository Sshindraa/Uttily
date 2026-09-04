import { eq } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { privacyRequests } from '@uttily/database';
import { writeAuditEntry } from '../../identity/audit';
import {
  type ExtendPrivacyDeadlineInput,
  type FlagPrivacyIdentityCheckInput,
  type RecordExtensionNotificationInput,
  type RecordPrivacyDecisionInput,
  type RecordPrivacyResponseNotificationInput,
  type ResolvePrivacyRequestInput,
  type StartPrivacyReviewInput,
  PrivacySupportActionError,
} from './types';
import { eraseUserAccount, type EraseUserAccountResult } from '../../privacy/erase-user-account';

const VALID_RESOLUTIONS = ['FULFILLED', 'PARTIALLY_FULFILLED', 'REFUSED'] as const;

/**
 * 1. Prise en charge d'une demande par l'opérateur (passage à IN_REVIEW).
 * - Concurrence : verrou transactionnel FOR UPDATE.
 * - Idempotence : si déjà IN_REVIEW, retour sans second audit.
 */
export async function startPrivacyRequestReview(
  db: DatabaseClient,
  input: StartPrivacyReviewInput,
): Promise<{ ok: true; requestId: string; status: 'IN_REVIEW' }> {
  const { requestId, actorUserId } = input;

  return db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, requestId))
      .for('update')
      .limit(1);

    if (!req) {
      throw new PrivacySupportActionError('NOT_FOUND', 'Demande RGPD introuvable.');
    }

    // Idempotence : si déjà IN_REVIEW, convergence sans duplication d'audit
    if (req.status === 'IN_REVIEW') {
      return { ok: true, requestId, status: 'IN_REVIEW' };
    }

    if (req.status !== 'RECEIVED' && req.status !== 'IDENTITY_CHECK_REQUIRED') {
      throw new PrivacySupportActionError(
        'INVALID_STATE_TRANSITION',
        `La demande ne peut être prise en charge que depuis RECEIVED ou IDENTITY_CHECK_REQUIRED (statut actuel : ${req.status}).`,
      );
    }

    const now = new Date();
    await tx
      .update(privacyRequests)
      .set({
        status: 'IN_REVIEW',
        updatedAt: now,
      })
      .where(eq(privacyRequests.id, requestId));

    await writeAuditEntry(tx, {
      actorUserId,
      action: 'PRIVACY_REQUEST_REVIEW_STARTED',
      targetType: 'PRIVACY_REQUEST',
      targetId: requestId,
      metadata: {
        requestId,
        previousStatus: req.status,
        newStatus: 'IN_REVIEW',
      },
    });

    return { ok: true, requestId, status: 'IN_REVIEW' };
  });
}

/**
 * 2. Signalement d'une vérification d'identité requise (doute raisonnable, Art. 12.6 RGPD).
 * - Concurrence : verrou transactionnel FOR UPDATE.
 * - Idempotence : si déjà IDENTITY_CHECK_REQUIRED, retour sans second audit.
 */
export async function flagPrivacyRequestIdentityCheck(
  db: DatabaseClient,
  input: FlagPrivacyIdentityCheckInput,
): Promise<{ ok: true; requestId: string; status: 'IDENTITY_CHECK_REQUIRED' }> {
  const { requestId, actorUserId } = input;

  return db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, requestId))
      .for('update')
      .limit(1);

    if (!req) {
      throw new PrivacySupportActionError('NOT_FOUND', 'Demande RGPD introuvable.');
    }

    // Idempotence : si déjà dans cet état, pas de duplication d'audit
    if (req.status === 'IDENTITY_CHECK_REQUIRED') {
      return { ok: true, requestId, status: 'IDENTITY_CHECK_REQUIRED' };
    }

    if (req.status !== 'RECEIVED') {
      throw new PrivacySupportActionError(
        'INVALID_STATE_TRANSITION',
        `La vérification d’identité ne peut être demandée que pour une demande en statut RECEIVED (statut actuel : ${req.status}).`,
      );
    }

    const now = new Date();
    await tx
      .update(privacyRequests)
      .set({
        status: 'IDENTITY_CHECK_REQUIRED',
        updatedAt: now,
      })
      .where(eq(privacyRequests.id, requestId));

    await writeAuditEntry(tx, {
      actorUserId,
      action: 'PRIVACY_REQUEST_IDENTITY_CHECK_REQUIRED',
      targetType: 'PRIVACY_REQUEST',
      targetId: requestId,
      metadata: {
        requestId,
        previousStatus: req.status,
        newStatus: 'IDENTITY_CHECK_REQUIRED',
      },
    });

    return { ok: true, requestId, status: 'IDENTITY_CHECK_REQUIRED' };
  });
}

function addCalendarMonths(baseDate: Date, months: number): Date {
  const d = new Date(baseDate.getTime());
  const originalDay = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  // Gestion du débordement calendaire en fin de mois (ex: 31 janvier + 1 mois -> 28/29 février)
  if (d.getUTCDate() !== originalDay) {
    d.setUTCDate(0);
  }
  return d;
}

/**
 * 3. Prolongation d'échéance légale (+2 mois max selon Art. 12.3 RGPD).
 * - Concurrence : verrou transactionnel FOR UPDATE.
 * - Idempotence : si prorogation identique déjà enregistrée, retour sans second audit.
 * - Conflit : tentative de repousser à nouveau ou de modifier une prorogation déjà arrêtée.
 */
export async function extendPrivacyRequestDeadline(
  db: DatabaseClient,
  input: ExtendPrivacyDeadlineInput,
): Promise<{ ok: true; requestId: string; extendedUntil: Date }> {
  const { requestId, actorUserId, extendedUntil, reason, notifiedAt } = input;

  if (!reason || reason.trim().length === 0) {
    throw new PrivacySupportActionError(
      'EXTENSION_REASON_REQUIRED',
      'Un motif interne est obligatoire pour prolonger l’échéance légale.',
    );
  }

  return db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, requestId))
      .for('update')
      .limit(1);

    if (!req) {
      throw new PrivacySupportActionError('NOT_FOUND', 'Demande RGPD introuvable.');
    }

    // Idempotence & Conflit si déjà prorogée
    if (req.extendedUntil) {
      if (
        req.extendedUntil.getTime() === extendedUntil.getTime() &&
        req.extensionReason === reason
      ) {
        return { ok: true, requestId, extendedUntil };
      }
      throw new PrivacySupportActionError(
        'INVALID_STATE_TRANSITION',
        'Cette demande a déjà fait l’objet d’une prorogation d’échéance.',
      );
    }

    if (req.status !== 'IN_REVIEW') {
      throw new PrivacySupportActionError(
        'INVALID_STATE_TRANSITION',
        `Seule une demande en cours d’instruction (IN_REVIEW) peut être prolongée (statut actuel : ${req.status}).`,
      );
    }

    if (extendedUntil.getTime() <= req.responseDueAt.getTime()) {
      throw new PrivacySupportActionError(
        'INVALID_EXTENSION_DATE',
        'La date de prolongation doit être strictement postérieure à l’échéance initiale.',
      );
    }

    // RGPD Art. 12(3) : max 2 mois calendaires supplémentaires depuis l'échéance nominale
    const maxAllowedDate = addCalendarMonths(req.responseDueAt, 2);
    if (extendedUntil.getTime() > maxAllowedDate.getTime()) {
      throw new PrivacySupportActionError(
        'INVALID_EXTENSION_DATE',
        'La prolongation légale ne peut pas excéder deux mois calendaires supplémentaires (Art. 12.3 RGPD).',
      );
    }

    const now = new Date();
    await tx
      .update(privacyRequests)
      .set({
        extendedUntil,
        extensionReason: reason,
        extendedAt: now,
        extendedByUserId: actorUserId,
        extensionNotifiedAt: notifiedAt ?? null,
        updatedAt: now,
      })
      .where(eq(privacyRequests.id, requestId));

    await writeAuditEntry(tx, {
      actorUserId,
      action: 'PRIVACY_REQUEST_DEADLINE_EXTENDED',
      targetType: 'PRIVACY_REQUEST',
      targetId: requestId,
      metadata: {
        requestId,
        previousDueAt: req.responseDueAt.toISOString(),
        extendedUntil: extendedUntil.toISOString(),
        notified: Boolean(notifiedAt),
      },
    });

    return { ok: true, requestId, extendedUntil };
  });
}

/**
 * 4. Consignation de l'attestation opérateur d'information du demandeur (Art. 12.3 RGPD).
 * Règle d'or : le SLA effectif n'est prolongé que lorsque cette attestation est actée dans le premier mois.
 * Idempotence : préserve impérativement le premier timestamp historique pour sa force probante.
 */
export async function recordExtensionNotification(
  db: DatabaseClient,
  input: RecordExtensionNotificationInput,
): Promise<{ ok: true; requestId: string; notifiedAt: Date }> {
  const { requestId, actorUserId, notifiedAt = new Date() } = input;

  return db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, requestId))
      .for('update')
      .limit(1);

    if (!req) {
      throw new PrivacySupportActionError('NOT_FOUND', 'Demande RGPD introuvable.');
    }

    if (!req.extendedUntil) {
      throw new PrivacySupportActionError(
        'INVALID_STATE_TRANSITION',
        'Aucune prorogation n’a été enregistrée pour cette demande.',
      );
    }

    // Idempotence stricte : préserve le premier timestamp historique pour la valeur probante
    if (req.extensionNotifiedAt) {
      return { ok: true, requestId, notifiedAt: req.extensionNotifiedAt };
    }

    if (req.extendedAt && notifiedAt.getTime() < req.extendedAt.getTime()) {
      throw new PrivacySupportActionError(
        'INVALID_NOTIFICATION_DATE',
        'La date d’attestation ne peut pas être antérieure à la décision de prorogation.',
      );
    }

    const now = new Date();
    await tx
      .update(privacyRequests)
      .set({
        extensionNotifiedAt: notifiedAt,
        updatedAt: now,
      })
      .where(eq(privacyRequests.id, requestId));

    await writeAuditEntry(tx, {
      actorUserId,
      action: 'PRIVACY_REQUEST_EXTENSION_NOTIFIED',
      targetType: 'PRIVACY_REQUEST',
      targetId: requestId,
      metadata: {
        requestId,
        notifiedAt: notifiedAt.toISOString(),
      },
    });

    return { ok: true, requestId, notifiedAt };
  });
}

/**
 * 5. Décision interne sur la suite à donner (Art. 12.3 & 12.4 RGPD).
 * - Transition : IN_REVIEW -> DECISION_READY.
 * - La demande reste OUVERTE tant que la réponse n'a pas été communiquée à la personne.
 * - Idempotence : si même décision ré-exécutée, retour sans second audit.
 * - Conflit : si la demande est déjà clôturée (COMPLETED ou CANCELLED), refus explicite.
 */
export async function recordPrivacyDecision(
  db: DatabaseClient,
  input: RecordPrivacyDecisionInput,
): Promise<{
  ok: true;
  requestId: string;
  status: 'DECISION_READY';
  resolution: 'FULFILLED' | 'PARTIALLY_FULFILLED' | 'REFUSED';
}> {
  const { requestId, actorUserId, resolution, decisionReasonCode, resolutionNotes } = input;

  if (!VALID_RESOLUTIONS.includes(resolution)) {
    throw new PrivacySupportActionError(
      'INVALID_RESOLUTION_STATUS',
      `Statut de résolution invalide : ${resolution}.`,
    );
  }

  if (!resolutionNotes || resolutionNotes.trim().length === 0) {
    throw new PrivacySupportActionError(
      'RESOLUTION_NOTES_REQUIRED',
      'Une note interne de justification est obligatoire pour motiver la décision.',
    );
  }

  if (resolution === 'REFUSED' && (!decisionReasonCode || decisionReasonCode.trim().length === 0)) {
    throw new PrivacySupportActionError(
      'REASON_CODE_REQUIRED',
      'Un motif légal de refus est obligatoire pour refuser une demande (Art. 12.4 RGPD).',
    );
  }

  return db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, requestId))
      .for('update')
      .limit(1);

    if (!req) {
      throw new PrivacySupportActionError('NOT_FOUND', 'Demande RGPD introuvable.');
    }

    // Idempotence : si même décision déjà arrêtée en DECISION_READY
    if (
      req.status === 'DECISION_READY' &&
      req.resolution === resolution &&
      (resolution !== 'REFUSED' || req.decisionReasonCode === decisionReasonCode)
    ) {
      return { ok: true, requestId, status: 'DECISION_READY', resolution };
    }

    // Conflit : si une décision divergente est déjà arrêtée pour cette demande
    if (req.status === 'DECISION_READY') {
      throw new PrivacySupportActionError(
        'INVALID_STATE_TRANSITION',
        `Une décision (${req.resolution}) a déjà été arrêtée pour cette demande et ne peut pas être écrasée.`,
      );
    }

    // Conflit : si déjà clôturée (COMPLETED ou CANCELLED)
    if (req.status === 'COMPLETED' || req.status === 'CANCELLED') {
      throw new PrivacySupportActionError(
        'INVALID_STATE_TRANSITION',
        `Cette demande est déjà clôturée (${req.status}) et ne peut plus être modifiée.`,
      );
    }

    // Transition uniquement permise depuis IN_REVIEW
    if (req.status !== 'IN_REVIEW') {
      throw new PrivacySupportActionError(
        'INVALID_STATE_TRANSITION',
        `Seule une demande en cours d’instruction (IN_REVIEW) peut faire l’objet d’une décision (statut actuel : ${req.status}).`,
      );
    }

    const now = new Date();
    await tx
      .update(privacyRequests)
      .set({
        status: 'DECISION_READY',
        resolution,
        decisionReasonCode:
          resolution === 'REFUSED' && decisionReasonCode
            ? (decisionReasonCode as (typeof privacyRequests.decisionReasonCode.enumValues)[number])
            : null,
        resolutionNotes,
        decisionAt: now,
        decisionByUserId: actorUserId,
        updatedAt: now,
      })
      .where(eq(privacyRequests.id, requestId));

    // Audit log sans PII
    await writeAuditEntry(tx, {
      actorUserId,
      action: 'PRIVACY_REQUEST_DECISION_RECORDED',
      targetType: 'PRIVACY_REQUEST',
      targetId: requestId,
      metadata: {
        requestId,
        previousStatus: req.status,
        newStatus: 'DECISION_READY',
        resolution,
        decisionReasonCode: resolution === 'REFUSED' ? decisionReasonCode : null,
      },
    });

    return { ok: true, requestId, status: 'DECISION_READY', resolution };
  });
}

/**
 * 6. Attestation opérateur de la communication effective au demandeur (Art. 12.3 & 12.4 RGPD).
 * - Transition : DECISION_READY -> COMPLETED.
 * - Règle régalienne : une demande n'est COMPLETED que lorsque la personne a été effectivement informée.
 * - Idempotence stricte : préserve le premier timestamp historique pour sa valeur probante.
 */
export async function recordPrivacyResponseNotification(
  db: DatabaseClient,
  input: RecordPrivacyResponseNotificationInput,
): Promise<{
  ok: true;
  requestId: string;
  status: 'COMPLETED';
  responseNotifiedAt: Date;
}> {
  const { requestId, actorUserId, responseNotifiedAt = new Date() } = input;

  return db.transaction(async (tx) => {
    const [req] = await tx
      .select()
      .from(privacyRequests)
      .where(eq(privacyRequests.id, requestId))
      .for('update')
      .limit(1);

    if (!req) {
      throw new PrivacySupportActionError('NOT_FOUND', 'Demande RGPD introuvable.');
    }

    // Idempotence : si déjà COMPLETED, préserve impérativement le premier timestamp historique
    if (req.status === 'COMPLETED' && req.responseNotifiedAt) {
      return {
        ok: true,
        requestId,
        status: 'COMPLETED',
        responseNotifiedAt: req.responseNotifiedAt,
      };
    }

    if (req.status !== 'DECISION_READY') {
      throw new PrivacySupportActionError(
        'INVALID_STATE_TRANSITION',
        `Une décision interne motivée (DECISION_READY) doit être préalablement arrêtée avant d’attester de l’envoi de la réponse (statut actuel : ${req.status}).`,
      );
    }

    if (req.decisionAt && responseNotifiedAt.getTime() < req.decisionAt.getTime()) {
      throw new PrivacySupportActionError(
        'INVALID_NOTIFICATION_DATE',
        'La date d’attestation de la réponse ne peut pas être antérieure à la décision interne.',
      );
    }

    const now = new Date();
    await tx
      .update(privacyRequests)
      .set({
        status: 'COMPLETED',
        responseNotifiedAt,
        responseNotifiedByUserId: actorUserId,
        resolvedAt: responseNotifiedAt,
        updatedAt: now,
      })
      .where(eq(privacyRequests.id, requestId));

    await writeAuditEntry(tx, {
      actorUserId,
      action: 'PRIVACY_REQUEST_COMPLETED',
      targetType: 'PRIVACY_REQUEST',
      targetId: requestId,
      metadata: {
        requestId,
        resolution: req.resolution,
        responseNotifiedAt: responseNotifiedAt.toISOString(),
      },
    });

    return {
      ok: true,
      requestId,
      status: 'COMPLETED',
      responseNotifiedAt,
    };
  });
}

/**
 * Alias de compatibilité pour resolvePrivacyRequest (enregistre la décision interne).
 */
export async function resolvePrivacyRequest(
  db: DatabaseClient,
  input: ResolvePrivacyRequestInput,
): Promise<{
  ok: true;
  requestId: string;
  status: 'DECISION_READY';
  resolution: 'FULFILLED' | 'PARTIALLY_FULFILLED' | 'REFUSED';
}> {
  const resolution = input.resolution ?? input.resolutionStatus ?? 'FULFILLED';
  return recordPrivacyDecision(db, {
    requestId: input.requestId,
    actorUserId: input.actorUserId,
    resolution,
    decisionReasonCode: input.decisionReasonCode,
    resolutionNotes: input.resolutionNotes,
  });
}

/**
 * 7. Exécution d'un effacement RGPD (ERASURE / Art. 17) ordonnée par le support (Lot 21-P2, ADR-039).
 * - Vérifie que la demande est en cours d'instruction (IN_REVIEW) et porte sur un effacement (ERASURE).
 * - Exécute l'effacement et le scellement probatoire via eraseUserAccount.
 * - La demande passe en DECISION_READY avec la mention de rétention probatoire.
 */
export async function executeErasurePrivacyRequest(
  db: DatabaseClient,
  input: {
    requestId: string;
    actorUserId: string;
    deleteExternalIdentity?: ((oidcSubject: string) => Promise<void>) | undefined;
  },
): Promise<EraseUserAccountResult> {
  const { requestId, actorUserId, deleteExternalIdentity } = input;

  const [req] = await db
    .select()
    .from(privacyRequests)
    .where(eq(privacyRequests.id, requestId))
    .limit(1);

  if (!req) {
    throw new PrivacySupportActionError('NOT_FOUND', 'Demande RGPD introuvable.');
  }

  if (req.requestType !== 'ERASURE') {
    throw new PrivacySupportActionError(
      'INVALID_REQUEST_TYPE',
      `Seule une demande d’effacement (ERASURE) peut faire l’objet d’une exécution d’effacement (type actuel : ${req.requestType}).`,
    );
  }

  if (req.status !== 'IN_REVIEW') {
    throw new PrivacySupportActionError(
      'INVALID_STATE_TRANSITION',
      `La demande doit être en cours d’instruction (IN_REVIEW) pour exécuter l’effacement (statut actuel : ${req.status}).`,
    );
  }

  return eraseUserAccount(db, {
    userId: req.userId,
    actorUserId,
    triggerSource: 'SUPPORT_REQUEST',
    privacyRequestId: req.id,
    deleteExternalIdentity,
  });
}

