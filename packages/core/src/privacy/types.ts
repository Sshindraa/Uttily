// ---------------------------------------------------------------------------
// Lot 21-P1 — Types pour le module privacy (RGPD articles 12-23).
// ---------------------------------------------------------------------------

/** Types de demandes RGPD acceptés par le registre. */
export type PrivacyRequestType =
  'ACCESS' | 'PORTABILITY' | 'RECTIFICATION' | 'ERASURE' | 'OPPOSITION' | 'RESTRICTION';

/** Statuts du cycle de traitement opérationnel d'une demande RGPD. */
export type PrivacyRequestStatusValue =
  | 'RECEIVED'
  | 'IDENTITY_CHECK_REQUIRED'
  | 'IN_REVIEW'
  | 'DECISION_READY'
  | 'COMPLETED'
  | 'CANCELLED';

/** Statuts de résolution juridique de la demande. */
export type PrivacyResolutionStatusValue = 'FULFILLED' | 'PARTIALLY_FULFILLED' | 'REFUSED';

/** Motifs fermés de refus ou d'annulation. */
export type PrivacyDecisionReasonCode =
  | 'LEGAL_RETENTION_OBLIGATION'
  | 'LITIGATION_HOLD'
  | 'IDENTITY_NOT_VERIFIED'
  | 'THIRD_PARTY_RIGHTS'
  | 'MANIFESTLY_UNFOUNDED'
  | 'ALREADY_FULFILLED'
  | 'TECHNICALLY_IMPOSSIBLE';

export const VALID_PRIVACY_REQUEST_TYPES: readonly PrivacyRequestType[] = [
  'ACCESS',
  'PORTABILITY',
  'RECTIFICATION',
  'ERASURE',
  'OPPOSITION',
  'RESTRICTION',
] as const;

// ---------------------------------------------------------------------------
// Résultats des mutations / queries
// ---------------------------------------------------------------------------

export interface PrivacyRequest {
  readonly id: string;
  readonly requestType: PrivacyRequestType;
  readonly status: PrivacyRequestStatusValue;
  readonly resolution?: PrivacyResolutionStatusValue | null;
  readonly receivedAt: Date;
  readonly responseDueAt: Date;
  readonly extendedUntil: Date | null;
  readonly resolvedAt: Date | null;
}

/** Résumé exposé au client (pas de details ni resolution_notes). */
export interface PrivacyRequestSummary {
  readonly id: string;
  readonly requestType: PrivacyRequestType;
  readonly status: PrivacyRequestStatusValue;
  readonly resolution?: PrivacyResolutionStatusValue | null;
  readonly receivedAt: Date;
  readonly responseDueAt: Date;
  readonly extendedUntil: Date | null;
  readonly resolvedAt: Date | null;
}

// ---------------------------------------------------------------------------
// Export de données personnelles — Art. 15 & Art. 20
// ---------------------------------------------------------------------------

export interface Article15PersonalDataCopy {
  readonly profile: {
    readonly id: string;
    readonly displayName: string | null;
    readonly locale: string;
    readonly createdAt: string; // ISO 8601
    readonly updatedAt: string;
  };
  readonly bookings: ReadonlyArray<{
    readonly bookingId: string;
    readonly status: string;
    readonly customerStartAt: string;
    readonly customerEndAt: string;
    readonly timezone: string;
    readonly location: {
      readonly name: string;
      readonly addressLine1: string;
      readonly city: string;
      readonly postalCode: string;
      readonly countryCode: string;
    };
    readonly items: ReadonlyArray<{
      readonly categoryName: string;
      readonly variantLabel: string;
    }>;
    readonly payment: {
      readonly amountMinor: number;
      readonly currency: string;
      readonly status: string;
      readonly paidAt: string | null;
      readonly refundAmountMinor: number | null;
    };
    readonly termsAcceptance: {
      readonly version: string;
      readonly acceptedAt: string | null;
    };
    readonly documents: ReadonlyArray<{
      readonly documentId: string;
      readonly bookingId: string;
      readonly type: string;
      readonly generatedAt: string;
      readonly consultationPath: string;
    }>;
  }>;
}

export interface Article20PortableData {
  readonly profileProvided: {
    readonly email: string;
    readonly displayName: string | null;
    readonly locale: string;
  };
  readonly bookingsInitiated: ReadonlyArray<{
    readonly bookingId: string;
    readonly customerStartAt: string;
    readonly customerEndAt: string;
    readonly timezone: string;
    readonly locationName: string;
    readonly items: ReadonlyArray<{
      readonly categoryName: string;
      readonly variantLabel: string;
    }>;
  }>;
}

export interface PersonalDataExport {
  readonly exportedAt: string;
  readonly uttily_export_version: '1.0';
  readonly article15_personal_data_copy: Article15PersonalDataCopy;
  readonly article20_portable_data: Article20PortableData;
}
