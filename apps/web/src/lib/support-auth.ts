import { getAuthenticatedUser } from './auth';
import { getDb } from './db';
import { requirePlatformAdmin, type AuthenticatedUser } from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';

export interface SupportPlatformAdminContext {
  user: AuthenticatedUser;
  db: DatabaseClient;
}

/**
 * Garde d'accès interne strict pour le back-office Uttily.
 * Fail-closed si non-authentifié ou si isPlatformAdmin !== true.
 */
export async function requireSupportPlatformAdmin(): Promise<SupportPlatformAdminContext> {
  const user = await getAuthenticatedUser();
  if (!user) {
    throw new Error('UNAUTHENTICATED');
  }
  requirePlatformAdmin(user);
  const db = getDb();
  return { user, db };
}
