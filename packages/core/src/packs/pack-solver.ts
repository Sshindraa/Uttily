import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  inventoryItems,
  productVariants,
  products,
  categories,
  locations,
  organizations,
} from '@uttily/database';
import type { PackRequest } from './party-model';
import {
  findAdmissibleAccessorySubstitutions,
} from './compatibility-graph';
import {
  createAccessorySubstitutionRepair,
  type PackRepair,
} from './pack-repair';
import {
  rankCandidatePacks,
  type RankedPackCandidate,
  type ScorablePackCandidate,
} from './pack-ranker';

export interface SolvedPackItem {
  readonly requirementId: string;
  readonly partyMemberId: string;
  readonly inventoryItemId: string;
  readonly internalSku: string;
  readonly productId: string;
  readonly productName: string;
  readonly productVariantId: string;
  readonly variantName: string;
  readonly categorySlug: string;
  readonly unitPriceCents: number;
}

export interface SolvedPackCandidate extends ScorablePackCandidate {
  readonly items: readonly SolvedPackItem[];
}

export interface SolvePackOptions {
  readonly allowRepairs?: boolean;
}

/**
 * Résout les packs disponibles pour un groupe (PackSolver ADR-041).
 *
 * Moteur 100% déterministe garantissant le respect du panier mono-loueur :
 * tous les équipements d'un pack candidat proviennent de la même organisation
 * et sont simultanément disponibles pour la période demandée.
 */
export async function solvePackForParty(
  db: DatabaseClient,
  request: PackRequest,
  options: SolvePackOptions = { allowRepairs: true },
): Promise<readonly RankedPackCandidate<SolvedPackCandidate>[]> {
  const { startAt, endAt, requirements, party } = request;

  if (requirements.length === 0) {
    return [];
  }

  // 1. Récupérer les établissements actifs dans la zone de la destination
  // Pour la v1, on recherche par destination ou organisations actives
  const activeLocations = await db
    .select({
      locationId: locations.id,
      organizationId: locations.organizationId,
      organizationName: organizations.publicDisplayName,
      legalName: organizations.legalName,
      locationName: locations.name,
      addressLine1: locations.addressLine1,
      city: locations.city,
    })
    .from(locations)
    .innerJoin(organizations, eq(locations.organizationId, organizations.id))
    .where(
      and(
        eq(locations.pickupEnabled, true),
        eq(organizations.status, 'ACTIVE'),
        isNull(locations.deletedAt),
        isNull(organizations.deletedAt),
      ),
    );

  const candidatePacks: SolvedPackCandidate[] = [];

  // 2. Pour chaque établissement, vérifier si l'inventaire physique satisfait le pack
  for (const loc of activeLocations) {
    // Récupère tous les exemplaires disponibles dans ce lieu pour la période
    const availableRows = await db
      .select({
        itemId: inventoryItems.id,
        sku: inventoryItems.internalSku,
        variantId: productVariants.id,
        variantName: productVariants.name,
        dailyPriceAmountMinor: productVariants.dailyPriceAmountMinor,
        productId: products.id,
        productName: products.name,
        categorySlug: categories.slug,
      })
      .from(inventoryItems)
      .innerJoin(productVariants, eq(inventoryItems.productVariantId, productVariants.id))
      .innerJoin(products, eq(productVariants.productId, products.id))
      .innerJoin(categories, eq(products.categoryId, categories.id))
      .where(
        and(
          eq(inventoryItems.organizationId, loc.organizationId),
          eq(inventoryItems.currentLocationId, loc.locationId),
          eq(inventoryItems.status, 'ACTIVE'),
          ne(inventoryItems.condition, 'BROKEN'),
          isNull(inventoryItems.deletedAt),
          isNull(products.deletedAt),
          sql`NOT EXISTS (
            SELECT 1 FROM "inventory_blocks"
            WHERE "inventory_blocks"."inventory_item_id" = ${inventoryItems.id}
            AND "inventory_blocks"."deleted_at" IS NULL
            AND "inventory_blocks"."status" IN ('ACTIVE', 'PAYMENT_PROCESSING')
            AND tstzrange("inventory_blocks"."blocked_start_at", "inventory_blocks"."blocked_end_at") && tstzrange(${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz)
          )`,
        ),
      );

    if (availableRows.length < requirements.length) {
      // Pas assez d'exemplaires physiques au total
      continue;
    }

    // Matching des besoins fonctionnels
    const allocatedItemIds = new Set<string>();
    const packItems: SolvedPackItem[] = [];
    const repairs: PackRepair[] = [];
    let isPackSolvable = true;

    for (const req of requirements) {
      const member = party.find((m) => m.id === req.partyMemberId);

      // Chercher un item exact ou équivalent correspondant à la famille
      const reqSlug = req.familySlug.toLowerCase();
      let matchedRow = availableRows.find((row) => {
        if (allocatedItemIds.has(row.itemId)) return false;
        const cat = row.categorySlug.toLowerCase();
        const prod = row.productName.toLowerCase();
        if (cat === reqSlug || cat.includes(reqSlug) || reqSlug.includes(cat)) return true;
        if (
          reqSlug === 'bike' &&
          (cat.includes('velo') ||
            cat.includes('vtt') ||
            cat.includes('vae') ||
            prod.includes('velo') ||
            prod.includes('vae') ||
            prod.includes('vtt') ||
            prod.includes('bike'))
        )
          return true;
        if (
          reqSlug === 'kayak' &&
          (cat.includes('canoe') ||
            cat.includes('paddle') ||
            prod.includes('kayak') ||
            prod.includes('canoe'))
        )
          return true;
        return false;
      });

      // Si c'est un besoin d'accessoire enfant (ex: remorque ou siège)
      if (!matchedRow && req.accessoryRequired && options.allowRepairs && member) {
        const allowedSubs = findAdmissibleAccessorySubstitutions(
          req.accessoryRequired,
          member,
          req.familySlug,
        );

        for (const sub of allowedSubs) {
          const subSlug = sub === 'CHILD_TRAILER' ? 'trailer' : 'accessory';
          matchedRow = availableRows.find(
            (row) =>
              !allocatedItemIds.has(row.itemId) &&
              (row.categorySlug.includes(subSlug) || row.productName.toLowerCase().includes(subSlug)),
          );

          if (matchedRow) {
            repairs.push(
              createAccessorySubstitutionRepair(
                req.accessoryRequired,
                sub,
                'Substitution homologuée par le Graphe de Compatibilité',
              ),
            );
            break;
          }
        }
      }

      if (!matchedRow) {
        // Impossible de satisfaire ce besoin dans cet établissement
        isPackSolvable = false;
        break;
      }

      allocatedItemIds.add(matchedRow.itemId);
      packItems.push({
        requirementId: req.id,
        partyMemberId: req.partyMemberId,
        inventoryItemId: matchedRow.itemId,
        internalSku: matchedRow.sku,
        productId: matchedRow.productId,
        productName: matchedRow.productName,
        productVariantId: matchedRow.variantId,
        variantName: matchedRow.variantName,
        categorySlug: matchedRow.categorySlug,
        unitPriceCents: matchedRow.dailyPriceAmountMinor ?? 4500,
      });
    }

    if (isPackSolvable && packItems.length === requirements.length) {
      const totalPriceCents = packItems.reduce((acc, it) => acc + it.unitPriceCents, 0);

      candidatePacks.push({
        organizationId: loc.organizationId,
        organizationName: loc.organizationName || loc.legalName,
        locationId: loc.locationId,
        locationAddress: `${loc.addressLine1 || loc.locationName}, ${loc.city || ''}`.trim(),
        distanceMeters: 350, // Distance représentative du centre de destination
        requestedDateMatched: true,
        totalPriceCents,
        repairs,
        items: packItems,
      });
    }
  }

  // 3. Classement déterministe selon les critères ADR-041
  return rankCandidatePacks(candidatePacks);
}
