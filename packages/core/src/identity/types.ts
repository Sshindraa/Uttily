export const MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'MANAGER', 'STAFF'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const MEMBERSHIP_STATUSES = ['ACTIVE', 'SUSPENDED', 'REMOVED'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const INVITATION_STATUSES = ['PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED'] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const ORGANIZATION_STATUSES = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export type OrganizationStatus = (typeof ORGANIZATION_STATUSES)[number];

export interface AuthenticatedUser {
  /** Identifiant Uttily (table users). */
  id: string;
  /** Sujet OIDC (Clerk user id). */
  oidcSubject: string;
  email: string;
  emailVerified: boolean;
  isPlatformAdmin: boolean;
}

export interface MembershipRecord {
  organizationId: string;
  userId: string;
  role: MembershipRole;
  status: MembershipStatus;
}

export const LEGAL_FORMS = [
  'SAS',
  'SASU',
  'SARL',
  'EURL',
  'EI',
  'SA',
  'SNC',
  'ASSOCIATION',
  'OTHER',
] as const;

export type LegalForm = (typeof LEGAL_FORMS)[number];

export function getLegalFormLabel(form?: string | null): string {
  switch (form) {
    case 'SAS':
      return 'Société par Actions Simplifiée (SAS)';
    case 'SASU':
      return 'Société par Actions Simplifiée Unipersonnelle (SASU)';
    case 'SARL':
      return 'Société à Responsabilité Limitée (SARL)';
    case 'EURL':
      return 'Entreprise Unipersonnelle à Responsabilité Limitée (EURL)';
    case 'EI':
      return 'Entreprise Individuelle / Micro-entreprise (EI)';
    case 'SA':
      return 'Société Anonyme (SA)';
    case 'SNC':
      return 'Société en Nom Collectif (SNC)';
    case 'ASSOCIATION':
      return 'Association déclarée (Loi 1901)';
    case 'OTHER':
      return 'Autre forme juridique';
    default:
      return form ? form : 'Non spécifiée';
  }
}

export interface OrganizationRecord {
  id: string;
  legalName: string;
  publicDisplayName: string | null;
  slug: string;
  status: OrganizationStatus;
  isProfessional: boolean;
  defaultCurrency: string;
  defaultCancellationPolicyCode: string;
  legalForm: string | null;
  registrationNumber: string | null;
  vatNumber: string | null;
  registryCity: string | null;
  capitalAmount: string | null;
  legalRepresentativeName: string | null;
  registeredOfficeAddress: string | null;
  registeredOfficePostalCode: string | null;
  registeredOfficeCity: string | null;
  registeredOfficeCountryCode: string | null;
}

export interface LocationRecord {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  timeZone: string;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  postalCode: string | null;
  countryCode: string | null;
  latitude: number | null;
  longitude: number | null;
  pickupEnabled: boolean;
  isPubliclyListed: boolean;
  publicPhone: string | null;
  pickupInstructions: string | null;
  returnInstructions: string | null;
}

export interface LocationScheduleExceptionRecord {
  id: string;
  organizationId: string;
  locationId: string;
  localDate: string;
  kind: 'CLOSED' | 'OPEN_INTERVAL';
  openTime: string | null;
  closeTime: string | null;
  reason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface LocationCoordinates {
  latitude: number;
  longitude: number;
}

export interface OpeningHourInput {
  weekday: number;
  openTime: string; // HH:MM:SS
  closeTime: string; // HH:MM:SS
}

export interface InvitationInput {
  organizationId: string;
  email: string;
  role: MembershipRole;
  invitedBy: string;
  ttlSeconds?: number;
}
