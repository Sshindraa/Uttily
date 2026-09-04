import { eq, desc } from 'drizzle-orm';
import type { DbExecutor } from '@uttily/database';
import { privacyRequests } from '@uttily/database';
import type { PrivacyRequestSummary } from './types';

/**
 * Liste les demandes RGPD d'un utilisateur, triées par date de réception
 * décroissante.
 *
 * Retourne uniquement les champs visibles par le client :
 * - PAS de `details` (message libre, accès DPO/support uniquement)
 * - PAS de `resolution_notes` (accès DPO/support uniquement)
 */
export async function getUserPrivacyRequests(
  db: DbExecutor,
  userId: string,
): Promise<PrivacyRequestSummary[]> {
  const rows = await db
    .select({
      id: privacyRequests.id,
      requestType: privacyRequests.requestType,
      status: privacyRequests.status,
      receivedAt: privacyRequests.receivedAt,
      responseDueAt: privacyRequests.responseDueAt,
      extendedUntil: privacyRequests.extendedUntil,
      resolvedAt: privacyRequests.resolvedAt,
    })
    .from(privacyRequests)
    .where(eq(privacyRequests.userId, userId))
    .orderBy(desc(privacyRequests.receivedAt));

  return rows;
}
