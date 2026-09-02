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
export * from './duplicate-product';
export * from './variants';
export * from './inventory';
export * from './inventory-batch';
export * from './inventory-transfer-batch';
export * from './inventory-status-batch';
export * from './movements';
export * from './read-models';
export * from './unified-bike';
export * from './bike-setup-progress';
export * from './equipment-taxonomy';
