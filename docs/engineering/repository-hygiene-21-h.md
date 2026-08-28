# Repository hygiene — 21-H

## Périmètre vérifié

Le monorepo canonique est limité à `apps/`, `packages/`, `docs/`, `scripts/`,
`tests` lorsqu'ils existent et aux configurations racine. Aucun changement de
comportement métier, de schéma PostgreSQL, de contrat runtime ou de route
canonique n'est introduit.

## Routes historiques

Les routes suivantes restent des redirections minces, car elles peuvent être
référencées par des favoris, notifications ou documentation. Elles sont couvertes
par `apps/web/src/app/dashboard/[orgId]/legacy-redirects.test.ts` lorsque leur
comportement est partagé.

| Route historique | Destination canonique | Classification |
| --- | --- | --- |
| `/dashboard/[orgId]/catalog` et descendants | `/dashboard/[orgId]/bikes` et descendants | INTENTIONAL_COMPAT |
| `/dashboard/[orgId]/inventory` et descendants | `/dashboard/[orgId]/fleet` et descendants | INTENTIONAL_COMPAT |
| `/dashboard/[orgId]/operations` et descendant amendement | `/dashboard/[orgId]/bookings` et amendement | INTENTIONAL_COMPAT |
| `/dashboard/[orgId]/planning` | `/dashboard/[orgId]/bookings/planning` | INTENTIONAL_COMPAT |

`DEAD_LEGACY_CODE_REMOVED`: aucun. Les fichiers adjacents inspectés portent des
redirections ou des écrans encore atteignables ; les retirer changerait un
contrat d'URL.

## Dépendances, exports et package UI

Les manifests racine et workspaces ont été comparés aux imports applicatifs.
Aucune dépendance ou export public n'a une preuve suffisante d'inutilité ; aucune
mise à niveau n'est effectuée. `@uttily/ui` n'est pas encore consommé : il garde
uniquement ses métadonnées, son `tsconfig` et `src/index.ts`. Le test vide de
point d'entrée a été supprimé, car il ne protégeait aucun contrat.

## Documentation, dette et tests

- Documentation active : `README.md`, `AGENTS.md`, architecture, produit et
  runbooks utilisés par le workflow courant.
- Documentation historique : les notes de chantiers livrés restent consultables
  et ne sont pas déplacées en masse.
- Commentaires `legacy` associés aux snapshots, migrations ou compatibilités :
  `INTENTIONAL_COMPAT`; ils ne sont pas supprimés.
- Mentions Docker/pnpm marquées `legacy` : `REAL_DEBT` seulement si le support
  pnpm évolue ; elles décrivent aujourd'hui une contrainte de build vérifiée.
- Tests de compatibilité historiques : `KEEP_INVARIANT` pour les redirections,
  migrations et snapshots ; aucun test n'est supprimé sur la seule base de son
  nom ou de son âge.

## Artéfacts locaux et configuration

Les artéfacts régénérables (`node_modules`, `.next`, `dist`, `build`, `coverage`,
`.turbo`, logs) sont ignorés et n'ont pas été supprimés. Aucun environnement,
dump, certificat, identifiant, stash ou worktree n'est touché. Les règles
`.gitignore`, `.dockerignore` et `.prettierignore`, ainsi que les scripts racine,
README et AGENTS, sont cohérents avec le dépôt : aucune correction mécanique
supplémentaire n'est justifiée.

## CI

La CI sépare qualité, build et tests par workspace avec cache pnpm. Aucune
duplication évidente à faible risque n'a été trouvée ; aucune optimisation de
performance spéculative n'est introduite.
