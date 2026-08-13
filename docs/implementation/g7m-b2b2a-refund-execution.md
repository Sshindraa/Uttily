# G7M-B2-B2A — Exécution Core des `REFUND_REQUESTED.v1`

## Périmètre

G7M-B2-B2A implémente le moteur Core du consumer de refunds issus d'un
amendement `BOOKING_MODIFICATION`. Le lot ne branche ni cron, ni `apps/worker`,
ni wiring de production : cela reste G7M-B2-B2B.

API publique ajoutée dans `@uttily/core` :

- `claimRefundRequestBatch`
- `executeRefundRequest`
- `executeRefundRequestBatch`

## Claim et leases

Le claim PostgreSQL est borné à `(REFUND_REQUESTED, v1, REFUND)`, accepte les
événements `PENDING` et les `PROCESSING` dont la lease est expirée, trie par
`available_at, id`, puis utilise `FOR UPDATE OF outbox_events SKIP LOCKED`.
Le filtrage `TEST/LIVE` suit `refund.payment_id -> payments.environment`.
Les payloads malformés restent claimables pour être terminés en échec contrôlé;
ils ne sont jamais exécutés chez le provider.

Les leases utilisent le mécanisme partagé de l'outbox, avec token, expiration,
attempts bornés, backoff et contrôles de fencing sur chaque mutation post-claim.
Une lease perdue est un no-op : aucune mutation de refund ou d'outbox n'est
effectuée par l'ancien worker.

## Vérification et appel provider

Avant Stripe, une transaction courte verrouille dans l'ordre outbox puis
refund, paiement, amendment et tentative de paiement. Elle revalide le payload
fermé `{ organizationId, bookingId, amendmentId, refundId }`, le tenant, la
raison `BOOKING_MODIFICATION`, le statut `PENDING`, l'origine du paiement, la
devise `EUR`, le montant positif, les deux flags, la clé
`refund_amendment_${refundId}`, l'amendment `REFUND/APPLIED`, et la dernière
tentative `SUCCEEDED` déterministe portant un PaymentIntent provider.

La transaction est commitée avant l'appel provider. L'appel utilise la clé
d'idempotence persistée et la metadata strictement fermée :

```text
refund_id
organization_id
protocol_version = refund-requested-v1
```

Les UUID et le protocole littéral sont validés par les adapters Stripe et Fake.
Les flux legacy continuent d'omettre cette metadata. Les résultats provider
doivent porter un ID, le montant exact, `EUR`, et un statut parmi
`pending`, `requires_action`, `succeeded`. Même pour `succeeded`, le worker ne
persiste jamais plus loin que `SUBMITTED`; `SUCCEEDED` appartient au webhook.

## Course worker / webhook

La phase post-provider reprend le verrou outbox puis refund, vérifie la lease et
fence toutes les mises à jour. Elle attache l'ID provider, met `PENDING` en
`SUBMITTED`, et marque l'événement `PROCESSED`.

Le projecteur webhook localise un refund d'amendement par
`metadata.refund_id`, puis vérifie metadata, organisation, raison, paiement,
tentative, environnement, compte Connect, montant et devise. Il ne crée jamais
`EXTERNAL_REFUND` pour ce chemin et accepte plusieurs refunds de même montant.
Le mapping est `succeeded -> SUCCEEDED`, `failed/canceled ->
FAILED_REQUIRES_MANUAL_ACTION`, `pending/requires_action -> PENDING` sans
régression de `SUBMITTED`. Les états `SUCCEEDED`,
`FAILED_REQUIRES_MANUAL_ACTION` et `SETTLED_OFF_PLATFORM` restent terminaux.
La projection historique de compensation reste inchangée.

## Échecs

Les erreurs provider transitoires sont reschedulées avec backoff en conservant
le refund `PENDING`. Les refus durables et les tentatives épuisées terminent
l'outbox en `FAILED` et le refund en
`FAILED_REQUIRES_MANUAL_ACTION`. Un replay de `SUBMITTED`, `SUCCEEDED`,
`FAILED_REQUIRES_MANUAL_ACTION` ou `SETTLED_OFF_PLATFORM` ne rappelle pas le
provider.

## Vérification

La matrice dédiée est autonome et distingue les preuves B2-B2A des
régressions existantes :

- `refund-request-execution.test.ts` : 12 tests unitaires passés ;
- `refund-request-execution.integration.test.ts` : 26 tests PostgreSQL réels
  passés, sans skip, dont l'isolation de deux organisations avec payload forgé,
  les leases/fencing, `SKIP LOCKED`, le reclaim, la perte de lease après appel,
  les replays, le backoff et l'appel provider hors transaction vérifié par un
  lock probe concurrent ;
- les scénarios webhook tagués B2-B2A, incluant `26bis` : 18 tests PostgreSQL
  sélectionnés passés, 0 échec ; les 75 autres tests du fichier étaient
  explicitement exclus par le filtre de sélection, et le fichier complet a
  ensuite passé sans skip. La sélection couvre les événements directs et
  imbriqués, les races avant/après worker, les métadonnées invalides, les
  incohérences financières, les états non régressifs et les trois états
  terminaux ;
- le fichier complet `handle-webhook.integration.test.ts` : 93 tests passés,
  utilisé comme régression ciblée et non compté comme tests dédiés B2-B2A.

Les régressions ciblées séparées sont : 218 tests unitaires adapters/webhook/
booking-amendment, 34 tests PostgreSQL `compensation-execution` et 10 tests
PostgreSQL `booking-amendments`. Les tests legacy de compensation et de
webhooks conservent leur contrat sans metadata ; les webhooks tagués ne créent
jamais de `EXTERNAL_REFUND`. La suite Core complète, avec PostgreSQL réel et
`--no-file-parallelism`, a passé antérieurement à ce test de preuve non
fonctionnel 92 fichiers et 2 392 tests, sans échec ni skip. Aucun nouveau total
Core n'est déduit après l'ajout de ce test.

## Suite

G7M-B2-B2B reste explicitement pending : création de `apps/worker`, cron,
wiring de production, supervision et déploiement.
