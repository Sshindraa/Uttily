/**
 * @uttily/worker — Sweeper et reclaim (G5F, ADR-013 §7).
 *
 * Le reclaim des événements PROCESSING avec lease expirée passe par
 * `claimOutboxBatch` (qui filtre déjà `(lease_until IS NULL OR lease_until <= now())`
 * et `status IN ('PENDING','PROCESSING')`). Le sweeper NE duplique PAS la
 * logique SQL existante.
 *
 * Mécanisme de reclaim (documenté pour clarté) :
 * - Un événement abandonné (worker crashé) a `status='PROCESSING'` avec
 *   `lease_until` dans le passé. Lors du prochain `claimOutboxBatch`,
 *   la condition `lease_until <= now()` le rend re-claimable.
 * - `attempt_count` est incrémenté à chaque claim par
 *   `incrementStrategy='always'` (ADR-013 §7).
 * - `MAX_ATTEMPTS = 5` est respecté via le filtre `attempt_count < MAX_ATTEMPTS`
 *   dans `claimOutboxBatch`.
 * - Un ancien worker ne peut plus persister ses résultats car les pipelines
 *   G5D/G5E utilisent le fencing par `lease_token` dans les transactions
 *   Phase C (SELECT FOR UPDATE avec `lease_token` + `lease_until > now()`).
 *   Si le lease a expiré, le fencing échoue → `LEASE_LOST`, pas de persistance.
 *
 * Le sweeper est une orchestration du cycle existant, pas une nouvelle SQL.
 * Aucun UPDATE global non protégé n'est exécuté.
 */

import type { WorkerDependencies, WorkerCycleOptions, WorkerCycleResult } from './worker-cycle.js';
import { runTransactionalDocumentsWorkerCycle } from './worker-cycle.js';

/**
 * Options du sweeper. Identiques à WorkerCycleOptions : le sweeper est un
 * cycle normal dont le claim existant reclaime automatiquement les events
 * PROCESSING avec lease expirée.
 */
export type SweeperOptions = WorkerCycleOptions;

/**
 * Exécute un cycle de sweeper/reclaim.
 *
 * Le sweeper appelle `runTransactionalDocumentsWorkerCycle` (qui exécute
 * documents puis emails). Le claim existant reclaime automatiquement les
 * events PROCESSING avec lease expirée via `claimOutboxBatch`.
 *
 * Le sweeper logge `cycle_started`/`cycle_completed` comme un cycle normal
 * (délégué à `runTransactionalDocumentsWorkerCycle`).
 *
 * Aucun UPDATE global non protégé n'est exécuté. Le sweeper est une
 * orchestration du cycle existant, pas une nouvelle SQL.
 */
export async function runSweeperCycle(
  deps: WorkerDependencies,
  options: SweeperOptions = {},
): Promise<WorkerCycleResult> {
  // Le sweeper est un cycle normal : le claim existant reclaime
  // automatiquement les events PROCESSING avec lease expirée.
  // Aucune logique SQL supplémentaire n'est nécessaire.
  return runTransactionalDocumentsWorkerCycle(deps, options);
}
