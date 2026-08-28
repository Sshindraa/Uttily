# Rapport de preuve — Chantier 20-B restore drill

- Date UTC : `2026-08-28T21:11Z`
- Base Git : `bd0450d05a56ccf7a7c058c7d42ac496894fa4bb`
- Worktree : `/Users/hamza/Projects/Uttily-worktrees/20-B`
- Environnement : PostgreSQL/PostGIS local, bases éphémères générées par le script
- Production/Neon/Stripe LIVE : non utilisés

## Résultat

`PASS`

Commande exécutée :

```bash
UTTILY_RECOVERY_DRILL=1 NODE_ENV=test pnpm recovery:restore-drill
```

Mécanisme : `pg_dump --format=custom --no-owner --no-privileges` puis
`pg_restore --exit-on-error --no-owner --no-privileges` dans une base restaurée
vierge.

Mesures observées :

- dump : `509944` octets ;
- durée complète fixture → dump → mutation → restore → vérification : `10801 ms`.

Vérifications positives : réservation `CONFIRMED`, paiement `SUCCEEDED`,
tentative de paiement `SUCCEEDED`, webhook `PROCESSED`, bloc BOOKING actif,
relation exemplaire/réservation, outbox `PENDING`, quatre effets outbox et
relation variante valide.

Le script a d'abord révélé une erreur dans sa requête de vérification SQL
(`GROUP BY` incomplet) ; les bases générées ont été nettoyées, la requête a été
corrigée, puis le même drill a été rejoué avec le résultat `PASS` ci-dessus.

Cette preuve couvre le mécanisme local reproductible. Elle ne mesure pas le
RPO/RTO d'un environnement Neon/Vercel et ne constitue pas une garantie
provider ; ces éléments restent `A_CONFIRMER` dans le runbook principal.
