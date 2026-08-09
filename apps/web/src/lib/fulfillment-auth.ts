import { getAuthenticatedUser } from './auth';
import { getDb } from './db';
import { getMembership, requireFulfillmentOperator, type AuthenticatedUser } from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';

/**
 * Helpers d'autorisation partagés pour le module Fulfillment (G4A).
 *
 * Précision produit : le helper vit dans `lib/` (pas dans `app/actions/`)
 * car il est utilisé à la fois par les Server Actions et par les Server
 * Components (pages de lecture des opérations).
 *
 * Defense in depth : ce helper vérifie l'authentification et la membership côté
 * web AVANT d'appeler les use cases Core. Les use cases Core refont le contrôle
 * dans la transaction (verifyFulfillmentMembership). Le helper Web ne remplace
 * jamais l'autorisation Core.
 *
 * Note sur l'erreur non authentifié : le helper lance `Error('UNAUTHENTICATED')`
 * (pas `AuthorizationError`) pour le cas non authentifié. Les actions catchent
 * cette erreur via `runAction` et la mappent vers `code: 'UNAUTHENTICATED'`.
 * `requireFulfillmentOperator` lève `AuthorizationError` qui sera mappée vers
 * `FORBIDDEN`.
 */

export interface FulfillmentOperatorContext {
  user: AuthenticatedUser;
  db: DatabaseClient;
  organizationId: string;
}

/**
 * Authentifie l'utilisateur et vérifie qu'il est opérateur fulfillment de l'org.
 * Retourne le contexte (user, db, organizationId) ou lance une erreur d'auth.
 *
 * MVP (ADR-011) : tous les membres actifs (OWNER, ADMIN, MANAGER, STAFF) sont autorisés.
 */
export async function requireFulfillmentOperatorOf(
  organizationId: string,
): Promise<FulfillmentOperatorContext> {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('UNAUTHENTICATED');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireFulfillmentOperator(membership);
  return { user, db, organizationId };
}
