/**
 * @uttily/core — Module Photos (G7F-A2).
 *
 * Métadonnées photo produit, gate de publication publique et suppression
 * de photos. Aucun upload R2, aucun objet binaire, aucun worker, aucun
 * outbox event (reportés à G7F-B).
 */

export { PhotoError, type PhotoErrorCode } from './errors';
export { PostgresPhotoPublicationGate } from './postgres-publication-gate';
export { deleteProductPhoto } from './delete-product-photo';
