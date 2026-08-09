/**
 * Erreurs métier du read model dashboard G7G.
 *
 * Le dashboard est une lecture interne, mais ses entrées restent validées
 * côté Core afin qu'aucun appelant ne puisse obtenir un fallback implicite.
 */
export type DashboardErrorCode = 'VALIDATION';

export class DashboardError extends Error {
  readonly code: DashboardErrorCode;

  constructor(code: DashboardErrorCode, message: string) {
    super(message);
    this.name = 'DashboardError';
    this.code = code;
  }
}
