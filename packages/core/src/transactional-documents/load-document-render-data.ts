/**
 * @uttily/core — Chargement autoritatif des données de rendu depuis DB (G5C, ADR-013).
 *
 * Cette fonction ne crée PAS le snapshot en base : elle charge et valide les
 * autorités DB, recoupe les cohérences, et construit un LoadedDocumentRenderDataV1
 * en mémoire (sans sourceOutboxEventId ni capturedAt). La persistance et
 * l'assemblage du snapshot complet sont assurés par l'appelant
 * (get-or-create-document-render-snapshot.ts).
 *
 * Aucune donnée n'est trustée depuis le payload outbox : tout est rechargé
 * depuis PostgreSQL et recoupé.
 */

import { sql } from 'drizzle-orm';
import type { DbExecutor } from '@uttily/database';
import { DocumentRenderError } from './errors';
import { isRecursivelySerializable } from './opaque-json';
import { isValidTimeZone } from '../identity/time-zone';
import { BOOKING_STATUSES } from '../fulfillment/types';
import { parseMarketplaceFeeSnapshot } from '../marketplace-fees';
import type {
  LoadedDocumentRenderDataV1,
  SnapshotBooking,
  SnapshotBookingItem,
  SnapshotCustomer,
  SnapshotLineItem,
  SnapshotLocation,
  SnapshotOrganization,
  SnapshotPayment,
} from './snapshot-types';

interface LoadInput {
  readonly organizationId: string;
  readonly bookingId: string;
  readonly paymentId: string;
  readonly draftId: string;
}

/**
 * Tous les statuts de booking sont acceptés pour le snapshot documentaire.
 * Un événement BOOKING_CONFIRMED peut être traité tardivement après une
 * annulation (CANCELLED) ou un remboursement (REFUNDED). Le worker doit
 * toujours pouvoir produire le snapshot historique de la réservation
 * confirmée. Le statut actuel est conservé dans le snapshot sans prétendre
 * qu'il s'agit du statut au moment exact de confirmation.
 *
 * Dérivé de BOOKING_STATUSES (bookingStatus.enumValues) pour garantir la
 * cohérence avec le schéma DB.
 */
const ACCEPTED_BOOKING_STATUSES = new Set<string>(BOOKING_STATUSES);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertSafeInteger(value: unknown, field: string): number {
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new DocumentRenderError('VALIDATION', `${field} n est pas un safe integer`);
    }
    return parsed;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new DocumentRenderError('VALIDATION', `${field} n est pas un safe integer`);
  }
  return value;
}

function assertNonNegativeSafeInteger(value: unknown, field: string): number {
  const n = assertSafeInteger(value, field);
  if (n < 0) {
    throw new DocumentRenderError('VALIDATION', `${field} n est pas un montant valide`);
  }
  return n;
}

function assertPositiveSafeInteger(value: unknown, field: string): number {
  const n = assertSafeInteger(value, field);
  if (n <= 0) {
    throw new DocumentRenderError('VALIDATION', `${field} n est pas une quantite valide`);
  }
  return n;
}

function assertNonNegativeBufferSafeInteger(value: unknown, field: string): number {
  const n = assertSafeInteger(value, field);
  if (n < 0) {
    throw new DocumentRenderError('VALIDATION', `${field} n est pas un buffer valide`);
  }
  return n;
}

function assertNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new DocumentRenderError('VALIDATION', `${field} n est pas une string non vide`);
  }
  return value;
}

/**
 * Convertit une valeur DB (Date, string, ou autre) vers un timestamp
 * ISO 8601 UTC canonique : YYYY-MM-DDTHH:mm:ss.sssZ
 *
 * - Accepte Date (driver postgres), string ISO
 * - Convertit vers Date puis retourne date.toISOString()
 * - Refuse les valeurs invalides
 */
export function toCanonicalIsoTimestamp(value: unknown, field: string): string {
  if (value === null || value === undefined) {
    throw new DocumentRenderError('VALIDATION', `${field} est requis`);
  }
  let date: Date;
  if (value instanceof Date) {
    date = value;
  } else if (typeof value === 'string') {
    date = new Date(value);
  } else {
    throw new DocumentRenderError('VALIDATION', `${field} n est pas un timestamp valide`);
  }
  if (isNaN(date.getTime())) {
    throw new DocumentRenderError('VALIDATION', `${field} n est pas un timestamp valide`);
  }
  return date.toISOString();
}

/**
 * Vérifie qu'une chaîne est un timestamp ISO 8601 UTC canonique.
 * new Date(value).toISOString() === value garantit le format canonique.
 */
export function isCanonicalIsoTimestamp(value: string): boolean {
  try {
    const date = new Date(value);
    return !isNaN(date.getTime()) && date.toISOString() === value;
  } catch {
    return false;
  }
}

function assertJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DocumentRenderError('VALIDATION', `${field} n est pas un objet JSON`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function assertOpaqueJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  const obj = assertJsonObject(value, field);
  if (!isRecursivelySerializable(obj)) {
    throw new DocumentRenderError('VALIDATION', `${field} n est pas recursivement serialisable`);
  }
  return obj;
}

/**
 * Retourne null si la valeur est null/undefined, sinon valide via assertNonEmptyString.
 * Utilisé pour les champs DB nullable de type text.
 */
function nullableString(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  return assertNonEmptyString(value, field);
}

/**
 * Retourne null si la valeur est null/undefined, sinon valide via assertSafeInteger.
 * Utilisé pour les champs DB nullable de type integer.
 */
function nullableSafeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return assertSafeInteger(value, field);
}

/**
 * Retourne null si la valeur est null/undefined, sinon valide via
 * assertNonNegativeSafeInteger. Utilisé pour les champs DB nullable de type
 * montant (bigint stocké comme string par le driver).
 */
function nullableNonNegativeSafeInteger(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  return assertNonNegativeSafeInteger(value, field);
}

/**
 * Retourne null si la valeur est null/undefined, sinon valide via
 * assertOpaqueJsonObject. Utilisé pour les champs DB nullable de type jsonb.
 */
function nullableOpaqueJsonObject(
  value: unknown,
  field: string,
): Readonly<Record<string, unknown>> | null {
  if (value === null || value === undefined) return null;
  return assertOpaqueJsonObject(value, field);
}

/**
 * Charge et recoupe les autorités DB pour construire les données de rendu v1
 * (sans sourceOutboxEventId ni capturedAt, ajoutés par l'appelant).
 *
 * Recoupements (tous dans la même organisation) :
 * - booking.id = payload.bookingId, booking.organization_id = payload.organizationId
 * - booking.payment_id = payload.paymentId, booking.draft_id = payload.draftId
 * - booking.status appartient à BOOKING_STATUSES (tous statuts acceptés)
 * - payment.id = payload.paymentId, payment.organization_id identique
 * - payment.draft_id identique, payment.customer_user_id = booking.customer_user_id
 * - payment.status = SUCCEEDED, payment.succeeded_at non-null
 * - location.organization_id identique
 * - booking_lines rattachées au booking
 * - booking_items rattachés au booking
 * - inventory_items cohérents avec les booking_items
 *
 * Invariants métier vérifiés :
 * - au moins une booking_line et un booking_item
 * - chaque booking_item référence une booking_line chargée
 * - quantité > 0, billableUnitCount > 0
 * - montants >= 0 (safe integers)
 * - devises cohérentes : booking.currency === payment.currency === chaque line.currency
 * - customerStartAt < customerEndAt
 */
export async function loadDocumentRenderData(
  db: DbExecutor,
  input: LoadInput,
): Promise<LoadedDocumentRenderDataV1> {
  // 1. Charger le booking avec recoupement organization.
  // G7P-B2-C : les colonnes flexibles (timezone, billable_unit,
  // billable_unit_count, pricing_snapshot_version, etc.) sont sélectionnées
  // pour rendre les données de pricing flexible disponibles au rendu. Elles
  // ne sont incluses dans le snapshot que pour les bookings flexibles
  // (pricingSnapshotVersion === 'flexible-pricing-v1') afin de préserver la
  // forme attendue par parseDocumentRenderSnapshotV1 pour les bookings legacy.
  const bookingRows = await db.execute(sql`
    SELECT id, organization_id, location_id, customer_user_id, draft_id, payment_id,
           status, customer_start_at, customer_end_at,
           prep_buffer_minutes, cleanup_buffer_minutes,
           currency, subtotal_amount_minor, mandatory_fees_amount_minor,
           total_amount_minor, tax_status, tax_amount_minor, tax_rate_bps,
           customer_total_amount_minor, marketplace_fee_snapshot,
           cancellation_policy_snapshot,
           terms_acceptance_snapshot, confirmed_at,
           timezone, billable_unit, billable_unit_count,
           pricing_snapshot_version, pricing_algorithm_version,
           pricing_rounding_rule_version, pricing_intent_type,
           pricing_intent_snapshot, pricing_resolved_locale
    FROM "bookings"
    WHERE "id" = ${input.bookingId}::uuid
      AND "organization_id" = ${input.organizationId}::uuid
  `);
  if (bookingRows.length === 0) {
    throw new DocumentRenderError(
      'AUTHORITY_MISMATCH',
      'booking introuvable ou cross-organisation',
    );
  }
  const booking = bookingRows[0] as Record<string, unknown>;

  // Recoupements booking.
  if (booking['payment_id'] !== input.paymentId) {
    throw new DocumentRenderError(
      'AUTHORITY_MISMATCH',
      'booking.payment_id differe du paymentId du payload',
    );
  }
  if (booking['draft_id'] !== input.draftId) {
    throw new DocumentRenderError(
      'AUTHORITY_MISMATCH',
      'booking.draft_id differe du draftId du payload',
    );
  }
  const bookingStatus = assertNonEmptyString(booking['status'], 'booking.status');
  if (!ACCEPTED_BOOKING_STATUSES.has(bookingStatus)) {
    throw new DocumentRenderError(
      'AUTHORITY_MISMATCH',
      'booking.status n est pas un statut valide',
    );
  }

  const customerUserId = booking['customer_user_id'];
  if (typeof customerUserId !== 'string' || !UUID_RE.test(customerUserId)) {
    throw new DocumentRenderError(
      'VALIDATION',
      'booking.customer_user_id n est pas un UUID valide',
    );
  }
  const locationId = booking['location_id'];
  if (typeof locationId !== 'string' || !UUID_RE.test(locationId)) {
    throw new DocumentRenderError('VALIDATION', 'booking.location_id n est pas un UUID valide');
  }

  // 2. Charger payment avec recoupements.
  const paymentRows = await db.execute(sql`
    SELECT id, organization_id, draft_id, customer_user_id,
           status, amount_minor, currency,
           financial_terms_version, legal_terms_version,
           succeeded_at
    FROM "payments"
    WHERE "id" = ${input.paymentId}::uuid
      AND "organization_id" = ${input.organizationId}::uuid
  `);
  if (paymentRows.length === 0) {
    throw new DocumentRenderError(
      'AUTHORITY_MISMATCH',
      'payment introuvable ou cross-organisation',
    );
  }
  const payment = paymentRows[0] as Record<string, unknown>;

  if (payment['draft_id'] !== input.draftId) {
    throw new DocumentRenderError(
      'AUTHORITY_MISMATCH',
      'payment.draft_id differe du draftId du payload',
    );
  }
  if (payment['customer_user_id'] !== customerUserId) {
    throw new DocumentRenderError(
      'AUTHORITY_MISMATCH',
      'payment.customer_user_id differe de booking.customer_user_id',
    );
  }
  const paymentStatus = assertNonEmptyString(payment['status'], 'payment.status');
  if (paymentStatus !== 'SUCCEEDED') {
    throw new DocumentRenderError('AUTHORITY_MISMATCH', 'payment.status n est pas SUCCEEDED');
  }
  if (payment['succeeded_at'] === null || payment['succeeded_at'] === undefined) {
    throw new DocumentRenderError('AUTHORITY_MISMATCH', 'payment.succeeded_at est null');
  }

  // 3. Charger location.
  const locationRows = await db.execute(sql`
    SELECT id, organization_id, name, address_line1, address_line2,
           city, postal_code, country_code, time_zone
    FROM "locations"
    WHERE "id" = ${locationId}::uuid
      AND "organization_id" = ${input.organizationId}::uuid
  `);
  if (locationRows.length === 0) {
    throw new DocumentRenderError(
      'AUTHORITY_MISMATCH',
      'location introuvable ou cross-organisation',
    );
  }
  const location = locationRows[0] as Record<string, unknown>;

  const timeZone = assertNonEmptyString(location['time_zone'], 'location.time_zone');
  if (!isValidTimeZone(timeZone)) {
    throw new DocumentRenderError(
      'VALIDATION',
      'location.time_zone n est pas un fuseau IANA valide',
    );
  }

  // 4. Charger organization.
  const orgRows = await db.execute(sql`
    SELECT id, legal_name
    FROM "organizations"
    WHERE "id" = ${input.organizationId}::uuid
  `);
  if (orgRows.length === 0) {
    throw new DocumentRenderError('AUTHORITY_MISMATCH', 'organization introuvable');
  }
  const org = orgRows[0] as Record<string, unknown>;

  // 5. Charger customer (user).
  const userRows = await db.execute(sql`
    SELECT id, display_name, locale
    FROM "users"
    WHERE "id" = ${customerUserId}::uuid
  `);
  if (userRows.length === 0) {
    throw new DocumentRenderError('AUTHORITY_MISMATCH', 'user (customer) introuvable');
  }
  const user = userRows[0] as Record<string, unknown>;

  // 6. Charger booking_lines (triées par lineId pour déterminisme).
  // G7P-B2-C : les colonnes flexibles (pricing_plan_id, pricing_plan_type,
  // pricing_selected_window, source_draft_line_id, etc.) sont sélectionnées
  // pour rendre les données de pricing flexible disponibles au rendu. Elles
  // ne sont incluses dans le snapshot que pour les bookings flexibles.
  const lineRows = await db.execute(sql`
    SELECT id, variant_id, quantity, unit_price_amount_minor,
           billable_unit_count, line_total_amount_minor, currency, variant_snapshot,
           pricing_plan_id, pricing_plan_version, pricing_plan_type,
           pricing_public_label, pricing_requested_duration_minutes,
           pricing_billed_duration_minutes, pricing_covered_duration_minutes,
           pricing_billed_days, pricing_selected_window,
           pricing_discount_threshold_days, pricing_discount_percent,
           pricing_amount_before_discount_minor, pricing_amount_after_discount_minor,
           source_draft_line_id
    FROM "booking_lines"
    WHERE "booking_id" = ${input.bookingId}::uuid
    ORDER BY "id" ASC
  `);
  const lines: SnapshotLineItem[] = [];
  for (const row of lineRows as Array<Record<string, unknown>>) {
    lines.push({
      lineId: assertNonEmptyString(row['id'], 'booking_line.id'),
      variantId: assertNonEmptyString(row['variant_id'], 'booking_line.variant_id'),
      quantity: assertPositiveSafeInteger(row['quantity'], 'booking_line.quantity'),
      unitPriceAmountMinor: assertNonNegativeSafeInteger(
        row['unit_price_amount_minor'],
        'booking_line.unit_price_amount_minor',
      ),
      billableUnitCount: assertPositiveSafeInteger(
        row['billable_unit_count'],
        'booking_line.billable_unit_count',
      ),
      lineTotalAmountMinor: assertNonNegativeSafeInteger(
        row['line_total_amount_minor'],
        'booking_line.line_total_amount_minor',
      ),
      currency: assertNonEmptyString(row['currency'], 'booking_line.currency'),
      variantSnapshot: assertOpaqueJsonObject(
        row['variant_snapshot'],
        'booking_line.variant_snapshot',
      ),
      // G7P-B2-C — champs flexibles uniquement pour les bookings flexible-pricing-v1.
      ...(nullableString(
        booking['pricing_snapshot_version'],
        'booking.pricing_snapshot_version',
      ) === 'flexible-pricing-v1'
        ? {
            pricingPlanId: nullableString(row['pricing_plan_id'], 'booking_line.pricing_plan_id'),
            pricingPlanVersion: nullableSafeInteger(
              row['pricing_plan_version'],
              'booking_line.pricing_plan_version',
            ),
            pricingPlanType: nullableString(
              row['pricing_plan_type'],
              'booking_line.pricing_plan_type',
            ),
            pricingPublicLabel: nullableString(
              row['pricing_public_label'],
              'booking_line.pricing_public_label',
            ),
            pricingRequestedDurationMinutes: nullableSafeInteger(
              row['pricing_requested_duration_minutes'],
              'booking_line.pricing_requested_duration_minutes',
            ),
            pricingBilledDurationMinutes: nullableSafeInteger(
              row['pricing_billed_duration_minutes'],
              'booking_line.pricing_billed_duration_minutes',
            ),
            pricingCoveredDurationMinutes: nullableSafeInteger(
              row['pricing_covered_duration_minutes'],
              'booking_line.pricing_covered_duration_minutes',
            ),
            pricingBilledDays: nullableSafeInteger(
              row['pricing_billed_days'],
              'booking_line.pricing_billed_days',
            ),
            pricingSelectedWindow: nullableOpaqueJsonObject(
              row['pricing_selected_window'],
              'booking_line.pricing_selected_window',
            ),
            pricingDiscountThresholdDays: nullableSafeInteger(
              row['pricing_discount_threshold_days'],
              'booking_line.pricing_discount_threshold_days',
            ),
            pricingDiscountPercent: nullableSafeInteger(
              row['pricing_discount_percent'],
              'booking_line.pricing_discount_percent',
            ),
            pricingAmountBeforeDiscountMinor: nullableNonNegativeSafeInteger(
              row['pricing_amount_before_discount_minor'],
              'booking_line.pricing_amount_before_discount_minor',
            ),
            pricingAmountAfterDiscountMinor: nullableNonNegativeSafeInteger(
              row['pricing_amount_after_discount_minor'],
              'booking_line.pricing_amount_after_discount_minor',
            ),
            sourceDraftLineId: nullableString(
              row['source_draft_line_id'],
              'booking_line.source_draft_line_id',
            ),
          }
        : {}),
    });
  }

  // 7. Charger booking_items avec join inventory_items (triés par bookingItemId).
  const itemRows = await db.execute(sql`
    SELECT bi.id AS booking_item_id, bi.booking_line_id, bi.inventory_item_id,
           ii.internal_sku, ii.serial_number, ii.condition, ii.status AS inventory_status
    FROM "booking_items" bi
    JOIN "inventory_items" ii ON ii.id = bi.inventory_item_id
    WHERE bi.booking_id = ${input.bookingId}::uuid
      AND ii.organization_id = ${input.organizationId}::uuid
    ORDER BY bi.id ASC
  `);
  const items: SnapshotBookingItem[] = [];
  for (const row of itemRows as Array<Record<string, unknown>>) {
    items.push({
      bookingItemId: assertNonEmptyString(row['booking_item_id'], 'booking_item.id'),
      bookingLineId: assertNonEmptyString(row['booking_line_id'], 'booking_item.booking_line_id'),
      inventoryItemId: assertNonEmptyString(
        row['inventory_item_id'],
        'booking_item.inventory_item_id',
      ),
      internalSku: assertNonEmptyString(row['internal_sku'], 'inventory_item.internal_sku'),
      serialNumber:
        row['serial_number'] === null || row['serial_number'] === undefined
          ? null
          : assertNonEmptyString(row['serial_number'], 'inventory_item.serial_number'),
      condition: assertNonEmptyString(row['condition'], 'inventory_item.condition'),
      inventoryStatus: assertNonEmptyString(row['inventory_status'], 'inventory_item.status'),
    });
  }

  // 8. Construire les sous-objets du snapshot.
  const snapshotBooking: SnapshotBooking = {
    id: assertNonEmptyString(booking['id'], 'booking.id'),
    status: bookingStatus,
    customerStartAt: toCanonicalIsoTimestamp(
      booking['customer_start_at'],
      'booking.customer_start_at',
    ),
    customerEndAt: toCanonicalIsoTimestamp(booking['customer_end_at'], 'booking.customer_end_at'),
    confirmedAt: toCanonicalIsoTimestamp(booking['confirmed_at'], 'booking.confirmed_at'),
    prepBufferMinutes: assertNonNegativeBufferSafeInteger(
      booking['prep_buffer_minutes'],
      'booking.prep_buffer_minutes',
    ),
    cleanupBufferMinutes: assertNonNegativeBufferSafeInteger(
      booking['cleanup_buffer_minutes'],
      'booking.cleanup_buffer_minutes',
    ),
    currency: assertNonEmptyString(booking['currency'], 'booking.currency'),
    subtotalAmountMinor: assertNonNegativeSafeInteger(
      booking['subtotal_amount_minor'],
      'booking.subtotal_amount_minor',
    ),
    mandatoryFeesAmountMinor: assertNonNegativeSafeInteger(
      booking['mandatory_fees_amount_minor'],
      'booking.mandatory_fees_amount_minor',
    ),
    totalAmountMinor: assertNonNegativeSafeInteger(
      booking['total_amount_minor'],
      'booking.total_amount_minor',
    ),
    ...(booking['marketplace_fee_snapshot'] !== null &&
    booking['marketplace_fee_snapshot'] !== undefined
      ? (() => {
          const feeSnapshot = parseMarketplaceFeeSnapshot(booking['marketplace_fee_snapshot']);
          const customerTotalAmountMinor = assertNonNegativeSafeInteger(
            booking['customer_total_amount_minor'],
            'booking.customer_total_amount_minor',
          );
          if (feeSnapshot.customerTotalAmountMinor !== customerTotalAmountMinor) {
            throw new DocumentRenderError(
              'AUTHORITY_MISMATCH',
              'booking marketplace snapshot et customer_total_amount_minor incoherents',
            );
          }
          return {
            marketplaceFeeBaseAmountMinor: feeSnapshot.marketplaceFeeBaseAmountMinor,
            customerServiceFeeAmountMinor: feeSnapshot.customerServiceFeeAmountMinor,
            customerTotalAmountMinor,
            marketplaceFeeRuleVersion: feeSnapshot.ruleVersion,
          };
        })()
      : {}),
    taxStatus: assertNonEmptyString(booking['tax_status'], 'booking.tax_status'),
    taxAmountMinor:
      booking['tax_amount_minor'] === null || booking['tax_amount_minor'] === undefined
        ? null
        : assertNonNegativeSafeInteger(booking['tax_amount_minor'], 'booking.tax_amount_minor'),
    taxRateBps:
      booking['tax_rate_bps'] === null || booking['tax_rate_bps'] === undefined
        ? null
        : assertNonNegativeSafeInteger(booking['tax_rate_bps'], 'booking.tax_rate_bps'),
    cancellationPolicySnapshot: assertOpaqueJsonObject(
      booking['cancellation_policy_snapshot'],
      'booking.cancellation_policy_snapshot',
    ),
    termsAcceptanceSnapshot: assertOpaqueJsonObject(
      booking['terms_acceptance_snapshot'],
      'booking.terms_acceptance_snapshot',
    ),
    // G7P-B2-C — champs flexibles uniquement pour les bookings flexible-pricing-v1.
    // Pour les bookings legacy, ces champs sont absents du snapshot afin de
    // préserver la forme exacte attendue par parseDocumentRenderSnapshotV1.
    ...(nullableString(booking['pricing_snapshot_version'], 'booking.pricing_snapshot_version') ===
    'flexible-pricing-v1'
      ? {
          timezone: nullableString(booking['timezone'], 'booking.timezone') ?? 'UTC',
          billableUnit: nullableString(booking['billable_unit'], 'booking.billable_unit') ?? 'DAY',
          billableUnitCount:
            nullableSafeInteger(booking['billable_unit_count'], 'booking.billable_unit_count') ?? 1,
          pricingSnapshotVersion: 'flexible-pricing-v1',
          pricingAlgorithmVersion: nullableString(
            booking['pricing_algorithm_version'],
            'booking.pricing_algorithm_version',
          ),
          pricingRoundingRuleVersion: nullableString(
            booking['pricing_rounding_rule_version'],
            'booking.pricing_rounding_rule_version',
          ),
          pricingIntentType: nullableString(
            booking['pricing_intent_type'],
            'booking.pricing_intent_type',
          ),
          pricingIntentSnapshot: nullableOpaqueJsonObject(
            booking['pricing_intent_snapshot'],
            'booking.pricing_intent_snapshot',
          ),
          pricingResolvedLocale: nullableString(
            booking['pricing_resolved_locale'],
            'booking.pricing_resolved_locale',
          ),
        }
      : {}),
  };

  const snapshotPayment: SnapshotPayment = {
    id: assertNonEmptyString(payment['id'], 'payment.id'),
    status: paymentStatus,
    succeededAt: toCanonicalIsoTimestamp(payment['succeeded_at'], 'payment.succeeded_at'),
    amountMinor: assertNonNegativeSafeInteger(payment['amount_minor'], 'payment.amount_minor'),
    currency: assertNonEmptyString(payment['currency'], 'payment.currency'),
    financialTermsVersion: assertNonEmptyString(
      payment['financial_terms_version'],
      'payment.financial_terms_version',
    ),
    legalTermsVersion: assertNonEmptyString(
      payment['legal_terms_version'],
      'payment.legal_terms_version',
    ),
  };

  const snapshotOrganization: SnapshotOrganization = {
    id: assertNonEmptyString(org['id'], 'organization.id'),
    legalName: assertNonEmptyString(org['legal_name'], 'organization.legal_name'),
  };

  const snapshotLocation: SnapshotLocation = {
    id: assertNonEmptyString(location['id'], 'location.id'),
    name: assertNonEmptyString(location['name'], 'location.name'),
    addressLine1:
      location['address_line1'] === null || location['address_line1'] === undefined
        ? null
        : assertNonEmptyString(location['address_line1'], 'location.address_line1'),
    addressLine2:
      location['address_line2'] === null || location['address_line2'] === undefined
        ? null
        : assertNonEmptyString(location['address_line2'], 'location.address_line2'),
    city:
      location['city'] === null || location['city'] === undefined
        ? null
        : assertNonEmptyString(location['city'], 'location.city'),
    postalCode:
      location['postal_code'] === null || location['postal_code'] === undefined
        ? null
        : assertNonEmptyString(location['postal_code'], 'location.postal_code'),
    countryCode:
      location['country_code'] === null || location['country_code'] === undefined
        ? null
        : assertNonEmptyString(location['country_code'], 'location.country_code'),
    timeZone,
  };

  const snapshotCustomer: SnapshotCustomer = {
    userId: assertNonEmptyString(user['id'], 'user.id'),
    displayName:
      user['display_name'] === null || user['display_name'] === undefined
        ? null
        : assertNonEmptyString(user['display_name'], 'user.display_name'),
    locale: assertNonEmptyString(user['locale'], 'user.locale'),
  };

  // 9. Invariants métier.
  if (lines.length === 0) {
    throw new DocumentRenderError('VALIDATION', 'au moins une booking_line requise');
  }
  if (items.length === 0) {
    throw new DocumentRenderError('VALIDATION', 'au moins un booking_item requis');
  }
  const lineIds = new Set(lines.map((l) => l.lineId));
  for (const item of items) {
    if (!lineIds.has(item.bookingLineId)) {
      throw new DocumentRenderError(
        'VALIDATION',
        'booking_item reference une booking_line inexistante',
      );
    }
  }
  const bookingCurrency = snapshotBooking.currency;
  if (snapshotPayment.currency !== bookingCurrency) {
    throw new DocumentRenderError('VALIDATION', 'devises incoherentes entre booking et payment');
  }
  for (const line of lines) {
    if (line.currency !== bookingCurrency) {
      throw new DocumentRenderError('VALIDATION', 'devises incoherentes entre booking et lines');
    }
  }
  if (new Date(snapshotBooking.customerStartAt) >= new Date(snapshotBooking.customerEndAt)) {
    throw new DocumentRenderError('VALIDATION', 'customerStartAt doit etre avant customerEndAt');
  }

  return {
    organizationId: input.organizationId,
    bookingId: input.bookingId,
    paymentId: input.paymentId,
    draftId: input.draftId,
    organization: snapshotOrganization,
    location: snapshotLocation,
    customer: snapshotCustomer,
    booking: snapshotBooking,
    payment: snapshotPayment,
    lines,
    items,
  };
}
