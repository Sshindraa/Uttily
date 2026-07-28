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

export interface OrganizationRecord {
  id: string;
  legalName: string;
  slug: string;
  status: OrganizationStatus;
  isProfessional: boolean;
  defaultCurrency: string;
}

export interface LocationRecord {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  timeZone: string;
  pickupEnabled: boolean;
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
  ttlSeconds: number;
}
