/**
 * @uttily/core — Ports d'infrastructure pour les documents transactionnels
 * (Lot 6 G5B, ADR-013).
 *
 * Les ports sont définis indépendamment des fournisseurs. Ils seront implémentés
 * dans G5C (DocumentRenderer), G5D (ObjectStorage) et G5E (TransactionalEmailSender)
 * avec des fakes pour les tests. Aucun SDK S3, email ou PDF n'est choisi dans G5B.
 */

import type {
  EmailInput,
  EmailSendResult,
  ObjectStoragePutResult,
  RenderedDocument,
  StoredObjectMetadata,
} from './types';
import type { DocumentRenderSnapshotV1 } from './snapshot-types';

/**
 * Moteur de rendu déterministe de documents.
 * Reçoit un snapshot versionné (pas des données live). Le rendu est reproductible
 * à snapshot identique : même snapshot → même binaire → même checksum.
 */
export interface DocumentRenderer {
  render(templateKey: string, snapshot: DocumentRenderSnapshotV1): Promise<RenderedDocument>;
}

/**
 * Stockage objet idempotent avec écriture conditionnelle.
 * putIfAbsent est la seule méthode d'écriture : aucun overwrite silencieux.
 * Un objet existant avec checksum/taille/contentType identiques est un replay sûr.
 * Un objet existant différent est une anomalie durable.
 */
export interface ObjectStorage {
  putIfAbsent(input: {
    readonly key: string;
    readonly content: Uint8Array;
    readonly contentType: string;
    readonly checksumSha256: string;
    readonly sizeBytes: number;
  }): Promise<ObjectStoragePutResult>;

  head(key: string): Promise<StoredObjectMetadata | null>;
  get(key: string): Promise<Uint8Array>;
}

/**
 * Fournisseur d'email transactionnel avec idempotence côté fournisseur.
 * providerIdempotencyKey est obligatoire pour éviter les doubles emails.
 * Si le fournisseur ne supporte pas l'idempotence, le risque de double email
 * est résiduel et documenté (ADR-013 correction 3, question ouverte 14).
 */
export interface TransactionalEmailSender {
  send(input: EmailInput): Promise<EmailSendResult>;
}
