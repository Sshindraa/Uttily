import { getAuthenticatedUser } from './auth';
import { getDb } from './db';
import {
  getMembership,
  requireCatalogManager,
  requireCatalogViewer,
  type AuthenticatedUser,
} from '@uttily/core';
import type { DatabaseClient } from '@uttily/database';

/**
 * Helpers d'autorisation partagés pour le module Catalog & Inventory.
 *
 * Précision produit : le helper vit dans `lib/` (pas dans `app/actions/`)
 * car il est utilisé à la fois par les Server Actions et par les Server
 * Components (pages de lecture).
 *
 * Note sur l'erreur non authentifié : le helper lance `Error('UNAUTHENTICATED')`
 * (pas `AuthorizationError`) pour le cas non authentifié. Les actions catchent
 * cette erreur via `runAction` et la mappent vers `code: 'UNAUTHENTICATED'`.
 * `requireCatalogManager`/`requireCatalogViewer` lèvent `AuthorizationError`
 * qui sera mappée vers `FORBIDDEN` (ou `NOT_FOUND` si le message contient
 * "introuvable").
 */

export interface CatalogManagerContext {
  user: AuthenticatedUser;
  db: DatabaseClient;
  organizationId: string;
}

export interface CatalogViewerContext {
  user: AuthenticatedUser;
  db: DatabaseClient;
  organizationId: string;
}

/**
 * Authentifie l'utilisateur et vérifie qu'il est manager du catalogue de l'org.
 * Retourne le contexte (user, db, organizationId) ou lance une erreur d'auth.
 */
export async function requireCatalogManagerOf(
  organizationId: string,
): Promise<CatalogManagerContext> {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('UNAUTHENTICATED');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireCatalogManager(membership);
  return { user, db, organizationId };
}

/**
 * Authentifie l'utilisateur et vérifie qu'il est viewer du catalogue de l'org.
 */
export async function requireCatalogViewerOf(
  organizationId: string,
): Promise<CatalogViewerContext> {
  const user = await getAuthenticatedUser();
  if (!user) throw new Error('UNAUTHENTICATED');
  const db = getDb();
  const membership = await getMembership(db, organizationId, user.id);
  requireCatalogViewer(membership);
  return { user, db, organizationId };
}
