/**
 * @uttily/core — Module Product Analytics (G7H-A).
 *
 * Enregistrement idempotent d'un événement analytics dans le ledger raw.
 *
 * `recordProductAnalyticsEvent` :
 * - Valide l'entrée (UUID, date, environnement, type d'événement, hasResults).
 * - INSERT avec ON CONFLICT (event_type, environment, source_id) DO NOTHING.
 * - Si l'insert retourne une ligne → retourne { id }.
 * - Si aucune ligne (conflit) → vérifie la sémantique :
 *   - mêmes valeurs → { kind: 'DUPLICATE' } (idempotence).
 *   - valeurs différentes → DUPLICATE_CONFLICT (conflit sémantique).
 * - Fail-closed sur erreurs DB → ANALYTICS_UNAVAILABLE.
 */

import { and, eq } from 'drizzle-orm';
import type { DbExecutor } from '@uttily/database';
import { productAnalyticsEvents } from '@uttily/database';
import { ProductAnalyticsError } from './errors';
import type { RecordProductAnalyticsEventInput } from './types';
import {
  validateEnvironment,
  validateEventType,
  validateOccurredAt,
  validateUuid,
} from './validation';

/**
 * Enregistre un événement analytics de manière idempotente.
 *
 * @param db Client de base de données.
 * @param input Entrée discriminée (PUBLIC_SEARCH_PERFORMED requiert hasResults,
 *   BOOKING_ATTEMPTED et BOOKING_CONFIRMED ne l'acceptent pas).
 * @returns `{ id }` si l'événement a été inséré, `{ kind: 'DUPLICATE' }` si
 *   un événement identique existait déjà.
 * @throws {ProductAnalyticsError} INVALID_UUID, INVALID_INPUT, INVALID_ENVIRONMENT,
 *   INVALID_EVENT_TYPE, DUPLICATE_CONFLICT, ANALYTICS_UNAVAILABLE.
 */
export async function recordProductAnalyticsEvent(
  db: DbExecutor,
  input: RecordProductAnalyticsEventInput,
): Promise<{ id: string } | { kind: 'DUPLICATE' }> {
  // 1. Validation des champs communs.
  validateUuid(input.sourceId, 'sourceId');
  validateOccurredAt(input.occurredAt);
  validateEnvironment(input.environment);
  validateEventType(input.eventType);

  // 2. Validation hasResults selon eventType (au niveau applicatif).
  if (input.eventType === 'PUBLIC_SEARCH_PERFORMED') {
    if (typeof input.hasResults !== 'boolean') {
      throw new ProductAnalyticsError(
        'INVALID_INPUT',
        'hasResults requis pour PUBLIC_SEARCH_PERFORMED.',
      );
    }
  } else {
    // BOOKING_ATTEMPTED et BOOKING_CONFIRMED ne doivent pas porter hasResults.
    // La présence de la clé, même avec valeur undefined, est rejetée.
    if ('hasResults' in input) {
      throw new ProductAnalyticsError(
        'INVALID_INPUT',
        "hasResults interdit pour ce type d'événement.",
      );
    }
  }

  // 3. INSERT avec ON CONFLICT DO NOTHING.
  try {
    const inserted = await db
      .insert(productAnalyticsEvents)
      .values({
        eventType: input.eventType,
        environment: input.environment,
        sourceId: input.sourceId,
        hasResults: input.eventType === 'PUBLIC_SEARCH_PERFORMED' ? input.hasResults : null,
        occurredAt: input.occurredAt,
      })
      .onConflictDoNothing({
        target: [
          productAnalyticsEvents.eventType,
          productAnalyticsEvents.environment,
          productAnalyticsEvents.sourceId,
        ],
      })
      .returning({ id: productAnalyticsEvents.id });

    if (inserted.length > 0) {
      return { id: inserted[0]!.id };
    }

    // 4. Conflit : vérifier la sémantique de la ligne existante.
    const [existing] = await db
      .select({
        hasResults: productAnalyticsEvents.hasResults,
        occurredAt: productAnalyticsEvents.occurredAt,
      })
      .from(productAnalyticsEvents)
      .where(
        and(
          eq(productAnalyticsEvents.eventType, input.eventType),
          eq(productAnalyticsEvents.environment, input.environment),
          eq(productAnalyticsEvents.sourceId, input.sourceId),
        ),
      )
      .limit(1);

    if (!existing) {
      // Race condition : la ligne a été supprimée entre l'INSERT et le SELECT.
      // Fail-closed.
      throw new ProductAnalyticsError('ANALYTICS_UNAVAILABLE', 'Événement analytics indisponible.');
    }

    // Vérifier la cohérence sémantique.
    const existingHasResults = existing.hasResults;
    const inputHasResults = input.eventType === 'PUBLIC_SEARCH_PERFORMED' ? input.hasResults : null;

    // Un événement est un replay identique uniquement si TOUTES les valeurs
    // métier correspondent : eventType, environment, sourceId (vérifiés par la
    // clé unique), occurredAt (milliseconde exacte) et hasResults.
    if (
      existingHasResults === inputHasResults &&
      existing.occurredAt.getTime() === input.occurredAt.getTime()
    ) {
      return { kind: 'DUPLICATE' };
    }

    // Conflit sémantique : même clé de déduplication mais valeurs différentes.
    throw new ProductAnalyticsError(
      'DUPLICATE_CONFLICT',
      'Conflit de déduplication : un événement avec la même clé existe déjà avec des valeurs différentes.',
    );
  } catch (error) {
    if (error instanceof ProductAnalyticsError) {
      throw error;
    }
    // Fail-closed sur erreurs DB.
    throw new ProductAnalyticsError('ANALYTICS_UNAVAILABLE', 'Service analytics indisponible.', {
      cause: error,
    });
  }
}
