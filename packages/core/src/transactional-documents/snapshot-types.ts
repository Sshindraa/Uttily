/**
 * @uttily/core — Type fermé et sérialisable pour le snapshot de rendu v1 (G5C, ADR-013).
 *
 * Toutes les dates sont en ISO 8601 UTC canonique (string, format
 * YYYY-MM-DDTHH:mm:ss.sssZ). Le timeZone IANA est conservé séparément. Les
 * montants sont des Number.isSafeInteger. Les tableaux sont triés
 * déterministement par l'appelant.
 *
 * IMPORTANT : Pas de recipientEmail dans le snapshot. Pas de client_secret.
 * Pas de payload Stripe brut. Pas de texte légal inventé. Pas de SIRET/RCS/
 * adresse légale absente.
 *
 * Champs internes explicitement exclus du snapshot client :
 * - commissionAmountMinor : donnée interne de commission plateforme, non
 *   pertinente pour le rendu client.
 * - commissionRuleSnapshot, taxRuleSnapshot : règles internes de calcul, non
 *   exposées au client.
 * - connectedAccountId, environment, onBehalfOfAccountId : identifiants
 *   Stripe Connect internes.
 * - client_secret : secret Stripe, jamais persisté dans le snapshot.
 */

export const SNAPSHOT_VERSION = 'v1' as const;

export interface SnapshotLineItem {
  readonly lineId: string;
  readonly variantId: string;
  readonly quantity: number;
  readonly unitPriceAmountMinor: number;
  readonly billableUnitCount: number;
  readonly lineTotalAmountMinor: number;
  readonly currency: string;
  readonly variantSnapshot: Readonly<Record<string, unknown>>;
  // ── Champs flexibles (G7P-B2-C, ADR-018) ──
  // Optionnels : présents uniquement pour les bookings flexibles
  // (pricingSnapshotVersion === 'flexible-pricing-v1'). Absents pour les
  // bookings legacy (legacy-daily-v1) afin de préserver la forme du snapshot
  // attendue par parseDocumentRenderSnapshotV1.
  readonly pricingPlanId?: string | null;
  readonly pricingPlanVersion?: number | null;
  readonly pricingPlanType?: string | null;
  readonly pricingPublicLabel?: string | null;
  readonly pricingRequestedDurationMinutes?: number | null;
  readonly pricingBilledDurationMinutes?: number | null;
  readonly pricingCoveredDurationMinutes?: number | null;
  readonly pricingBilledDays?: number | null;
  readonly pricingSelectedWindow?: Readonly<Record<string, unknown>> | null;
  readonly pricingDiscountThresholdDays?: number | null;
  readonly pricingDiscountPercent?: number | null;
  readonly pricingAmountBeforeDiscountMinor?: number | null;
  readonly pricingAmountAfterDiscountMinor?: number | null;
  readonly sourceDraftLineId?: string | null;
}

export interface SnapshotBookingItem {
  readonly bookingItemId: string;
  readonly bookingLineId: string;
  readonly inventoryItemId: string;
  readonly internalSku: string;
  readonly serialNumber: string | null;
  readonly condition: string;
  readonly inventoryStatus: string;
}

export interface SnapshotOrganization {
  readonly id: string;
  readonly legalName: string;
  readonly legalForm?: string | null;
  readonly registrationNumber?: string | null;
  readonly vatNumber?: string | null;
  readonly registryCity?: string | null;
  readonly capitalAmount?: string | null;
  readonly legalRepresentativeName?: string | null;
  readonly registeredOfficeAddress?: string | null;
  readonly registeredOfficePostalCode?: string | null;
  readonly registeredOfficeCity?: string | null;
  readonly registeredOfficeCountryCode?: string | null;
}

export interface SnapshotLocation {
  readonly id: string;
  readonly name: string;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
  readonly city: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly timeZone: string;
}

export interface SnapshotCustomer {
  readonly userId: string;
  readonly displayName: string | null;
  readonly locale: string;
}

export interface SnapshotBooking {
  readonly id: string;
  readonly status: string;
  readonly customerStartAt: string;
  readonly customerEndAt: string;
  readonly confirmedAt: string;
  readonly prepBufferMinutes: number;
  readonly cleanupBufferMinutes: number;
  readonly currency: string;
  readonly subtotalAmountMinor: number;
  readonly mandatoryFeesAmountMinor: number;
  readonly totalAmountMinor: number;
  /** Champs publics de split marketplace, présents uniquement pour les nouveaux bookings. */
  readonly marketplaceFeeBaseAmountMinor?: number;
  readonly customerServiceFeeAmountMinor?: number;
  readonly customerTotalAmountMinor?: number;
  readonly marketplaceFeeRuleVersion?: string;
  readonly taxStatus: string;
  readonly taxAmountMinor: number | null;
  readonly taxRateBps: number | null;
  readonly cancellationPolicySnapshot: Readonly<Record<string, unknown>>;
  readonly termsAcceptanceSnapshot: Readonly<Record<string, unknown>>;
  // ── Champs flexibles (G7P-B2-C, ADR-018) ──
  // Optionnels : présents uniquement pour les bookings flexibles
  // (pricingSnapshotVersion === 'flexible-pricing-v1'). Absents pour les
  // bookings legacy (legacy-daily-v1) afin de préserver la forme du snapshot
  // attendue par parseDocumentRenderSnapshotV1.
  readonly timezone?: string;
  readonly billableUnit?: string;
  readonly billableUnitCount?: number;
  readonly pricingSnapshotVersion?: string;
  readonly pricingAlgorithmVersion?: string | null;
  readonly pricingRoundingRuleVersion?: string | null;
  readonly pricingIntentType?: string | null;
  readonly pricingIntentSnapshot?: Readonly<Record<string, unknown>> | null;
  readonly pricingResolvedLocale?: string | null;
}

export interface SnapshotPayment {
  readonly id: string;
  readonly status: string;
  readonly succeededAt: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly financialTermsVersion: string;
  readonly legalTermsVersion: string;
}

export interface DocumentRenderSnapshotV1 {
  readonly snapshotVersion: typeof SNAPSHOT_VERSION;
  readonly sourceOutboxEventId: string;
  readonly organizationId: string;
  readonly bookingId: string;
  readonly paymentId: string;
  readonly draftId: string;
  readonly capturedAt: string;
  readonly organization: SnapshotOrganization;
  readonly location: SnapshotLocation;
  readonly customer: SnapshotCustomer;
  readonly booking: SnapshotBooking;
  readonly payment: SnapshotPayment;
  readonly lines: readonly SnapshotLineItem[];
  readonly items: readonly SnapshotBookingItem[];
}

/**
 * Données chargées depuis les autorités DB, SANS sourceOutboxEventId et
 * capturedAt. Ces deux champs sont ajoutés par get-or-create-document-render-
 * snapshot après validation de l'événement et capture du timestamp
 * transactionnel.
 *
 * Ce type n'est PAS un DocumentRenderSnapshotV1 valide : il ne doit jamais
 * être exposé publiquement comme tel.
 */
export interface LoadedDocumentRenderDataV1 {
  readonly organizationId: string;
  readonly bookingId: string;
  readonly paymentId: string;
  readonly draftId: string;
  readonly organization: SnapshotOrganization;
  readonly location: SnapshotLocation;
  readonly customer: SnapshotCustomer;
  readonly booking: SnapshotBooking;
  readonly payment: SnapshotPayment;
  readonly lines: readonly SnapshotLineItem[];
  readonly items: readonly SnapshotBookingItem[];
}
