import { getAuthenticatedUser } from './auth';
import { getDb } from './db';
import {
  getMembership,
  requireMembership,
  ROLE_MANAGERS,
  type AuthenticatedUser,
} from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';

export interface FinancialViewerContext {
  user: AuthenticatedUser;
  db: DatabaseClient;
  organizationId: string;
}

export async function requireFinancialViewerOf(
  organizationId: string,
): Promise<FinancialViewerContext> {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('UNAUTHENTICATED');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireMembership(membership, ROLE_MANAGERS);
  return { user, db, organizationId };
}
