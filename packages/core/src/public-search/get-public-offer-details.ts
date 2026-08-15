import { and, asc, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "@uttily/database";
import {
  countries,
  locationOpeningHours,
  locations,
  organizations,
  products,
  productVariants,
} from "@uttily/database";
import type {
  GetPublicOfferDetailsInput,
  GetPublicOfferDetailsResult,
  PublicOfferDetails,
  PublicOfferOpeningHour,
  PublicOfferVariant,
  PublicProductPublicationGate,
} from "./types";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read model canonique public d'une offre de location (G7E / Pont Checkout).
 *
 * Charge les données publiques nécessaires à la consultation et à la configuration
 * d'une réservation à partir de (publicProductId, publicLocationId).
 *
 * Règles de sécurité et d'isolation :
 * - Autorise uniquement les produits PUBLISHED non supprimés.
 * - Autorise uniquement les établissements publicly listed et pickup enabled non supprimés.
 * - Exige la stricte appartenance du produit et de l'établissement à la même organisation.
 * - Vérifie que le pays de l'établissement est actif (countries.is_active = true).
 * - Applique le publicationGate (au moins 3 photos validées) si fourni.
 * - Ne retourne aucun identifiant interne d'organisation, de lieu ou d'inventaire physique.
 */
export async function getPublicOfferDetails(
  db: DatabaseClient,
  input: GetPublicOfferDetailsInput,
  options?: {
    publicationGate?: PublicProductPublicationGate;
  },
): Promise<GetPublicOfferDetailsResult> {
  if (
    !input ||
    typeof input !== "object" ||
    !input.publicProductId ||
    typeof input.publicProductId !== "string" ||
    !UUID_RE.test(input.publicProductId.trim()) ||
    !input.publicLocationId ||
    typeof input.publicLocationId !== "string" ||
    !UUID_RE.test(input.publicLocationId.trim())
  ) {
    return { kind: "INVALID_INPUT" };
  }

  const cleanPublicProductId = input.publicProductId.trim();
  const cleanPublicLocationId = input.publicLocationId.trim();

  // 1. Charger produit, organisation, établissement et pays en une seule requête jointe
  const rows = await db
    .select({
      productId: products.id,
      publicProductId: products.publicId,
      productName: products.name,
      productDescription: products.description,
      productPublicationStatus: products.publicationStatus,
      productDeletedAt: products.deletedAt,
      productOrgId: products.organizationId,
      orgId: organizations.id,
      orgLegalName: organizations.legalName,
      orgPublicDisplayName: organizations.publicDisplayName,
      orgDeletedAt: organizations.deletedAt,
      locationId: locations.id,
      publicLocationId: locations.publicId,
      locationName: locations.name,
      locationOrgId: locations.organizationId,
      timeZone: locations.timeZone,
      operatingCurrency: locations.operatingCurrency,
      addressLine1: locations.addressLine1,
      addressLine2: locations.addressLine2,
      city: locations.city,
      postalCode: locations.postalCode,
      countryCode: locations.countryCode,
      pickupEnabled: locations.pickupEnabled,
      isPubliclyListed: locations.isPubliclyListed,
      locationDeletedAt: locations.deletedAt,
      countryIsActive: countries.isActive,
    })
    .from(products)
    .innerJoin(organizations, eq(organizations.id, products.organizationId))
    .innerJoin(locations, eq(locations.publicId, cleanPublicLocationId))
    .leftJoin(countries, eq(countries.countryCode, locations.countryCode))
    .where(eq(products.publicId, cleanPublicProductId))
    .limit(1);

  if (rows.length === 0) {
    return { kind: "NOT_FOUND" };
  }

  const r = rows[0]!;

  // 2. Vérifications de cohérence multi-tenant et d'état
  if (r.productOrgId !== r.locationOrgId) {
    return { kind: "NOT_FOUND" };
  }

  if (r.productPublicationStatus !== "PUBLISHED") {
    return { kind: "NOT_FOUND" };
  }

  if (r.productDeletedAt !== null || r.orgDeletedAt !== null || r.locationDeletedAt !== null) {
    return { kind: "NOT_FOUND" };
  }

  if (!r.isPubliclyListed || !r.pickupEnabled) {
    return { kind: "NOT_FOUND" };
  }

  if (!r.addressLine1 || !r.city || !r.countryCode || !r.countryIsActive) {
    return { kind: "NOT_FOUND" };
  }

  // 3. Gating de publication (photos) si fourni
  if (options?.publicationGate) {
    const eligible = await options.publicationGate.filterEligibleProductIds(db, [r.productId]);
    if (!eligible.has(r.productId)) {
      return { kind: "NOT_FOUND" };
    }
  }

  // 4. Charger les variantes actives et non supprimées
  const variantRows = await db
    .select({
      id: productVariants.id,
      name: productVariants.name,
      skuSuffix: productVariants.skuSuffix,
      attributes: productVariants.attributes,
      isActive: productVariants.isActive,
      dailyPriceAmountMinor: productVariants.dailyPriceAmountMinor,
      currency: productVariants.currency,
      deletedAt: productVariants.deletedAt,
    })
    .from(productVariants)
    .where(
      and(
        eq(productVariants.productId, r.productId),
        eq(productVariants.isActive, true),
        isNull(productVariants.deletedAt),
      ),
    )
    .orderBy(asc(productVariants.createdAt), asc(productVariants.name));

  if (variantRows.length === 0) {
    return { kind: "NOT_FOUND" };
  }

  // 5. Charger les horaires d'ouverture de l'établissement
  const openingHourRows = await db
    .select({
      weekday: locationOpeningHours.weekday,
      openTime: locationOpeningHours.openTime,
      closeTime: locationOpeningHours.closeTime,
    })
    .from(locationOpeningHours)
    .where(eq(locationOpeningHours.locationId, r.locationId))
    .orderBy(asc(locationOpeningHours.weekday), asc(locationOpeningHours.openTime));

  const variants: PublicOfferVariant[] = variantRows.map((v) => ({
    id: v.id,
    name: v.name,
    skuSuffix: v.skuSuffix,
    attributes: (v.attributes as Record<string, unknown>) ?? {},
    dailyPriceAmountMinor: v.dailyPriceAmountMinor,
    currency: v.currency,
  }));

  const openingHours: PublicOfferOpeningHour[] = openingHourRows.map((h) => ({
    weekday: h.weekday,
    openTime: h.openTime,
    closeTime: h.closeTime,
  }));

  const offer: PublicOfferDetails = {
    publicProductId: r.publicProductId,
    publicLocationId: r.publicLocationId,
    organizationPublicDisplayName: r.orgPublicDisplayName ?? r.orgLegalName,
    productName: r.productName,
    productDescription: r.productDescription ?? "",
    locationName: r.locationName,
    timeZone: r.timeZone,
    operatingCurrency: r.operatingCurrency,
    addressLine1: r.addressLine1,
    addressLine2: r.addressLine2,
    city: r.city,
    postalCode: r.postalCode,
    countryCode: r.countryCode,
    variants,
    openingHours,
  };

  return { kind: "SUCCESS", offer };
}
