/**
 * @uttily/core — Fake déterministe en mémoire pour ObjectStorage (G5D, ADR-013 §5).
 *
 * NE JAMAIS utiliser en production. Fake en mémoire pour tests uniquement.
 *
 * Comportement :
 * - putIfAbsent : copie défensive du Uint8Array. Si clé absente → stocke la
 *   copie, retourne { kind: 'CREATED' }. Si clé existe → retourne
 *   { kind: 'ALREADY_EXISTS', metadata } sans JAMAIS modifier l'objet existant.
 * - head : retourne une copie des métadonnées ou null.
 * - get : retourne une copie défensive du contenu, ou throw si introuvable.
 *
 * Injection de panne contrôlable via options du constructeur :
 * - failPut : putIfAbsent lève toujours une erreur (erreur transitoire simulée).
 * - failHead : head() lève toujours une erreur (erreur transitoire simulée).
 * - omitChecksum : metadata.checksumSha256 = null (fournisseur sans checksum fiable).
 * - notFoundOnGet : get lève toujours une erreur même si l'objet existe.
 * - returnDifferentContent : get/head retourne un contenu différent (test de
 *   mismatch de checksum).
 */

import type { ObjectStorage } from './ports';
import type { ObjectStoragePutResult, StoredObjectMetadata } from './types';

interface StoredObject {
  readonly content: Uint8Array;
  readonly contentType: string;
  readonly checksumSha256: string | null;
  readonly sizeBytes: number;
}

export interface InMemoryObjectStorageOptions {
  /** putIfAbsent lève toujours une erreur (erreur transitoire simulée). */
  readonly failPut?: boolean;
  /** head() lève toujours une erreur (erreur transitoire simulée). */
  readonly failHead?: boolean;
  /** metadata.checksumSha256 = null (fournisseur sans checksum fiable). */
  readonly omitChecksum?: boolean;
  /** get lève toujours une erreur même si l'objet existe. */
  readonly notFoundOnGet?: boolean;
  /** get/head retourne un contenu différent (test de mismatch de checksum). */
  readonly returnDifferentContent?: boolean;
}

/**
 * Fake en mémoire pour ObjectStorage.
 *
 * NE JAMAIS utiliser en production.
 */
export class InMemoryObjectStorage implements ObjectStorage {
  private readonly store = new Map<string, StoredObject>();
  private readonly options: InMemoryObjectStorageOptions;

  constructor(options: InMemoryObjectStorageOptions = {}) {
    this.options = options;
  }

  async putIfAbsent(input: {
    readonly key: string;
    readonly content: Uint8Array;
    readonly contentType: string;
    readonly checksumSha256: string;
    readonly sizeBytes: number;
  }): Promise<ObjectStoragePutResult> {
    if (this.options.failPut) {
      throw new Error('InMemoryObjectStorage: failPut simulé (erreur transitoire)');
    }

    const existing = this.store.get(input.key);
    if (existing) {
      // JAMAIS overwrite — retourner ALREADY_EXISTS avec les métadonnées de
      // l'objet existant.
      return {
        kind: 'ALREADY_EXISTS',
        metadata: {
          contentType: existing.contentType,
          sizeBytes: existing.sizeBytes,
          checksumSha256: existing.checksumSha256,
        },
      };
    }

    // Copie défensive du contenu.
    const contentCopy = new Uint8Array(input.content.length);
    contentCopy.set(input.content);

    this.store.set(input.key, {
      content: contentCopy,
      contentType: input.contentType,
      checksumSha256: this.options.omitChecksum ? null : input.checksumSha256,
      sizeBytes: input.sizeBytes,
    });

    return { kind: 'CREATED' };
  }

  async head(key: string): Promise<StoredObjectMetadata | null> {
    if (this.options.failHead) {
      throw new Error('InMemoryObjectStorage: failHead simulé (erreur transitoire)');
    }

    const obj = this.store.get(key);
    if (!obj) return null;

    if (this.options.returnDifferentContent) {
      // Retourner des métadonnées avec un sizeBytes différent pour simuler un
      // mismatch.
      return {
        contentType: obj.contentType,
        sizeBytes: obj.sizeBytes + 1,
        checksumSha256: obj.checksumSha256,
      };
    }

    return {
      contentType: obj.contentType,
      sizeBytes: obj.sizeBytes,
      checksumSha256: obj.checksumSha256,
    };
  }

  async get(key: string): Promise<Uint8Array> {
    if (this.options.notFoundOnGet) {
      throw new Error(`InMemoryObjectStorage: objet introuvable (notFoundOnGet simulé) key=${key}`);
    }

    const obj = this.store.get(key);
    if (!obj) {
      throw new Error(`InMemoryObjectStorage: objet introuvable key=${key}`);
    }

    if (this.options.returnDifferentContent) {
      // Retourner un contenu différent pour simuler un mismatch de checksum.
      const different = new Uint8Array(obj.content.length + 1);
      different.set(obj.content);
      different[obj.content.length] = 0xff;
      return different;
    }

    // Copie défensive du contenu.
    const copy = new Uint8Array(obj.content.length);
    copy.set(obj.content);
    return copy;
  }
}
