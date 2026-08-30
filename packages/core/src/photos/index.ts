/**
 * @uttily/core — Module Photos (G7F-A2).
 *
 * Métadonnées photo produit, validation binaire, upload idempotent, gate de
 * publication publique et suppression de photos.
 */

export { PhotoError, type PhotoErrorCode } from './errors';
export { PostgresPhotoPublicationGate } from './postgres-publication-gate';
export {
  BIKE_CATEGORY_SLUG,
  REQUIRED_BIKE_PHOTO_SLOTS,
  missingRequiredBikePhotoSlots,
} from './photo-publication-rules';
export { deleteProductPhoto } from './delete-product-photo';
export { uploadProductPhoto, type UploadProductPhotoInput } from './upload-product-photo';
export { replaceProductPhoto, type ReplaceProductPhotoInput } from './replace-product-photo';
export {
  PRODUCT_PHOTO_CONTENT_TYPES,
  PRODUCT_PHOTO_MAX_BYTES,
  PRODUCT_PHOTO_MIN_DIMENSION,
  PRODUCT_PHOTO_MAX_DIMENSION,
  validateProductPhoto,
  type ProductPhotoContentType,
  type ValidatedProductPhoto,
} from './validate-product-photo';
export {
  type ProductPhotoStorage,
  type ProductPhotoStorageMetadata,
  type ProductPhotoStoragePutResult,
} from './storage';
