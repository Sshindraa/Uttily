/**
 * @uttily/core — Module Photos (G7F-A2).
 *
 * Implémentation PostgreSQL du publication gate (ADR-020 §D).
 *
 * `PostgresPhotoPublicationGate` implémente `PublicProductPublicationGate`
 * en exécutant une seule requête SQL batch pour N produits. Un produit est
 * éligible si et seulement si :
 * - il n'est pas soft-deleted (`deleted_at IS NULL`) ;
 * - il possède au moins 3 photos valides distinctes (`file_state = 'AVAILABLE'`,
 *   `deleted_at IS NULL`, checksums distincts) ;
 * - s'il est de catégorie `bike`, il possède aussi les trois slots canoniques
 *   d'ADR-031.
 *
 * Fail-closed : une panne PostgreSQL produit une erreur typée
 * `PUBLICATION_GATE_UNAVAILABLE`, jamais un `Set` vide silencieux.
 * Aucun fallback permissif, aucun `() => true`.
 */

import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import type { PublicProductPublicationGate } from '../public-search/types';
import { PublicSearchError } from '../public-search/errors';
import { REQUIRED_BIKE_PHOTO_SLOTS } from '@uttily/contracts';
import { COMMERCIAL_EQUIPMENT_FAMILY_SLUGS } from '../catalog/equipment-taxonomy';

export class PostgresPhotoPublicationGate implements PublicProductPublicationGate {
  /**
   * Filtre les productIds éligibles à la publication publique.
   *
   * - Entrée vide → retourne un `Set` vide sans exécuter de SQL.
   * - Une seule requête SQL pour N produits (batch).
   * - Panne PostgreSQL → `PublicSearchError('PUBLICATION_GATE_UNAVAILABLE', ...)`.
   * - Jamais de fallback permissif.
   */
  async filterEligibleProductIds(
    db: DatabaseClient,
    productIds: readonly string[],
  ): Promise<ReadonlySet<string>> {
    // Entrée vide → Set vide sans SQL.
    if (productIds.length === 0) {
      return new Set<string>();
    }

    try {
      // Construit la liste d'UUIDs pour la clause ANY.
      // sql.join génère $1, $2, ... pour chaque UUID, ce qui évite les
      // problèmes de conversion de tableau JavaScript → PostgreSQL.
      const uuidList = sql.join(
        [...productIds].map((id) => sql`${id}::uuid`),
        sql`, `,
      );
      const commercialCategorySlugs = sql.join(
        COMMERCIAL_EQUIPMENT_FAMILY_SLUGS.map((slug) => sql`${slug}`),
        sql`, `,
      );

      const result = await db.execute<{ id: string }>(
        // Une seule requête batch : compte les photos valides distinctes
        // par produit et filtre ceux avec >= 3. Pour les vélos, les trois slots
        // canoniques doivent également être présents (ADR-031).
        // La jointure sur organization_id garantit la cohérence multi-tenant.
        // Voir ADR-020 §D.2 et plan §4.4.
        sql`
          SELECT p.id
          FROM products p
          INNER JOIN categories c ON c.id = p.category_id
          WHERE p.id IN (${uuidList})
            AND p.deleted_at IS NULL
            AND c.is_active = true
            AND c.slug IN (${commercialCategorySlugs})
            AND (
              SELECT COUNT(DISTINCT pp.checksum_sha256)
              FROM product_photos pp
              WHERE pp.product_id = p.id
                AND pp.organization_id = p.organization_id
                AND pp.file_state = 'AVAILABLE'
                AND pp.deleted_at IS NULL
                AND pp.checksum_sha256 IS NOT NULL
            ) >= 3
            AND (
              c.slug <> 'bike'
              OR (
                SELECT COUNT(DISTINCT pp.slot_type)
                FROM product_photos pp
                WHERE pp.product_id = p.id
                  AND pp.organization_id = p.organization_id
                  AND pp.file_state = 'AVAILABLE'
                  AND pp.deleted_at IS NULL
                  AND pp.checksum_sha256 IS NOT NULL
                  AND pp.slot_type IN (
                    'HERO_PROFILE',
                    'THREE_QUARTER_FRONT',
                    'SECONDARY_VIEW'
                  )
              ) = ${REQUIRED_BIKE_PHOTO_SLOTS.length}
            )
        `,
      );

      const eligible = new Set<string>();
      for (const row of result) {
        eligible.add(row.id);
      }
      return eligible;
    } catch (error) {
      // Fail-closed : transformer la panne DB en erreur typée.
      // Aucun détail SQL, nom de table ou ID interne n'est exposé.
      throw new PublicSearchError(
        'PUBLICATION_GATE_UNAVAILABLE',
        'Le gate de publication est temporairement indisponible.',
        { cause: error },
      );
    }
  }
}
