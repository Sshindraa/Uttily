/**
 * @uttily/core — Module Catalog & Inventory (Lot 2A).
 *
 * Catalogue (catégories globales, produits, variantes) et inventaire physique
 * (exemplaires, mouvements). Isolation multi-tenant garantie par PostgreSQL.
 */

export * from './types';
export * from './permissions';
export * from './errors';
export * from './categories';
export * from './products';
export * from './variants';
export * from './inventory';
export * from './movements';
export * from './read-models';
