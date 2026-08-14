import { getAuthenticatedUser } from './auth';
import { getDb } from './db';
import {
  getMembership,
  requireMembership,
  LOCATION_MANAGERS,
  type AuthenticatedUser,
} from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';

export interface AmendmentManagerContext {
  user: AuthenticatedUser;
  db: DatabaseClient;
  organizationId: string;
}

export interface AmendmentEntryState {
  canAmend: boolean;
  reason?: 'NOT_CONFIRMED' | 'ACTIVE_AMENDMENT_EXISTS' | 'INSUFFICIENT_ROLE';
}

/**
 * Calcule l'état d'éligibilité d'entrée pour la modification d'une réservation (G7M-C5-A).
 */
export function getAmendmentEntryState(params: {
  bookingStatus: string;
  role: string | null;
  hasActiveAmendment: boolean;
}): AmendmentEntryState {
  if (params.bookingStatus !== 'CONFIRMED') {
    return { canAmend: false, reason: 'NOT_CONFIRMED' };
  }
  if (!params.role || !(LOCATION_MANAGERS as readonly string[]).includes(params.role)) {
    return { canAmend: false, reason: 'INSUFFICIENT_ROLE' };
  }
  if (params.hasActiveAmendment) {
    return { canAmend: false, reason: 'ACTIVE_AMENDMENT_EXISTS' };
  }
  return { canAmend: true };
}

/**
 * Authentifie l'utilisateur et vérifie qu'il est manager autorisé de l'organisation
 * (OWNER, ADMIN, MANAGER) pour la modification de réservations (G7M-C5-A).
 * Rejette STAFF et les non-membres avec FORBIDDEN.
 */
export async function requireAmendmentManagerOf(
  organizationId: string,
): Promise<AmendmentManagerContext> {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('UNAUTHENTICATED');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, LOCATION_MANAGERS);
  return { user, db, organizationId };
}
