/**
 * @uttily/core — Fake déterministe de renderer de documents pour tests G5C (ADR-013).
 *
 * NE JAMAIS utiliser en production. Le rendu est un artefact technique
 * contenant le template key + le JSON canonique du snapshot. Aucun réseau,
 * aucune horloge interne, aucun UUID généré, aucun HTML exécutable, aucun PDF.
 *
 * Déterminisme : mêmes inputs -> mêmes bytes/checksum/taille.
 * Templates différents -> bytes/checksum différents.
 */

import { createHash } from 'node:crypto';
import { DocumentRenderError } from './errors';
import { canonicalJsonBytes } from './canonical-json';
import { parseDocumentRenderSnapshotV1 } from './parse-snapshot';
import type { RenderedDocument } from './types';
import type { DocumentRenderer } from './ports';
import type { DocumentRenderSnapshotV1 } from './snapshot-types';

/**
 * Template keys fermées, techniques uniquement.
 * Le préfixe "technical" empêche toute utilisation accidentelle comme
 * renderer de production.
 */
export const FAKE_TEMPLATE_KEYS = [
  'booking-confirmation-technical-v1',
  'rental-contract-technical-v1',
  'payment-receipt-technical-v1',
] as const;

export type FakeTemplateKey = (typeof FAKE_TEMPLATE_KEYS)[number];

/**
 * Fake déterministe pour tests G5C.
 *
 * NE JAMAIS utiliser en production. Le rendu est un artefact technique
 * contenant le template key + le JSON canonique du snapshot. Aucun réseau,
 * aucune horloge interne, aucun UUID généré, aucun HTML exécutable, aucun PDF.
 *
 * Déterminisme : mêmes inputs -> mêmes bytes/checksum/taille.
 * Templates différents -> bytes/checksum différents.
 *
 * La validation du snapshot est déléguée au parser central
 * parseDocumentRenderSnapshotV1 (validation récursive stricte).
 */
export class FakeDeterministicDocumentRenderer implements DocumentRenderer {
  readonly contentType = 'application/vnd.uttily.test-document+json';

  async render(templateKey: string, snapshot: DocumentRenderSnapshotV1): Promise<RenderedDocument> {
    if (!FAKE_TEMPLATE_KEYS.includes(templateKey as FakeTemplateKey)) {
      throw new DocumentRenderError('VALIDATION', 'template key inconnu');
    }
    parseDocumentRenderSnapshotV1(snapshot);

    const header = `template:${templateKey}\n`;
    const headerBytes = new TextEncoder().encode(header);
    const snapshotBytes = canonicalJsonBytes(snapshot);
    const content = new Uint8Array(headerBytes.length + snapshotBytes.length);
    content.set(headerBytes, 0);
    content.set(snapshotBytes, headerBytes.length);

    const hash = createHash('sha256');
    hash.update(content);
    const checksumSha256 = hash.digest('hex');

    return {
      content,
      contentType: this.contentType,
      checksumSha256,
      sizeBytes: content.length,
    };
  }
}
