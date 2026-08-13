# G7M-B2-B2B — Wiring de production du consumer de refunds

## Périmètre

G7M-B2-B2B expose le moteur Core `executeRefundRequestBatch` par une route
server-side dédiée :

`GET /api/cron/process-refund-requests`

La route est protégée par `Authorization: Bearer ${CRON_SECRET}`, valide
`STRIPE_ENVIRONMENT` (`TEST` ou `LIVE`) et transmet l'environnement au provider
et au batch Core. Elle n'ajoute aucun runtime `apps/worker` et ne prend pas de
verrou métier supplémentaire.

Le provider est appelé par le moteur Core hors transaction PostgreSQL. La route
ne publie que des compteurs et l'environnement dans sa réponse : aucun UUID,
payload, message provider ou donnée personnelle n'est exposé. Les logs JSON
contiennent les mêmes compteurs, `durationMs`, et des codes d'anomalie issus
d'une allow-list locale ; toute valeur inconnue est normalisée en
`UNKNOWN_ANOMALY`.

## Cron Vercel

`apps/web/vercel.json` conserve les trois crons existants dans leur ordre et
ajoute `/api/cron/process-refund-requests` à la même fréquence `* * * * *`.
Vercel Cron appelle la route en GET. `CRON_SECRET` doit être configuré dans
l'environnement Vercel de production et n'est jamais versionné.

## Contrat HTTP

- secret absent, vide ou incorrect : `401 { error: 'Unauthorized' }` ;
- `STRIPE_ENVIRONMENT` absent : `TEST` ;
- environnement différent de `TEST` ou `LIVE` : `500 { error: 'Configuration Error' }` ;
- erreur technique : `500 { error: 'Internal Server Error' }` ;
- succès : `200` avec `ok`, `environment`, `claimedCount`,
  `submittedCount`, `alreadyResolvedCount`, `failedCount`, `rescheduledCount`,
  `leaseLostCount` et `anomalyCount`.

## Vérification

Le fichier `apps/web/src/app/api/cron/process-refund-requests/route.test.ts`
contient 20 tests Web dédiés. Avec `DATABASE_URL`, ils recréent une base
PostgreSQL locale, appliquent les migrations et vérifient un passage réel du
batch, le statut local `SUBMITTED`, le fencing outbox, l'authentification,
l'isolation réelle TEST/LIVE avec deux fixtures, le rejet d'un tuple
`PAYMENT/REFUND_REQUESTED/v1` hors sélection, la perte de lease après l'appel
provider sans mutation locale, la normalisation `UNKNOWN_ANOMALY`, la réponse
fermée, l'absence de tous les identifiants de fixture dans les réponses/logs et
la configuration Vercel. Les tests ne sont pas skippés lorsque `DATABASE_URL`
est configurée ; une base définie mais injoignable fait échouer la préparation.

## Statut

**G7M-B2-B2B livré** : route, cron Vercel, tests Web/PostgreSQL et
documentation. Le moteur métier reste dans `packages/core`; aucun changement
Core n'est requis par ce wiring.
