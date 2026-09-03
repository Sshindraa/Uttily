import type { DbExecutor } from '@uttily/database';
import { privacyRequests } from '@uttily/database';
import { writeAuditEntry } from '../identity/audit';
import { computePrivacyResponseDeadline } from './privacy-deadline';
import type { PrivacyRequest, PrivacyRequestType } from './types';
import { VALID_PRIVACY_REQUEST_TYPES } from './types';

interface CreatePrivacyRequestInput {
  readonly userId: string;
  readonly requestType: PrivacyRequestType;
  readonly details?: string | null;
}

/**
 * Enregistre une demande d'exercice de droits RGPD dans le registre.
 *
 * - Calcule `response_due_at` à +1 mois calendaire (article 12.3 du RGPD).
 * - Écrit un audit trail conforme ADR-016 (aucun PII dans metadata).
 * - Retourne la demande créée avec son identifiant et son échéance.
 */
export async function createPrivacyRequest(
  db: DbExecutor,
  input: CreatePrivacyRequestInput,
): Promise<PrivacyRequest> {
  if (!VALID_PRIVACY_REQUEST_TYPES.includes(input.requestType)) {
    throw new Error(`Type de demande invalide : ${input.requestType}`);
  }

  const now = new Date();
  const responseDueAt = computePrivacyResponseDeadline(now);

  const [created] = await db
    .insert(privacyRequests)
    .values({
      userId: input.userId,
      requestType: input.requestType,
      details: input.details ?? null,
      receivedAt: now,
      responseDueAt,
    })
    .returning();

  if (!created) {
    throw new Error('Échec de création de la demande RGPD.');
  }

  // Audit trail conforme ADR-016 : aucun PII, aucun message libre.
  await writeAuditEntry(db, {
    actorUserId: input.userId,
    action: 'PRIVACY_REQUEST_CREATED',
    targetType: 'PRIVACY_REQUEST',
    targetId: created.id,
    metadata: { requestType: input.requestType },
  });

  return {
    id: created.id,
    requestType: created.requestType,
    status: created.status,
    receivedAt: created.receivedAt,
    responseDueAt: created.responseDueAt,
    extendedUntil: created.extendedUntil,
    resolvedAt: created.resolvedAt,
  };
}
