/**
 * Port minimal du stockage des images produit.
 * Le Core ne connaît ni R2 ni le SDK S3 : l'adapter est fourni par l'application.
 */

export interface ProductPhotoStorageMetadata {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly checksumSha256: string | null;
}

export type ProductPhotoStoragePutResult =
  | { readonly kind: 'CREATED' }
  | {
      readonly kind: 'ALREADY_EXISTS';
      readonly metadata: ProductPhotoStorageMetadata;
    };

export interface ProductPhotoStorage {
  putIfAbsent(input: {
    readonly key: string;
    readonly content: Uint8Array;
    readonly contentType: string;
    readonly checksumSha256: string;
    readonly sizeBytes: number;
  }): Promise<ProductPhotoStoragePutResult>;
  head(key: string): Promise<ProductPhotoStorageMetadata | null>;
  get(key: string): Promise<Uint8Array>;
  deleteIfPresent(key: string): Promise<void>;
}
