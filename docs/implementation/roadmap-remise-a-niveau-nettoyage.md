# Roadmap — remise à niveau, cohérence et nettoyage

**Date de revue :** 2026-08-30
**Branche de référence :** `main` (commit `0ff0f18`)
**Baseline historique :** `chantier/22-b0-split-marketplace-fees` (voir tableau
de baseline ci-dessous)
**Périmètre :** code, schéma, tests, scripts, documentation, CI et préparation du pilote.

## Objectif

Obtenir un dépôt cohérent, maintenable et prêt pour un pilote contrôlé, sans
supprimer de preuve utile ni contourner les décisions Finance, Juridique ou DPO.

Le dépôt contient actuellement une implémentation technique cohérente du split
marketplace `13 % loueur / 7 % client`. Cela ne signifie pas que le modèle est
validé pour la production : `FIN-002` reste bloqué.

Cette roadmap est organisée en trois axes parallèles :

- `GATE-PILOT` : décisions Finance, Juridique, DPO, partenaire et opérations ;
- `SPLIT-HARDENING` : remboursements, snapshots, réconciliation et documents ;
- `REPO-HYGIENE` : installation, documentation, scripts, tests et CI.

Le Go/No-Go et la liste des blockers sont définis exclusivement par le
[`plan de déblocage du pilote`](../operations/pilot-unblock-plan.md). Cette
roadmap ne recopie pas la liste des blockers ; elle indique uniquement les
travaux engineering à déclencher autour de ce plan.

## État de départ

- `pnpm test:fast` passe localement.
- Les deux tests PostgreSQL récemment corrigés pour les garde-fous split passent.
- `pnpm check:fast` passe après réalignement local avec `pnpm install
  --frozen-lockfile` ; les dépendances E2E étaient déjà déclarées dans le
  manifest Web et le lockfile.
- Aucun manifest, lockfile ou réglage TypeScript n'a dû être modifié pour corriger
  ce point.
- `.workbuddy-ai` a été supprimé.
- `apps/web/next-env.d.ts` reste une modification locale préexistante et ne doit
  pas être embarquée dans le chantier de nettoyage.
- Les documents historiques contenant l’ancien taux de 10 % sont conservés,
  mais doivent être clairement identifiés comme historiques.

## Progression enregistrée

- [x] Baseline Git et inventaire différentiel capturés le 2026-08-30.
- [x] Installation locale réalignée avec le lockfile.
- [x] `pnpm check:fast` vert après installation.
- [x] Aucun changement de dépendance ou d'exclusion E2E introduit.
- [x] Contradictions documentaires ciblées sur les migrations 0031 et le lifecycle
  C4-A corrigées sans réécrire les preuves historiques.
- [x] Cartographie des scripts et suites de tests corrigée ; aucun script
  opérationnel, test métier, migration ou document supprimable n'a été confirmé.
- [x] Nettoyage différentiel des manifests effectué : six déclarations inutilisées
  de `@uttily/config` et le script worker redondant `test:e2e` ont été retirés,
  avec lockfile réaligné.
- [x] Frontières de tests fiabilisées : le flag de reproductibilité redondant a
  été retiré, le test de migration split respecte `SKIP_INTEGRATION_TESTS` et un
  garde-fou vérifie désormais les chemins des scripts déclarés dans les manifests.
- [x] Audit technique des remboursements split réalisé : les garde-fous existants,
  les incohérences de surfaces et les écarts multi-origines sont consignés dans
  [`refund-split-audit-2026-08-30.md`](../engineering/refund-split-audit-2026-08-30.md).
- [x] Garde-fous techniques post-audit ajoutés : surface client cohérente,
  contrôle des deux snapshots, consumer et webhook fail-closed, et traçabilité
  du snapshot d'annulation ; la politique économique split reste bloquée par
  les décisions Finance/Juridique.
- [x] Proposition de politique de remboursement split formalisée dans
  [`ADR-030`](../decisions/ADR-030-split-refund-policy.md) : delta entre états
  effectifs, calcul composant par composant, traitement des frais Stripe et
  escalade manuelle.
- [x] Dérive du schéma staging résolue : migrations `0040` à `0049` appliquées
  dans Neon, journal Drizzle vérifié à 49 entrées, puis recherche publique
  staging rejouée avec succès.
- [x] Recherche publique rendue résiliente aux pannes techniques : l'interface
  affiche `SEARCH_UNAVAILABLE` au lieu de laisser remonter une erreur Next.
- [x] Smoke test connecté TEST rejoué sur staging : hold, paiement Stripe TEST,
  réservation confirmée, documents client et split financier 13/7 vérifiés.
- [x] Variables Vercel historiques `COMMISSION_BPS` et
  `PLATFORM_COMMISSION_RATE_BPS` supprimées de Production et Preview, puis
  redéploiement `main` vérifié prêt.
- [x] Vocabulaire des écrans de réservation réaligné sur « équipement » après
  vérification d'une réservation de kayak dans le dashboard loueur.
- [ ] Décisions humaines du `pilot-unblock-plan.md` clôturées.
- [ ] Politique de refunds split approuvée par Finance/Juridique, rendue
  exécutable par le provider et implémentée.
- [x] Nettoyage différentiel des fichiers, scripts et tests exécuté ; les éléments
  opérationnels et les preuves historiques sont conservés.

La vérification staging du 30 août 2026 a également confirmé que l'écart entre
le dépôt et la base n'était pas un fichier ou un script orphelin : il s'agissait
d'une application incomplète des migrations `0040` à `0049`. La base a été
réalignée dans Neon `staging` uniquement ; `production` n'a pas été modifiée.

## Baseline capturée — 2026-08-30

| Élément | Constat |
| --- | --- |
| Branche | `chantier/22-b0-split-marketplace-fees` |
| Commit | `4098f2b6554b106a9367f922f64576ba5e79f9de` |
| Synchronisation distante | `HEAD` et `origin/chantier/22-b0-split-marketplace-fees` alignés |
| Runtime | Node `v24.18.0`, pnpm `10.33.3` |
| Contrôles rapides | `pnpm check:fast` vert après installation figée |
| Modification locale protégée | `apps/web/next-env.d.ts`, préexistante et hors périmètre |
| Modifications de ce chantier | `docs/README.md` et cette roadmap |
| Suppression effectuée pendant cette phase | Aucune |

L'audit [`repository-hygiene-21-h.md`](../engineering/repository-hygiene-21-h.md)
reste la baseline générale. L'inventaire actuel est différentiel : il porte sur
le modèle split 13/7, les corrections de tests et de documentation récentes,
les fichiers locaux et les anomalies concrètement observées. Aucun script,
test, migration ou document n'est déclaré supprimable sur la seule base de son
âge ou de son nom.

Les sorties générées ne sont pas suivies par Git : `.pnpm-store`, `node_modules`,
`.next`, `dist` et `coverage`. `.devin` est également ignoré et n'est pas intégré
au dépôt. Aucun artefact généré ou dossier `.workbuddy-ai` ne reste à nettoyer
dans l'arbre de travail.

### Décisions de conservation

| Candidat inspecté | Preuve | Décision |
| --- | --- | --- |
| `.workbuddy-ai` | Absent de l'arbre de travail | Rien à supprimer |
| `.devin`, `.pnpm-store`, `node_modules`, `.next`, `dist`, `coverage` | Ignorés ou générés ; aucun fichier généré suivi | Conserver les règles d'exclusion, ne pas versionner |
| Scripts root (`dev-local`, `readiness-live`, recovery) | Appelés par les commandes root, la CI ou les runbooks | Conserver |
| Scripts database/worker et leurs fixtures | Appelés par les manifests, la CI ou les runners de test | Conserver jusqu'à preuve contraire |
| `@uttily/config` dans `apps/worker` et `packages/{auth,contracts,core,database,ui}` | Aucune importation ni référence de configuration ; les `tsconfig` utilisent le chemin relatif partagé | Retirer des manifests et du lockfile ; conserver le package partagé utilisé par Web et ESLint racine |
| `apps/worker` — script `test:e2e` | Aucune référence externe ; exécution identique à `test` depuis `fileParallelism: false` dans la configuration Vitest | Supprimer ; utiliser `test` pour la suite complète et `smoke:verify` pour le bundle |
| `SKIP_REPRODUCIBILITY` dans la commande root `test:fast` | Le seul test concerné est déjà exclu par `apps/worker` ; le flag n'avait plus d'effet | Retirer le flag ; conserver l'exclusion explicite du test lourd |
| `split-marketplace-fees.migration.test.ts` | Test PostgreSQL exécuté par `database/test:fast` ; son ancien garde ignorait `SKIP_INTEGRATION_TESTS` si `DATABASE_URL` était héritée | Respecter le skip local ; la CI garde l'exécution obligatoire avec `CI=1` |
| Références de fichiers dans les scripts workspace | Les chemins locaux sont contrôlables statiquement sans exécuter de service externe | Ajouter `pnpm test:scripts` et `pnpm check:scripts` dans la boucle locale et la CI |
| `@uttily/ui` | Consommé par `apps/web` pour les primitives, boutons, cartes, badges et en-têtes | Conserver ; package actif, non candidat au nettoyage |
| Migrations SQL, métadonnées Drizzle, ADR et tests de compatibilité | Preuves de schéma, décisions ou invariants | Conservation obligatoire |
| Rapports de chantiers historiques | Références utiles aux décisions et aux régressions | Conserver et baliser l'état historique |
| `apps/web/next-env.d.ts` | Modification locale utilisateur préexistante | Hors périmètre ; ne pas toucher |

Validation de l'audit : `pnpm install --frozen-lockfile`, `pnpm check:fast`,
`pnpm test:scripts`, `pnpm check:scripts`, `pnpm lint`, `pnpm format:check` et
`pnpm build` passent le 30 août 2026.

## Règles de nettoyage

Avant toute suppression, produire une preuve dans une branche dédiée :

1. rechercher les références dans le code, la CI, les scripts et la documentation ;
2. vérifier l’absence d’import, de commande, de fixture ou de lien dynamique ;
3. vérifier qu’aucune migration, ADR ou preuve de régression ne dépend du fichier ;
4. remplacer ou archiver la référence si elle explique un comportement historique ;
5. supprimer uniquement après un test ciblé et un passage des contrôles rapides.

Ne pas supprimer les migrations SQL, métadonnées Drizzle, ADR, rapports de
validation ou tests qui protègent une règle métier sans alternative documentée.

## Définition du type de pilote

Les mêmes décisions n'ont pas le même effet selon le pilote visé :

| Type de pilote | Périmètre | Conséquence |
| --- | --- | --- |
| Interne TEST | Données fictives, Stripe TEST, aucune transaction commerciale | Sert à valider le parcours technique ; ne vaut pas Go commercial |
| Accompagné TEST | Partenaire réel, Stripe TEST, aucune transaction LIVE | Sert à valider les opérations et les écrans ; les blockers LIVE restent ouverts |
| Commercial LIVE | Vrais clients, vrais paiements et partenaire LIVE | Les blockers du `pilot-unblock-plan.md`, les preuves opératoires et le Go produit doivent être clôturés |

## Roadmap priorisée

| Priorité | Lot | Résultat attendu | Critère de sortie |
| --- | --- | --- | --- |
| P0 | Référentiel et gel | Une seule branche/commit de référence, état Git propre et preuves de validation datées | `git status`, format, tests ciblés et CI lisibles ; aucune modification utilisateur écrasée |
| P0 | `GATE-PILOT` | Décisions humaines et readiness pilotées par le plan canonique | Le statut est lu dans `pilot-unblock-plan.md`, sans copie divergente dans cette roadmap |
| P0 | Remboursements split | Proposition versionnée dans `ADR-030` pour les remboursements totaux, partiels, annulations en baisse et compensations tardives | Sign-off Finance/Juridique, provider composant par composant, tests d’invariance et d’idempotence ; retrait du blocage uniquement après validation complète |
| P0 | Termes et documents | Chaque version acceptée par le client pointe vers un document réellement publié | `v1` est référencé par un document, une date d’effet et une preuve d’acceptation complète |
| P1 | `GATE-PILOT` — partenaire, privacy et opérations | Partenaire, contrat, données, recovery, confidentialité et contacts confirmés | Les lignes concernées du `pilot-unblock-plan.md` sont clôturées selon le type de pilote choisi |
| P1 | Documentation | Les documents actifs décrivent le code courant ; les historiques sont balisés | Aucun document actif ne présente 10 % comme règle actuelle ou une fonctionnalité livrée comme non livrée |
| P1 | Scripts et dépendances | Chaque script et dépendance a un propriétaire et un appel identifié | Inventaire validé ; aucun script orphelin ni dépendance directe non justifiée |
| P1 | Tests | Suites rapides, PostgreSQL, E2E et reproductibilité ont des frontières explicites | Aucun skip silencieux critique ; commandes et prérequis sont documentés |
| P2 | Performance | CI et boucle locale plus rapides et plus prévisibles | Shards équilibrés par durée, cache vérifié, typecheck et tests sous les budgets du dépôt |
| P2 | Simplification | Moins de doublons et de chemins historiques actifs | Chaque simplification conserve la couverture et une preuve de non-régression |

## Plan d’exécution détaillé

### 1. Baseline et inventaire différentiel — P0 / `REPO-HYGIENE`

- Capturer branche, commit, statut, dépendances Node/pnpm et état PostgreSQL.
- Distinguer les fichiers suivis, générés, ignorés et les modifications locales.
- Reprendre l'audit récent [`repository-hygiene-21-h.md`](../engineering/repository-hygiene-21-h.md)
  comme baseline ; ne pas refaire une matrice exhaustive.
- Inventorier uniquement : les changements depuis cet audit, les éléments
  signalés par une anomalie concrète, le périmètre split 13/7 et les fichiers
  non suivis ou modifiés localement.
- Ne pas inclure `apps/web/next-env.d.ts` dans les commits du ménage tant que sa
  modification utilisateur n’est pas arbitrée.

### 2. Réalignement de l'installation — P0 / `REPO-HYGIENE`

- Exécuter `pnpm install --frozen-lockfile` dans l'environnement local autorisé.
- Vérifier `pnpm why @playwright/test` et `pnpm why @clerk/testing` avant toute
  modification de manifest ou d'exclusion TypeScript.
- Relancer `pnpm check:fast` après installation propre.
- Si l'erreur persiste malgré une installation conforme au lockfile, choisir
  explicitement entre : typecheck E2E dédié ou inclusion des dépendances dans le
  typecheck applicatif ; documenter ce choix et le job CI obligatoire associé.

### 3. Gate pilote — P0 / `GATE-PILOT`

- Utiliser [`pilot-unblock-plan.md`](../operations/pilot-unblock-plan.md) comme
  seule source de vérité pour les 31 blockers et leur état.
- Choisir explicitement le type de pilote : interne TEST, accompagné TEST ou
  commercial LIVE.
- Lancer en parallèle les actions humaines du plan : textes, fiscalité,
  settlement, privacy, partenaire, recovery, contacts et Go produit.
- Ne jamais déduire un Go LIVE d'un test technique vert.

### 4. Split hardening — P0 / `SPLIT-HARDENING`

- Tant que `FIN-002`, `LEGAL-005` et les décisions associées ne sont pas signés,
  conserver le fail-closed sur les refunds split.
- La proposition actuelle est versionnée dans
  [`ADR-030`](../decisions/ADR-030-split-refund-policy.md), mais son statut
  reste `Proposed` jusqu'au sign-off Finance/Juridique.
- Après approbation, versionner la politique de refund total, partiel,
  annulation, supplément, compensation tardive, rejeu et panne provider.
- Vérifier les invariants base, frais client, frais loueur, application fee, net
  marchand, devise, arrondis et immuabilité du snapshot.
- Tester séparément les chemins legacy et split, y compris réconciliation,
  webhook et documents transactionnels.
- Maintenir `commissionAmountMinor` comme projection de compatibilité uniquement ;
  aucun écran ou rapprochement split ne doit le traiter comme l'application fee.

### 5. Documentation et remise à niveau — P1 / `REPO-HYGIENE`

- Garder [`marketplace-fees-current-state.md`](../operations/marketplace-fees-current-state.md)
  comme point d’entrée unique.
- Limiter la recherche aux documents financiers actifs, aux sources split et aux
  fichiers modifiés depuis l'audit 21-H ; ne pas utiliser une recherche globale
  de `10 %` qui attrape les remises tarifaires ou les consignes visuelles.
- Ajouter un bandeau `HISTORIQUE` aux rapports de chantier qui contiennent une
  ancienne baseline, un ancien taux ou un ancien état de livraison.
- Corriger les affirmations obsolètes uniquement lorsqu'elles décrivent un
  comportement actif ; conserver les preuves historiques intactes.
- Ne pas réécrire les rapports historiques : corriger leur statut ou les déplacer
  dans une arborescence d’archives uniquement après vérification des liens.
- Maintenir les décisions externes dans le registre, sans transformer une valeur
  codée en dur en validation humaine.

### 6. Nettoyage des scripts et dépendances — P1 / `REPO-HYGIENE`

Pour chaque script, vérifier l’appel depuis `package.json`, `.github/`, la
documentation et les tests :

- `scripts/dev-local.mjs` et son test : conserver si le workflow local reste
  canonique ; sinon fusionner les chemins après tests équivalents.
- `scripts/readiness-live.mjs` : conserver comme unique vérificateur LIVE ; ne
  pas créer un second validator concurrent.
- Scripts seed, migration, recovery, benchmark et smoke worker : conserver les
  scripts utilisés par CI ou les runbooks ; supprimer seulement les doublons
  prouvés.
- Vérifier les dépendances directes avec leurs imports réels et `pnpm why` ; ne
  pas introduire un outil de détection automatique avant cet inventaire.
- Vérifier `.devin/`, caches, sorties de build, `.next`, `dist`, coverage et
  artefacts locaux : ils ne doivent pas devenir des fichiers suivis du dépôt.

### 7. Nettoyage et fiabilisation des tests — P1/P2 / `REPO-HYGIENE`

- Classer les tests par contrat : rapide, PostgreSQL, E2E, worker build,
  reproductibilité et recovery.
- Conserver les skips intentionnels des suites rapides, mais garantir que chaque
  contrat critique est exécuté dans au moins un job CI obligatoire et que son
  prérequis manquant provoque un échec explicite.
- Rendre visibles les commandes et prérequis des suites PostgreSQL, E2E, recovery
  et reproductibilité.
- Mesurer les tests les plus longs et équilibrer les shards Core/database.
- Supprimer un test uniquement si sa règle est couverte ailleurs et si la
  suppression est justifiée dans le tableau d’inventaire.

### 8. Optimisation CI et développement — P2 / `REPO-HYGIENE`

- Vérifier les caches pnpm, TypeScript, Next.js et Playwright.
- Séparer clairement les jobs rapides des jobs PostgreSQL, E2E et recovery.
- Conserver `pnpm test:full` pour la validation finale ; ne pas ralentir la boucle
  locale avec toute la matrice.
- Publier les durées par suite et fixer des seuils d’alerte plutôt que supprimer
  de la couverture pour gagner du temps.
- Ajouter une vérification de drift migration/schema et une vérification des
  scripts référencés lorsque l’inventaire sera stabilisé.

## Séquence recommandée

1. Capturer le commit et protéger les modifications locales, sans exiger un Git
   propre immédiatement.
2. Réaligner l'installation avec le lockfile et rendre `check:fast` vert.
3. Lancer les décisions humaines du plan pilote en parallèle.
4. Après arbitrage `FIN-002`/`LEGAL-005`, implémenter la politique de refunds split.
5. Publier et référencer les textes légaux réellement acceptés.
6. Exécuter les validations complètes et le smoke test staging.
7. Faire uniquement le nettoyage différentiel prouvé.
8. Optimiser la CI en dernier, avec un budget temps fermé.

## Définition de terminé

Le chantier est terminé quand :

- les sources canoniques sont identifiables par un agent en moins de cinq minutes ;
- aucun fichier supprimé n’était nécessaire à une migration, une décision ou un test ;
- `pnpm test:fast`, `pnpm check:fast`, lint, format, typecheck et build sont
  verts selon les prérequis documentés ;
- les suites PostgreSQL, E2E, recovery et reproductibilité ont une preuve datée ;
- chaque contrat critique est couvert par un job CI obligatoire ; les skips de la
  boucle rapide sont documentés et ne masquent pas un contrat non exécuté ;
- les décisions humaines et les capacités non implémentées sont visibles dans
  le registre ;
- le pilote reste bloqué tant que les validations externes, les secrets LIVE et
  les smoke tests opérateur ne sont pas clôturés.
