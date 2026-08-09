# G7G — Dashboard des signaux matériel et maintenance

## Résultat

G7G ajoute une projection Core read-only, scoped par organisation, pour le
dashboard loueur. Elle expose :

- un signal `BROKEN_ITEM` pour chaque exemplaire non supprimé `ACTIVE` et
  `BROKEN` ;
- un signal `ACTIVE_MAINTENANCE` pour chaque bloc `MAINTENANCE` actif à l'instant
  demandé ;
- un signal `UPCOMING_MAINTENANCE` pour chaque bloc qui commence dans les
  prochaines 24 heures, borne incluse.

Les intervalles suivent `[blockedStartAt, blockedEndAt)`. Les deux lectures SQL
sont bornées par `limit` (défaut 50, plafond 100), fusionnées puis triées avant
l'application de la limite finale. L'ordre est `ACTIVE_MAINTENANCE`,
`BROKEN_ITEM`, `UPCOMING_MAINTENANCE`, avec les tie-breakers documentés dans le
contrat G7G. Aucun champ de note, numéro de série, donnée financière, client ou
fournisseur n'est projeté.

La page `/dashboard/[orgId]` réutilise `requireFulfillmentOperatorOf`, capture un
seul `asOf`, affiche le fuseau IANA de chaque établissement, distingue les trois
types d'alerte et relie chaque signal au détail inventaire existant.

## Fichiers livrés

- `packages/core/src/dashboard/` : types fermés, `DashboardError`, read model et
  tests unitaires/PostgreSQL.
- `packages/core/src/index.ts` : export additif du module dashboard.
- `apps/web/src/app/dashboard/[orgId]/page.tsx` : rendu accessible des alertes.
- `apps/web/src/app/dashboard/[orgId]/page.g7g.test.ts` : garde-fous structurels
  de la page.
- `docs/architecture/overview.md`,
  `docs/implementation/agent-context.md` et
  `docs/implementation/backlog.md` : statut G7G.

G7G n'ajoute aucune migration, modification de schéma, seed, manifeste, lockfile,
mutation, outbox, worker ou workflow de maintenance ; les changements hors
périmètre déjà présents dans le worktree ont été conservés.

## Vérifications

Exécutées dans le worktree sur la base `2400c11` (`main`, HEAD détaché), avec
PostgreSQL 16/PostGIS local (`postgis/postgis:16-3.4`) pour l'intégration :

| Commande | Résultat |
| --- | --- |
| `pnpm --filter @uttily/core exec vitest run src/dashboard/maintenance-signals.test.ts` | 1 fichier, 15 tests passés, 0 échec |
| `DATABASE_URL=postgresql://uttily:uttily@localhost:5432/uttily pnpm --filter @uttily/core exec vitest run src/dashboard/maintenance-signals.integration.test.ts` | 1 fichier, 1 test passé, 0 échec ; tenant isolation, filtres et bornes `asOf`/`+24h` exécutés sur PostgreSQL réel |
| `pnpm --filter @uttily/web test` | 10 fichiers passés, 8 suites skip attendues ; 196 tests passés, 100 skip attendus |
| `pnpm lint` | exit 0 |
| `pnpm typecheck` | exit 0 pour les 8 projets |
| `pnpm --filter @uttily/web build` | exit 0 ; `/dashboard/[orgId]` reste dynamique (`ƒ`) |
| `pnpm exec prettier --check` sur les fichiers G7G | exit 0 ; tous les fichiers utilisent le style Prettier |
| `git diff --check` | exit 0 |

Le worktree utilise Node `v22.23.1` alors que le dépôt demande `>=24` ; pnpm a
émis le warning `Unsupported engine` sur les commandes concernées. Les commandes
ci-dessus sont néanmoins passées avec cet environnement.

## État Git / PR

- Aucun commit créé ; aucun push, PR ou rebase effectué.
- Les changements préexistants hors périmètre G7G ont été conservés.
- PR : non autorisée par le paquet primaire.
