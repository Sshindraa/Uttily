/**
 * @uttily/core — Module Availability & Inventory Blocks (Lot 3).
 *
 * Gestion des blocages de disponibilité (holds, bookings, maintenances) et
 * recherche d'exemplaires disponibles. La contrainte d'exclusion PostgreSQL
 * garantit l'absence de chevauchement incompatible au niveau base de données.
 */

export * from './types';
export * from './blocks';
export * from './manual-block';
export * from './recurring-manual-block';
export * from './recurring-manual-block-series';
export * from './availability';
