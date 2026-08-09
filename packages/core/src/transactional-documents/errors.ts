/**
 * @uttily/core — Erreurs typées fermées pour G5C (ADR-013).
 *
 * Codes non sensibles : aucun message d'erreur ne contient de données
 * personnelles, de secrets ou de valeurs métier. Les messages sont
 * génériques et orientés diagnostic technique.
 */

export type DocumentRenderErrorCode =
  | 'VALIDATION'
  | 'EVENT_NOT_FOUND'
  | 'EVENT_CONTRACT_MISMATCH'
  | 'AUTHORITY_MISMATCH'
  | 'SNAPSHOT_INVARIANT'
  | 'UNKNOWN';

export class DocumentRenderError extends Error {
  readonly code: DocumentRenderErrorCode;

  constructor(code: DocumentRenderErrorCode, message: string) {
    super(message);
    this.name = 'DocumentRenderError';
    this.code = code;
  }
}
