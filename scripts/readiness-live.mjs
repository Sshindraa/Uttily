import { checkLiveReadiness } from '../packages/core/src/live-readiness/check-live-readiness.ts';

/**
 * Contrôle LIVE strictement non destructif.
 * Le rapport contient uniquement noms, descriptions et statuts — jamais les
 * valeurs des variables ni de détail fournisseur.
 */
const report = checkLiveReadiness(process.env);
console.log(JSON.stringify(report, null, 2));
process.exitCode = report.ready ? 0 : 1;
