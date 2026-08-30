/**
 * @uttily/core — Parser central et validation runtime stricte récursive du
 * snapshot de rendu v1 (G5C, ADR-013).
 *
 * parseDocumentRenderSnapshotV1 valide RÉCURSIVEMENT et STRICTEMENT la forme,
 * les types, les enums, les UUIDs, les dates ISO canoniques, les montants
 * (safe integers, signes), les cohérences inter-objets (organization.id ===
 * organizationId, etc.), les relations item→line, le tri des tableaux et
 * l'absence de doublons.
 *
 * Aucune valeur hostile n'est interpolée dans les messages d'erreur.
 *
 * Codes d'erreur :
 * - SNAPSHOT_INVARIANT : violation de forme (clés, structure, tri, doublons,
 *   cohérences, champs interdits, objets non sérialisables).
 * - VALIDATION : violation de type (UUID invalide, enum invalide, montant
 *   non safe integer, date non canonique).
 */

import { bookingStatus, taxStatus, inventoryCondition, inventoryStatus } from '@uttily/database';
import { DocumentRenderError } from './errors';
import { isRecursivelySerializable } from './opaque-json';
import { isCanonicalIsoTimestamp } from './load-document-render-data';
import { isValidTimeZone } from '../identity/time-zone';
import { SNAPSHOT_VERSION } from './snapshot-types';
import type { DocumentRenderSnapshotV1 } from './snapshot-types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const BOOKING_STATUSES_SET = new Set<string>(bookingStatus.enumValues);
const TAX_STATUSES_SET = new Set<string>(taxStatus.enumValues);
const INVENTORY_CONDITIONS_SET = new Set<string>(inventoryCondition.enumValues);
const INVENTORY_STATUSES_SET = new Set<string>(inventoryStatus.enumValues);

const ROOT_KEYS = [
  'snapshotVersion',
  'sourceOutboxEventId',
  'organizationId',
  'bookingId',
  'paymentId',
  'draftId',
  'capturedAt',
  'organization',
  'location',
  'customer',
  'booking',
  'payment',
  'lines',
  'items',
] as const;

const ORGANIZATION_KEYS = ['id', 'legalName'] as const;
const LOCATION_KEYS = [
  'id',
  'name',
  'addressLine1',
  'addressLine2',
  'city',
  'postalCode',
  'countryCode',
  'timeZone',
] as const;
const CUSTOMER_KEYS = ['userId', 'displayName', 'locale'] as const;
const BOOKING_KEYS = [
  'id',
  'status',
  'customerStartAt',
  'customerEndAt',
  'confirmedAt',
  'prepBufferMinutes',
  'cleanupBufferMinutes',
  'currency',
  'subtotalAmountMinor',
  'mandatoryFeesAmountMinor',
  'totalAmountMinor',
  'taxStatus',
  'taxAmountMinor',
  'taxRateBps',
  'cancellationPolicySnapshot',
  'termsAcceptanceSnapshot',
] as const;
// G7P-B2-C — clés flexibles optionnelles (présentes uniquement pour flexible-pricing-v1)
const BOOKING_OPTIONAL_KEYS = [
  'timezone',
  'billableUnit',
  'billableUnitCount',
  'pricingSnapshotVersion',
  'pricingAlgorithmVersion',
  'pricingRoundingRuleVersion',
  'pricingIntentType',
  'pricingIntentSnapshot',
  'pricingResolvedLocale',
] as const;
const BOOKING_MARKETPLACE_OPTIONAL_KEYS = [
  'marketplaceFeeBaseAmountMinor',
  'customerServiceFeeAmountMinor',
  'customerTotalAmountMinor',
  'marketplaceFeeRuleVersion',
] as const;
const PAYMENT_KEYS = [
  'id',
  'status',
  'succeededAt',
  'amountMinor',
  'currency',
  'financialTermsVersion',
  'legalTermsVersion',
] as const;
const LINE_KEYS = [
  'lineId',
  'variantId',
  'quantity',
  'unitPriceAmountMinor',
  'billableUnitCount',
  'lineTotalAmountMinor',
  'currency',
  'variantSnapshot',
] as const;
// G7P-B2-C — clés flexibles optionnelles (présentes uniquement pour flexible-pricing-v1)
const LINE_OPTIONAL_KEYS = [
  'pricingPlanId',
  'pricingPlanVersion',
  'pricingPlanType',
  'pricingPublicLabel',
  'pricingRequestedDurationMinutes',
  'pricingBilledDurationMinutes',
  'pricingCoveredDurationMinutes',
  'pricingBilledDays',
  'pricingSelectedWindow',
  'pricingDiscountThresholdDays',
  'pricingDiscountPercent',
  'pricingAmountBeforeDiscountMinor',
  'pricingAmountAfterDiscountMinor',
  'sourceDraftLineId',
] as const;
const ITEM_KEYS = [
  'bookingItemId',
  'bookingLineId',
  'inventoryItemId',
  'internalSku',
  'serialNumber',
  'condition',
  'inventoryStatus',
] as const;

/**
 * Champs internes interdits à chaque niveau. Leur présence lève
 * SNAPSHOT_INVARIANT. Cette liste est volontairement explicite pour
 * documenter l'exclusion.
 */
const FORBIDDEN_BOOKING_KEYS = new Set([
  'commissionAmountMinor',
  'commissionRuleSnapshot',
  'taxRuleSnapshot',
]);
const FORBIDDEN_PAYMENT_KEYS = new Set([
  'connectedAccountId',
  'environment',
  'onBehalfOfAccountId',
  'client_secret',
]);
const FORBIDDEN_CUSTOMER_KEYS = new Set(['email']);

function invariant(message: string): never {
  throw new DocumentRenderError('SNAPSHOT_INVARIANT', message);
}

function validation(message: string): never {
  throw new DocumentRenderError('VALIDATION', message);
}

/**
 * Additionne des montants en unités mineures une par une, en vérifiant
 * après chaque addition que l'accumulateur reste un safe integer. Lève
 * SNAPSHOT_INVARIANT en cas de dépassement.
 */
function safeSumMinor(amounts: number[]): number {
  let acc = 0;
  for (const a of amounts) {
    acc += a;
    if (!Number.isSafeInteger(acc)) {
      throw new DocumentRenderError(
        'SNAPSHOT_INVARIANT',
        'somme des lignes depasse Number.MAX_SAFE_INTEGER',
      );
    }
  }
  return acc;
}

function assertObject(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invariant(`${field} n est pas un objet`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  obj: Record<string, unknown>,
  expected: readonly string[],
  field: string,
  forbidden?: Set<string>,
  optionalKeys?: readonly string[],
): void {
  const actual = Object.keys(obj);
  const expectedSet = new Set(expected);
  const optionalSet = new Set(optionalKeys ?? []);
  // Vérifier d'abord les clés interdites (sécurité) avant la cohérence de
  // longueur, afin qu'un champ interne (email, client_secret, etc.) soit
  // signalé comme tel même s'il apparaît comme clé supplémentaire.
  for (const k of actual) {
    if (forbidden?.has(k)) {
      invariant(`${field} contient un champ interne interdit`);
    }
    if (!expectedSet.has(k) && !optionalSet.has(k)) {
      invariant(`${field} contient une cle non attendue`);
    }
  }
  // Toutes les clés requises doivent être présentes.
  for (const k of expected) {
    if (!(k in obj)) {
      invariant(`${field} n a pas le nombre de cles attendu`);
    }
  }
  // Le nombre de clés actuelles ne doit pas dépasser expected + optional.
  if (actual.length > expected.length + optionalSet.size) {
    invariant(`${field} n a pas le nombre de cles attendu`);
  }
}

/**
 * G7P-B2-C Round 3 (P0-2) — Validation stricte des clés flexibles optionnelles.
 *
 * Lorsque `pricingSnapshotVersion === 'flexible-pricing-v1'`, TOUTES les clés
 * flexibles optionnelles doivent être présentes (non optionnelles).
 * Lorsque `pricingSnapshotVersion === 'legacy-daily-v1'` ou absent, AUCUNE clé
 * flexible optionnelle ne doit être présente.
 *
 * @param obj Objet à valider (booking ou line).
 * @param optionalKeys Clés flexibles optionnelles.
 * @param pricingSnapshotVersion La version de snapshot de pricing.
 * @param field Nom du champ pour les messages d'erreur.
 */
function assertFlexibleKeysStrict(
  obj: Record<string, unknown>,
  optionalKeys: readonly string[],
  pricingSnapshotVersion: string | null,
  field: string,
): void {
  if (pricingSnapshotVersion === 'flexible-pricing-v1') {
    // Toutes les clés flexibles doivent être présentes.
    for (const k of optionalKeys) {
      if (!(k in obj)) {
        invariant(`${field} flexible-pricing-v1 requiert la cle ${k}`);
      }
    }
  } else {
    // legacy-daily-v1 ou absent : aucune clé flexible ne doit être présente.
    for (const k of optionalKeys) {
      if (k in obj) {
        invariant(`${field} legacy-daily-v1 ne doit pas contenir la cle flexible ${k}`);
      }
    }
  }
}

function assertString(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    validation(`${field} n est pas une string`);
  }
  return value;
}

function assertNonEmptyString(value: unknown, field: string): string {
  const s = assertString(value, field);
  if (s.length === 0) {
    validation(`${field} n est pas une string non vide`);
  }
  return s;
}

function assertNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return assertNonEmptyString(value, field);
}

function assertUuid(value: unknown, field: string): string {
  const s = assertString(value, field);
  if (!UUID_RE.test(s)) {
    validation(`${field} n est pas un UUID valide`);
  }
  return s;
}

function assertCanonicalIso(value: unknown, field: string): string {
  const s = assertString(value, field);
  if (!isCanonicalIsoTimestamp(s)) {
    validation(`${field} n est pas un timestamp ISO canonique`);
  }
  return s;
}

function assertSafeInt(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    validation(`${field} n est pas un safe integer`);
  }
  return value;
}

function assertNonNegSafeInt(value: unknown, field: string): number {
  const n = assertSafeInt(value, field);
  if (n < 0) {
    validation(`${field} n est pas un montant valide`);
  }
  return n;
}

function assertPosSafeInt(value: unknown, field: string): number {
  const n = assertSafeInt(value, field);
  if (n <= 0) {
    validation(`${field} n est pas une quantite valide`);
  }
  return n;
}

function assertNonNegBufferSafeInt(value: unknown, field: string): number {
  const n = assertSafeInt(value, field);
  if (n < 0) {
    validation(`${field} n est pas un buffer valide`);
  }
  return n;
}

function assertNullableNonNegSafeInt(value: unknown, field: string): number | null {
  if (value === null) return null;
  return assertNonNegSafeInt(value, field);
}

function assertEnum(value: unknown, allowed: Set<string>, field: string): string {
  const s = assertNonEmptyString(value, field);
  if (!allowed.has(s)) {
    validation(`${field} n est pas une valeur d enum valide`);
  }
  return s;
}

function assertOpaqueJsonObject(value: unknown, field: string): Readonly<Record<string, unknown>> {
  const obj = assertObject(value, field);
  if (!isRecursivelySerializable(obj)) {
    invariant(`${field} n est pas recursivement serialisable`);
  }
  return obj;
}

/**
 * Valide RÉCURSIVEMENT et STRICTEMENT un snapshot v1. Lève DocumentRenderError
 * (SNAPSHOT_INVARIANT ou VALIDATION) en cas d'anomalie. Retourne la valeur
 * typée si valide.
 */
export function parseDocumentRenderSnapshotV1(value: unknown): DocumentRenderSnapshotV1 {
  const root = assertObject(value, 'snapshot');

  // Racine : clés exactes.
  assertExactKeys(root, ROOT_KEYS, 'snapshot');

  // snapshotVersion
  if (root['snapshotVersion'] !== SNAPSHOT_VERSION) {
    invariant('snapshotVersion n est pas conforme');
  }

  // UUIDs racine.
  const sourceOutboxEventId = assertUuid(
    root['sourceOutboxEventId'],
    'snapshot.sourceOutboxEventId',
  );
  const organizationId = assertUuid(root['organizationId'], 'snapshot.organizationId');
  const bookingId = assertUuid(root['bookingId'], 'snapshot.bookingId');
  const paymentId = assertUuid(root['paymentId'], 'snapshot.paymentId');
  const draftId = assertUuid(root['draftId'], 'snapshot.draftId');

  // capturedAt canonique.
  const capturedAt = assertCanonicalIso(root['capturedAt'], 'snapshot.capturedAt');

  // organization
  const organization = assertObject(root['organization'], 'snapshot.organization');
  assertExactKeys(organization, ORGANIZATION_KEYS, 'snapshot.organization');
  const orgId = assertUuid(organization['id'], 'snapshot.organization.id');
  const legalName = assertNonEmptyString(
    organization['legalName'],
    'snapshot.organization.legalName',
  );

  // location
  const location = assertObject(root['location'], 'snapshot.location');
  assertExactKeys(location, LOCATION_KEYS, 'snapshot.location');
  const locId = assertUuid(location['id'], 'snapshot.location.id');
  const locName = assertNonEmptyString(location['name'], 'snapshot.location.name');
  const addressLine1 = assertNullableString(
    location['addressLine1'],
    'snapshot.location.addressLine1',
  );
  const addressLine2 = assertNullableString(
    location['addressLine2'],
    'snapshot.location.addressLine2',
  );
  const city = assertNullableString(location['city'], 'snapshot.location.city');
  const postalCode = assertNullableString(location['postalCode'], 'snapshot.location.postalCode');
  const countryCode = assertNullableString(
    location['countryCode'],
    'snapshot.location.countryCode',
  );
  const timeZone = assertNonEmptyString(location['timeZone'], 'snapshot.location.timeZone');
  if (!isValidTimeZone(timeZone)) {
    validation('snapshot.location.timeZone n est pas un fuseau IANA valide');
  }

  // customer
  const customer = assertObject(root['customer'], 'snapshot.customer');
  assertExactKeys(customer, CUSTOMER_KEYS, 'snapshot.customer', FORBIDDEN_CUSTOMER_KEYS);
  const userId = assertUuid(customer['userId'], 'snapshot.customer.userId');
  const displayName = assertNullableString(
    customer['displayName'],
    'snapshot.customer.displayName',
  );
  const locale = assertNonEmptyString(customer['locale'], 'snapshot.customer.locale');

  // booking
  const booking = assertObject(root['booking'], 'snapshot.booking');
  assertExactKeys(booking, BOOKING_KEYS, 'snapshot.booking', FORBIDDEN_BOOKING_KEYS, [
    ...BOOKING_OPTIONAL_KEYS,
    ...BOOKING_MARKETPLACE_OPTIONAL_KEYS,
  ]);
  // G7P-B2-C Round 3 (P0-2) — strict flexible key validation.
  // Extract pricingSnapshotVersion early to validate optional keys.
  const bookingPricingSnapshotVersion =
    'pricingSnapshotVersion' in booking
      ? assertNonEmptyString(
          booking['pricingSnapshotVersion'],
          'snapshot.booking.pricingSnapshotVersion',
        )
      : null;
  assertFlexibleKeysStrict(
    booking,
    BOOKING_OPTIONAL_KEYS,
    bookingPricingSnapshotVersion,
    'snapshot.booking',
  );
  const bId = assertUuid(booking['id'], 'snapshot.booking.id');
  const bStatus = assertEnum(booking['status'], BOOKING_STATUSES_SET, 'snapshot.booking.status');
  const customerStartAt = assertCanonicalIso(
    booking['customerStartAt'],
    'snapshot.booking.customerStartAt',
  );
  const customerEndAt = assertCanonicalIso(
    booking['customerEndAt'],
    'snapshot.booking.customerEndAt',
  );
  const confirmedAt = assertCanonicalIso(booking['confirmedAt'], 'snapshot.booking.confirmedAt');
  if (new Date(customerStartAt) >= new Date(customerEndAt)) {
    invariant('snapshot.booking.customerStartAt doit etre avant customerEndAt');
  }
  const prepBufferMinutes = assertNonNegBufferSafeInt(
    booking['prepBufferMinutes'],
    'snapshot.booking.prepBufferMinutes',
  );
  const cleanupBufferMinutes = assertNonNegBufferSafeInt(
    booking['cleanupBufferMinutes'],
    'snapshot.booking.cleanupBufferMinutes',
  );
  const bookingCurrency = assertNonEmptyString(booking['currency'], 'snapshot.booking.currency');
  const subtotalAmountMinor = assertNonNegSafeInt(
    booking['subtotalAmountMinor'],
    'snapshot.booking.subtotalAmountMinor',
  );
  const mandatoryFeesAmountMinor = assertNonNegSafeInt(
    booking['mandatoryFeesAmountMinor'],
    'snapshot.booking.mandatoryFeesAmountMinor',
  );
  const totalAmountMinor = assertNonNegSafeInt(
    booking['totalAmountMinor'],
    'snapshot.booking.totalAmountMinor',
  );
  const bTaxStatus = assertEnum(
    booking['taxStatus'],
    TAX_STATUSES_SET,
    'snapshot.booking.taxStatus',
  );
  const taxAmountMinor = assertNullableNonNegSafeInt(
    booking['taxAmountMinor'],
    'snapshot.booking.taxAmountMinor',
  );
  const taxRateBps = assertNullableNonNegSafeInt(
    booking['taxRateBps'],
    'snapshot.booking.taxRateBps',
  );
  const cancellationPolicySnapshot = assertOpaqueJsonObject(
    booking['cancellationPolicySnapshot'],
    'snapshot.booking.cancellationPolicySnapshot',
  );
  const termsAcceptanceSnapshot = assertOpaqueJsonObject(
    booking['termsAcceptanceSnapshot'],
    'snapshot.booking.termsAcceptanceSnapshot',
  );

  const marketplaceKeysPresent = BOOKING_MARKETPLACE_OPTIONAL_KEYS.filter((key) => key in booking);
  let marketplaceFeeBaseAmountMinor: number | undefined;
  let customerServiceFeeAmountMinor: number | undefined;
  let customerTotalAmountMinor: number | undefined;
  let marketplaceFeeRuleVersion: string | undefined;
  if (marketplaceKeysPresent.length > 0) {
    if (marketplaceKeysPresent.length !== BOOKING_MARKETPLACE_OPTIONAL_KEYS.length) {
      invariant('snapshot.booking contient un snapshot marketplace incomplet');
    }
    marketplaceFeeBaseAmountMinor = assertNonNegSafeInt(
      booking['marketplaceFeeBaseAmountMinor'],
      'snapshot.booking.marketplaceFeeBaseAmountMinor',
    );
    customerServiceFeeAmountMinor = assertNonNegSafeInt(
      booking['customerServiceFeeAmountMinor'],
      'snapshot.booking.customerServiceFeeAmountMinor',
    );
    customerTotalAmountMinor = assertNonNegSafeInt(
      booking['customerTotalAmountMinor'],
      'snapshot.booking.customerTotalAmountMinor',
    );
    marketplaceFeeRuleVersion = assertNonEmptyString(
      booking['marketplaceFeeRuleVersion'],
      'snapshot.booking.marketplaceFeeRuleVersion',
    );
    if (
      safeSumMinor([subtotalAmountMinor, mandatoryFeesAmountMinor]) !==
      marketplaceFeeBaseAmountMinor
    ) {
      invariant('snapshot.booking marketplaceFeeBaseAmountMinor est incoherent');
    }
    if (
      safeSumMinor([marketplaceFeeBaseAmountMinor, customerServiceFeeAmountMinor]) !==
      customerTotalAmountMinor
    ) {
      invariant('snapshot.booking customerTotalAmountMinor est incoherent');
    }
  }

  const marketplaceFields =
    marketplaceFeeBaseAmountMinor === undefined
      ? {}
      : {
          marketplaceFeeBaseAmountMinor,
          customerServiceFeeAmountMinor: customerServiceFeeAmountMinor!,
          customerTotalAmountMinor: customerTotalAmountMinor!,
          marketplaceFeeRuleVersion: marketplaceFeeRuleVersion!,
        };

  // payment
  const payment = assertObject(root['payment'], 'snapshot.payment');
  assertExactKeys(payment, PAYMENT_KEYS, 'snapshot.payment', FORBIDDEN_PAYMENT_KEYS);
  const pId = assertUuid(payment['id'], 'snapshot.payment.id');
  const pStatus = assertNonEmptyString(payment['status'], 'snapshot.payment.status');
  if (pStatus !== 'SUCCEEDED') {
    invariant('snapshot.payment.status n est pas SUCCEEDED');
  }
  const succeededAt = assertCanonicalIso(payment['succeededAt'], 'snapshot.payment.succeededAt');
  const amountMinor = assertNonNegSafeInt(payment['amountMinor'], 'snapshot.payment.amountMinor');
  const paymentCurrency = assertNonEmptyString(payment['currency'], 'snapshot.payment.currency');
  if (paymentCurrency !== bookingCurrency) {
    invariant('snapshot.payment.currency doit etre egal a snapshot.booking.currency');
  }
  if (customerTotalAmountMinor !== undefined && amountMinor !== customerTotalAmountMinor) {
    invariant('snapshot.payment.amountMinor doit etre egal au customerTotalAmountMinor');
  }
  const financialTermsVersion = assertNonEmptyString(
    payment['financialTermsVersion'],
    'snapshot.payment.financialTermsVersion',
  );
  const legalTermsVersion = assertNonEmptyString(
    payment['legalTermsVersion'],
    'snapshot.payment.legalTermsVersion',
  );

  // Cohérences racine ↔ sous-objets.
  if (orgId !== organizationId) {
    invariant('snapshot.organization.id doit etre egal a snapshot.organizationId');
  }
  if (bId !== bookingId) {
    invariant('snapshot.booking.id doit etre egal a snapshot.bookingId');
  }
  if (pId !== paymentId) {
    invariant('snapshot.payment.id doit etre egal a snapshot.paymentId');
  }

  // lines
  if (!Array.isArray(root['lines'])) {
    invariant('snapshot.lines n est pas un tableau');
  }
  const rawLines = root['lines'] as unknown[];
  if (rawLines.length === 0) {
    invariant('snapshot.lines doit contenir au moins un element');
  }
  const lineIds = new Set<string>();
  let prevLineId = '';
  const lines: Array<DocumentRenderSnapshotV1['lines'][number]> = [];
  for (let i = 0; i < rawLines.length; i++) {
    const line = assertObject(rawLines[i], `snapshot.lines[${i}]`);
    assertExactKeys(line, LINE_KEYS, `snapshot.lines[${i}]`, undefined, LINE_OPTIONAL_KEYS);
    // G7P-B2-C Round 3 (P0-2) — strict flexible key validation for lines.
    // Each line's flexible keys must match the booking's pricingSnapshotVersion.
    assertFlexibleKeysStrict(
      line,
      LINE_OPTIONAL_KEYS,
      bookingPricingSnapshotVersion,
      `snapshot.lines[${i}]`,
    );
    const lineId = assertUuid(line['lineId'], `snapshot.lines[${i}].lineId`);
    const variantId = assertUuid(line['variantId'], `snapshot.lines[${i}].variantId`);
    const quantity = assertPosSafeInt(line['quantity'], `snapshot.lines[${i}].quantity`);
    const unitPriceAmountMinor = assertNonNegSafeInt(
      line['unitPriceAmountMinor'],
      `snapshot.lines[${i}].unitPriceAmountMinor`,
    );
    const billableUnitCount = assertPosSafeInt(
      line['billableUnitCount'],
      `snapshot.lines[${i}].billableUnitCount`,
    );
    const lineTotalAmountMinor = assertNonNegSafeInt(
      line['lineTotalAmountMinor'],
      `snapshot.lines[${i}].lineTotalAmountMinor`,
    );
    const lineCurrency = assertNonEmptyString(line['currency'], `snapshot.lines[${i}].currency`);
    if (lineCurrency !== bookingCurrency) {
      invariant(`snapshot.lines[${i}].currency doit etre egal a snapshot.booking.currency`);
    }
    const variantSnapshot = assertOpaqueJsonObject(
      line['variantSnapshot'],
      `snapshot.lines[${i}].variantSnapshot`,
    );
    if (lineIds.has(lineId)) {
      invariant('snapshot.lines contient un doublon de lineId');
    }
    lineIds.add(lineId);
    if (lineId < prevLineId) {
      invariant('snapshot.lines n est pas trie par lineId');
    }
    prevLineId = lineId;
    lines.push({
      lineId,
      variantId,
      quantity,
      unitPriceAmountMinor,
      billableUnitCount,
      lineTotalAmountMinor,
      currency: lineCurrency,
      variantSnapshot,
    });
  }

  // Recoupement inter-objets : somme des lineTotalAmountMinor === booking.subtotalAmountMinor.
  const linesTotal = safeSumMinor(lines.map((l) => l.lineTotalAmountMinor));
  if (linesTotal !== subtotalAmountMinor) {
    invariant('somme des lineTotalAmountMinor != booking.subtotalAmountMinor');
  }

  // items
  if (!Array.isArray(root['items'])) {
    invariant('snapshot.items n est pas un tableau');
  }
  const rawItems = root['items'] as unknown[];
  if (rawItems.length === 0) {
    invariant('snapshot.items doit contenir au moins un element');
  }
  const itemIds = new Set<string>();
  let prevItemId = '';
  const items: Array<DocumentRenderSnapshotV1['items'][number]> = [];
  for (let i = 0; i < rawItems.length; i++) {
    const item = assertObject(rawItems[i], `snapshot.items[${i}]`);
    assertExactKeys(item, ITEM_KEYS, `snapshot.items[${i}]`);
    const bookingItemId = assertUuid(item['bookingItemId'], `snapshot.items[${i}].bookingItemId`);
    const bookingLineId = assertUuid(item['bookingLineId'], `snapshot.items[${i}].bookingLineId`);
    const inventoryItemId = assertUuid(
      item['inventoryItemId'],
      `snapshot.items[${i}].inventoryItemId`,
    );
    const internalSku = assertNonEmptyString(
      item['internalSku'],
      `snapshot.items[${i}].internalSku`,
    );
    const serialNumber = assertNullableString(
      item['serialNumber'],
      `snapshot.items[${i}].serialNumber`,
    );
    const condition = assertEnum(
      item['condition'],
      INVENTORY_CONDITIONS_SET,
      `snapshot.items[${i}].condition`,
    );
    const invStatus = assertEnum(
      item['inventoryStatus'],
      INVENTORY_STATUSES_SET,
      `snapshot.items[${i}].inventoryStatus`,
    );
    if (!lineIds.has(bookingLineId)) {
      invariant(`snapshot.items[${i}].bookingLineId ne reference aucune line`);
    }
    if (itemIds.has(bookingItemId)) {
      invariant('snapshot.items contient un doublon de bookingItemId');
    }
    itemIds.add(bookingItemId);
    if (bookingItemId < prevItemId) {
      invariant('snapshot.items n est pas trie par bookingItemId');
    }
    prevItemId = bookingItemId;
    items.push({
      bookingItemId,
      bookingLineId,
      inventoryItemId,
      internalSku,
      serialNumber,
      condition,
      inventoryStatus: invStatus,
    });
  }

  return {
    snapshotVersion: SNAPSHOT_VERSION,
    sourceOutboxEventId,
    organizationId,
    bookingId,
    paymentId,
    draftId,
    capturedAt,
    organization: { id: orgId, legalName },
    location: {
      id: locId,
      name: locName,
      addressLine1,
      addressLine2,
      city,
      postalCode,
      countryCode,
      timeZone,
    },
    customer: { userId, displayName, locale },
    booking: {
      id: bId,
      status: bStatus,
      customerStartAt,
      customerEndAt,
      confirmedAt,
      prepBufferMinutes,
      cleanupBufferMinutes,
      currency: bookingCurrency,
      subtotalAmountMinor,
      mandatoryFeesAmountMinor,
      totalAmountMinor,
      ...marketplaceFields,
      taxStatus: bTaxStatus,
      taxAmountMinor,
      taxRateBps,
      cancellationPolicySnapshot,
      termsAcceptanceSnapshot,
    },
    payment: {
      id: pId,
      status: pStatus,
      succeededAt,
      amountMinor,
      currency: paymentCurrency,
      financialTermsVersion,
      legalTermsVersion,
    },
    lines,
    items,
  };
}
