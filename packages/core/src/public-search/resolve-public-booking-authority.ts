import { and, eq, isNull } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import {
  categories,
  countries,
  locations,
  organizations,
  products,
  productVariants,
} from '@uttily/database';
import { isHistoricalPaddleCategorySlug } from '../catalog/equipment-taxonomy';
import type {
  PublicProductPublicationGate,
  ResolvePublicBookingAuthorityInput,
  ResolvePublicBookingAuthorityResult,
} from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Résolveur d'autorité côté serveur pour une réservation publique.
 *
 * Résout les identifiants publics autorisés (publicProductId, publicLocationId, publicVariantId)
 * en identifiants internes transactionnels (organizationId, locationId, productId, variantId).
 *
 * Applique exactement les mêmes règles d'éligibilité et de sécurité que la consultation publique :
 * - Produit PUBLISHED et non supprimé.
 * - Organisation non supprimée.
 * - Établissement non supprimé, publiquement listé et retrait activé.
 * - Pays de l'établissement actif.
 * - Stricte appartenance du produit, de la variante et de l'établissement à la même organisation.
 * - Variante active et non supprimée.
 * - Validation de la porte de publication photo (au moins 3 photos validées) si fournie.
 */
export async function resolvePublicBookingAuthority(
  db: DatabaseClient,
  input: ResolvePublicBookingAuthorityInput,
  options?: {
    publicationGate?: PublicProductPublicationGate;
  },
): Promise<ResolvePublicBookingAuthorityResult> {
  if (
    !input ||
    typeof input !== 'object' ||
    !input.publicProductId ||
    typeof input.publicProductId !== 'string' ||
    !UUID_RE.test(input.publicProductId.trim()) ||
    !input.publicLocationId ||
    typeof input.publicLocationId !== 'string' ||
    !UUID_RE.test(input.publicLocationId.trim()) ||
    !input.publicVariantId ||
    typeof input.publicVariantId !== 'string' ||
    !UUID_RE.test(input.publicVariantId.trim())
  ) {
    return { kind: 'INVALID_INPUT' };
  }

  const cleanPublicProductId = input.publicProductId.trim();
  const cleanPublicLocationId = input.publicLocationId.trim();
  const cleanPublicVariantId = input.publicVariantId.trim();

  // 1. Charger produit, organisation, établissement et pays
  const rows = await db
    .select({
      productId: products.id,
      productOrgId: products.organizationId,
      productPublicationStatus: products.publicationStatus,
      productDeletedAt: products.deletedAt,
      categorySlug: categories.slug,
      orgId: organizations.id,
      orgDeletedAt: organizations.deletedAt,
      locationId: locations.id,
      locationOrgId: locations.organizationId,
      locationDeletedAt: locations.deletedAt,
      timeZone: locations.timeZone,
      operatingCurrency: locations.operatingCurrency,
      addressLine1: locations.addressLine1,
      city: locations.city,
      countryCode: locations.countryCode,
      pickupEnabled: locations.pickupEnabled,
      isPubliclyListed: locations.isPubliclyListed,
      countryIsActive: countries.isActive,
    })
    .from(products)
    .innerJoin(organizations, eq(organizations.id, products.organizationId))
    .innerJoin(locations, eq(locations.publicId, cleanPublicLocationId))
    .leftJoin(categories, eq(categories.id, products.categoryId))
    .leftJoin(countries, eq(countries.countryCode, locations.countryCode))
    .where(eq(products.publicId, cleanPublicProductId))
    .limit(1);

  if (rows.length === 0) {
    return { kind: 'NOT_FOUND' };
  }

  const r = rows[0]!;

  // 2. Contrôles de cohérence multi-tenant et d'éligibilité
  if (r.productOrgId !== r.locationOrgId) {
    return { kind: 'NOT_FOUND' };
  }

  if (r.productPublicationStatus !== 'PUBLISHED') {
    return { kind: 'NOT_FOUND' };
  }

  if (isHistoricalPaddleCategorySlug(r.categorySlug)) {
    return { kind: 'NOT_FOUND' };
  }

  if (r.productDeletedAt !== null || r.orgDeletedAt !== null || r.locationDeletedAt !== null) {
    return { kind: 'NOT_FOUND' };
  }

  if (!r.isPubliclyListed || !r.pickupEnabled) {
    return { kind: 'NOT_FOUND' };
  }

  if (!r.addressLine1 || !r.city || !r.countryCode || !r.countryIsActive) {
    return { kind: 'NOT_FOUND' };
  }

  // 3. Gating de publication (photos)
  if (options?.publicationGate) {
    const eligible = await options.publicationGate.filterEligibleProductIds(db, [r.productId]);
    if (!eligible.has(r.productId)) {
      return { kind: 'NOT_FOUND' };
    }
  }

  // 4. Charger et valider la variante
  const variantRows = await db
    .select({
      variantId: productVariants.id,
      isActive: productVariants.isActive,
      deletedAt: productVariants.deletedAt,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.publicId, cleanPublicVariantId),
        eq(productVariants.productId, r.productId),
        isNull(productVariants.deletedAt),
      ),
    )
    .limit(1);

  if (variantRows.length === 0 || !variantRows[0]!.isActive) {
    return { kind: 'NOT_FOUND' };
  }

  return {
    kind: 'SUCCESS',
    authority: {
      organizationId: r.productOrgId,
      locationId: r.locationId,
      productId: r.productId,
      variantId: variantRows[0]!.variantId,
      timeZone: r.timeZone,
      operatingCurrency: r.operatingCurrency,
    },
  };
}
