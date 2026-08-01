# ADR-010 — Stripe Connect, paiement, confirmation et réconciliation

- **Statut** : Accepté (périmètre technique et Stripe TEST)
- **Date** : 2026-07-30
- **Périmètre** : Lot 5 — paiement de la location et confirmation
- **Dépendances** : ADR-003, ADR-005, ADR-009
- **Activation réelle** : bloquée par les validations finance/juridique listées en section 4

## 1. Contexte

Le Lot 4 produit un brouillon `HELD` mono-loueur, un prix total en EUR, des
exemplaires physiques alloués et des holds expirants. Le Lot 5 doit encaisser ce
prix sans créer de réservation incohérente lorsque Stripe, le client, le webhook,
le Cron ou PostgreSQL répondent dans un ordre inattendu.

Le webhook Stripe validé est l'autorité de l'état externe du paiement.
PostgreSQL reste l'autorité de l'état métier, de la disponibilité et de la
confirmation de réservation.

Le Lot 5 ne doit jamais :

- confirmer depuis le navigateur ou depuis la page de retour Stripe ;
- appeler Stripe pendant qu'un verrou PostgreSQL est détenu ;
- libérer aveuglément un hold `PAYMENT_PROCESSING` ;
- recréer une allocation après une confirmation tardive ;
- recalculer silencieusement le total du brouillon ;
- stocker une donnée de carte ou le `client_secret` d'un PaymentIntent.

## 2. Portée

### Inclus

- compte Stripe Connect d'une organisation et état de disponibilité ;
- paiement de location par carte, capture automatique, EUR ;
- création ou réutilisation idempotente d'un PaymentIntent ;
- cycle `HELD → PAYMENT_PROCESSING` ;
- webhooks signés, dédupliqués et tolérants au désordre ;
- conversion atomique en réservation confirmée ;
- snapshot financier et contractuel immuable ;
- outbox créée dans la transaction de confirmation ;
- échec, abandon, expiration de session et réconciliation ;
- compensation intégrale d'un paiement réussi sans réservation convertible.

### Exclus

- paiement différé (SEPA Debit, virement, BNPL) ;
- caution ou préautorisation de garantie ;
- paiement fractionné et panier multi-loueurs ;
- annulation volontaire d'une réservation confirmée et remboursement selon
  politique commerciale ;
- génération du contrat, du reçu et des emails (consommation de l'outbox au Lot
  6) ;
- grand livre comptable complet et facturation fiscale.

La caution reste un flux distinct. Elle fera l'objet d'une décision dédiée ; elle
ne doit pas être ajoutée au PaymentIntent de la location.

## 3. Décisions techniques

1. **Stripe Connect avec destination charges.** Un paiement possède une seule
   organisation destination, cohérente avec le panier mono-loueur. Le montant de
   commission figé est transmis par `application_fee_amount` lorsqu'il est
   strictement positif ; le paramètre est omis lorsqu'il vaut zéro.
2. **Controller properties, pas de type legacy.** La configuration d'un compte
   connecté est exprimée avec les responsabilités granulaires Stripe
   (`fees_collector`, `losses_collector`, collecte des exigences et accès au
   Dashboard), pas avec une étiquette `Express` ou `Custom`. La génération d'API
   réellement utilisée est persistée et la version Stripe est épinglée.

   **Amendement Lot 5 (2026) : Accounts v1 pour le MVP.** L'implémentation
   utilise exclusivement l'API Accounts v1 (`/v1/accounts`) avec les controller
   properties équivalentes (`controller.fees.payer`,
   `controller.losses.payments`, `controller.stripe_dashboard.type`,
   `controller.requirement_collection`). Bien que `stripe@22.3.2` expose
   `stripe.v2.core.accounts`, le modèle d'objet V2 est fondamentalement
   différent : il ne contient pas `charges_enabled`, `payouts_enabled`,
   `capabilities` ni `controller` au sens v1, et remplace `details_submitted`
   par un système de requirements structuré différemment. Une implémentation V2
   nécessiterait une couche de mapping distincte et une révision du contrat
   `ConnectedAccountResult`. Pour le MVP, v1 avec controller properties est
   suffisant et éprouvé. La migration vers V2 sera évaluée dans un lot
   ultérieur, après validation finance/juridique des responsabilités (verrou
   §4). Le contrat local `ConnectedAccountControllerConfig` utilise une
   sémantique provider-agnostique (`PLATFORM` / `CONNECTED_ACCOUNT` / `STRIPE`)
   qui sera mappée explicitement vers v1 ou v2 lors de cette migration.
3. **Stripe-hosted onboarding au MVP.** Uttily ne construit pas de formulaire
   KYC maison. L'état du compte connecté est répliqué localement par webhook.
4. **Payment Intents + Payment Element.** Le paiement est intégré au parcours
   Uttily et gère SCA/3DS. Le `client_secret` est transmis au client autorisé,
   jamais persisté ni loggé.
5. **Carte uniquement, capture automatique.** Les méthodes à confirmation
   différée sont désactivées au MVP. Apple Pay et Google Pay peuvent être exposés
   uniquement lorsqu'ils utilisent le rail carte compatible.
6. **Webhook comme seul déclencheur de confirmation.** La réponse du SDK client
   améliore l'interface mais ne confirme jamais la réservation.
7. **Une obligation, plusieurs tentatives.** `payments` représente le montant dû
   pour un brouillon ; `payment_attempts` représente les PaymentIntents Stripe.
   Un PaymentIntent échoué peut être réutilisé tant qu'il n'est pas annulé.
8. **Réconciliation par état explicite.** Après 30 minutes en
   `PAYMENT_PROCESSING`, le système vérifie Stripe hors transaction, puis applique
   une décision locale sous verrous. Il ne libère jamais sur simple ancienneté.
9. **Compensation tardive intégrale.** Si Stripe a encaissé mais que la
   réservation ne peut plus être convertie, aucune réallocation n'est tentée. Un
   remboursement du total payé est créé de manière idempotente, avec inversion du
   transfert et restitution de la commission de plateforme.

Stripe documente les destination charges comme adaptées aux marketplaces à une
destination, notamment les modèles de location. Elles rendent toutefois la
plateforme financièrement exposée aux frais, remboursements et litiges : ce point
est un verrou d'activation réelle, pas une ambiguïté du protocole technique.

## 4. Verrous d'activation réelle

L'architecture et les tests Stripe sandbox peuvent avancer, mais
`PAYMENTS_LIVE_ENABLED` reste faux tant que les décisions écrites suivantes ne
sont pas disponibles :

1. entité considérée comme settlement merchant et usage éventuel de
   `on_behalf_of` ;
2. responsabilité des frais Stripe, soldes négatifs, remboursements et litiges ;
3. règle de commission, base de calcul, version et montant applicable à chaque
   organisation pilote ;
4. traitement fiscal du total TTC : `APPLIED` ou `NOT_APPLICABLE`, montant,
   éventuel taux, émetteur de facture et version de règle ;
5. conformité des politiques d'annulation, base remboursable, affichage et preuve
   de consentement ;
6. stratégie de caution, qui reste hors de ce flux de paiement.

En absence d'un terme requis, l'initiation répond
`FINANCIAL_TERMS_UNRESOLVED`. Elle ne substitue jamais zéro à une valeur inconnue.

## 5. Flux de fonds

Pour un brouillon mono-loueur :

```text
client
  → PaymentIntent créé sur le compte plateforme Uttily
  → transfer_data.destination = compte connecté du loueur
  → application_fee_amount = commission figée
  → capture_method = automatic
```

Le PaymentIntent reçoit les identifiants internes non sensibles dans ses
metadata : `payment_id`, `payment_attempt_id`, `draft_id`, `organization_id` et
une version de protocole. Les metadata ne constituent jamais une preuve
d'autorisation ni une source de montant : les données locales sont vérifiées par
identifiant et contraintes multi-tenant.

Le total du PaymentIntent est exactement `booking_drafts.total_amount_minor`.
La décomposition fiscale et la commission sont comprises dans ce total ; elles
ne l'augmentent pas après le Lot 4.

## 6. Finalisation financière avant paiement

Le brouillon Lot 4 reste immuable. Le Lot 5 ne remplit pas ses colonnes fiscales
ou de commission a posteriori. Avant l'initiation, un résolveur serveur produit un
snapshot de termes financiers :

```text
FinancialTermsSnapshot
- version
- currency = EUR
- total_amount_minor
- tax_status: NOT_APPLICABLE | APPLIED
- tax_amount_minor
- tax_rate_bps (nullable si non pertinent)
- tax_rule_snapshot
- commission_amount_minor
- commission_rule_snapshot
- connected_account_id
- charge_model = DESTINATION
- settlement_merchant_mode: PLATFORM | CONNECTED_ACCOUNT
- on_behalf_of_account_id nullable
- legal_terms_version
```

Contraintes :

- aucune valeur `UNDETERMINED` ou `null` pour la taxe et la commission au moment
  de l'initiation ;
- entiers sûrs, non négatifs, EUR ;
- `commission_amount_minor <= total_amount_minor` ;
- le total est égal au total immuable du brouillon ;
- le compte connecté appartient à l'organisation du brouillon et accepte les
  destination charges ;
- la version des termes présentée et acceptée par le client est conservée.

Ce snapshot est conservé sur `payments`, puis copié sans recalcul dans la
réservation confirmée.

## 7. Modèle de données minimal

### `organization_payment_accounts`

```text
id
organization_id
provider = STRIPE
environment: TEST | LIVE
provider_account_id
account_api_generation: ACCOUNTS_V2 | ACCOUNTS_V1_CONTROLLER_PROPERTIES
onboarding_status
charges_enabled
payouts_enabled
transfers_capability_status
settlement_merchant_mode
controller_configuration_snapshot
requirements_snapshot
last_provider_event_at
created_at / updated_at
```

Unicité : `(organization_id, provider, environment)` et
`(provider, environment, provider_account_id)`.

### `payments`

```text
id
organization_id
draft_id UNIQUE
customer_user_id
status
amount_minor / currency
tax_status / tax_amount_minor / tax_rate_bps / tax_rule_snapshot
commission_amount_minor / commission_rule_snapshot
financial_terms_version / legal_terms_version
terms_acceptance_snapshot
connected_account_id
on_behalf_of_account_id nullable
charge_model / settlement_merchant_mode
environment: TEST | LIVE
processing_started_at / processing_deadline_at
succeeded_at / failed_at / cancelled_at
created_at / updated_at
```

États : `PENDING_PROVIDER`, `REQUIRES_PAYMENT_METHOD`, `REQUIRES_ACTION`,
`PROCESSING`, `SUCCEEDED`, `FAILED`, `CANCELLED`.

`environment` (enum `payment_environment`, NOT NULL sans défaut) permet au claim
de réconciliation de filtrer par environnement Stripe pour éviter de traiter un
paiement LIVE avec un adapter TEST (et inversement). La colonne est renseignée
explicitement à la création du paiement depuis le compte connecté ; aucune valeur
par défaut silencieuse n'est acceptée.

Un paiement `SUCCEEDED` ne régresse jamais. Les remboursements sont portés par
une table séparée et ne réécrivent pas l'état historique de collecte. Le snapshot
d'acceptation conserve au minimum la version des termes, l'utilisateur et
l'instant serveur ; toute preuve supplémentaire exigée juridiquement sera ajoutée
avant le mode LIVE.

### `payment_attempts`

```text
id
organization_id
payment_id
attempt_number
status
provider_payment_intent_id UNIQUE nullable
provider_latest_charge_id nullable
provider_idempotency_key UNIQUE
provider_status
last_provider_error_code nullable
reconcile_after / reconcile_lease_until nullable
reconcile_lease_token uuid nullable
created_at / updated_at
```

Unicité : `(payment_id, attempt_number)`. Une seule tentative non terminale par
paiement. États : `PENDING_PROVIDER`, `REQUIRES_PAYMENT_METHOD`,
`REQUIRES_ACTION`, `PROCESSING`, `SUCCEEDED`, `FAILED`, `CANCELLED`. Le
`client_secret` n'est pas stocké.

`reconcile_lease_token` (UUID nullable) est le fencing token atomique de la lease
de réconciliation : le worker qui claim génère un UUID et le persiste en même
temps que `reconcile_lease_until`. Les mutations ultérieures (release, reschedule,
apply) conditionnent leur `UPDATE` sur `reconcile_lease_token = ${token}` pour
garantir qu'un worker ne modifie que sa propre lease. Une contrainte CHECK
(`payment_attempts_lease_token_lease_until_consistent`) impose que
`reconcile_lease_token` et `reconcile_lease_until` soient simultanément nuls ou
non nuls.

### `payment_webhook_events`

```text
id
organization_id
provider = STRIPE
environment: TEST | LIVE
provider_event_id
provider_event_created_at
event_type
provider_object_id
provider_account_id nullable
api_version
payload_sha256
normalized_payload jsonb
status: RECEIVED | PROCESSED | IGNORED | FAILED
processed_at / failure_code nullable
created_at
```

Unicité : `(provider, environment, provider_event_id)`. L'organisation est
résolue avant l'insertion à partir de la tentative ou du compte connecté ; un
événement non rattachable est journalisé comme anomalie plateforme sans créer de
donnée métier sans tenant. Le payload normalisé est une allow-list des champs
utiles ; le corps brut et les données de carte ne sont pas persistés.

### `bookings`

```text
id
organization_id
location_id
customer_user_id
draft_id UNIQUE
payment_id UNIQUE
status
customer_start_at / customer_end_at
blocked_start_at / blocked_end_at
prep_buffer_minutes / cleanup_buffer_minutes
currency / subtotal_amount_minor / mandatory_fees_amount_minor
tax_status / tax_amount_minor / tax_rate_bps / tax_rule_snapshot
commission_amount_minor / commission_rule_snapshot
total_amount_minor
cancellation_policy_snapshot
terms_acceptance_snapshot
confirmed_at
created_at / updated_at
```

La réservation commence à `CONFIRMED`. Les états opérationnels ultérieurs sont
`READY_FOR_PICKUP`, `ACTIVE`, `RETURNED`, `CLOSED`, `CANCELLED`, `REFUNDED`.
Le snapshot d'annulation ajoute aux données du brouillon `confirmed_at`, la
fenêtre commerciale, les échéances absolues, la base remboursable et la version
juridique effectivement acceptée. Le snapshot financier et contractuel est
immuable après insertion.

### `booking_lines` et `booking_items`

`booking_lines` copie chaque ligne du brouillon : variante, quantité, prix,
devise et `variant_snapshot`. `booking_items` référence chaque exemplaire
physique, la ligne confirmée, le hold source et le nouveau bloc `BOOKING`.

Unicités : ligne source une seule fois, allocation source une seule fois,
exemplaire une seule fois par réservation, bloc BOOKING une seule fois.

### `outbox_events`

```text
id
organization_id
aggregate_type / aggregate_id
event_type
event_version
payload
status: PENDING | PROCESSING | PROCESSED | FAILED
attempt_count / available_at / processed_at
idempotency_key UNIQUE
created_at
```

L'événement initial est `BOOKING_CONFIRMED.v1`. Son payload contient des
identifiants et snapshots nécessaires, jamais de secret Stripe.

### `refunds`

```text
id
organization_id
payment_id
reason
status
amount_minor / currency
provider_refund_id UNIQUE nullable
provider_idempotency_key UNIQUE
reverse_transfer
refund_application_fee
requested_at / submitted_at / succeeded_at / failed_at
failure_code nullable
```

Pour `LATE_PAYMENT_NO_BOOKING`, l'unicité `(payment_id, reason)` empêche une
double compensation. Le montant est le total payé ; `reverse_transfer` et
`refund_application_fee` valent vrai.

### Index requis

En plus des contraintes uniques décrites ci-dessus :

- `organization_payment_accounts (organization_id, environment)` ;
- `payments (organization_id, status)` ;
- `payments (status, processing_deadline_at)` pour les paiements non terminaux ;
- `payment_attempts (payment_id, status)` ;
- `payment_attempts (status, reconcile_after, reconcile_lease_until)` ;
- `payment_webhook_events (status, created_at)` pour les événements à reprendre ;
- `bookings (organization_id, status, customer_start_at)` ;
- `outbox_events (status, available_at, created_at)` ;
- `refunds (status, requested_at)`.

Les index partiels ne doivent utiliser que des prédicats PostgreSQL immuables ;
`now()` n'est pas placé dans un prédicat d'index. Les requêtes de réconciliation
et d'outbox sont validées par `EXPLAIN` sur un volume représentatif avant le mode
LIVE.

## 8. Initiation de paiement

L'API est un `POST` authentifié avec `Idempotency-Key`. L'organisation et le
client viennent du serveur, jamais du corps client.

### Transaction A — prise de possession locale

1. Réserver ou rejouer la clé d'idempotence locale.
2. Verrouiller le brouillon `FOR UPDATE`.
3. Verrouiller tous ses holds par `id`, puis toutes ses allocations par `id`.
4. Vérifier : brouillon `HELD`, holds `ACTIVE`, allocations `ALLOCATED`, comptes
   exacts, organisation cohérente et `transaction_timestamp() < expires_at`.
5. Résoudre et valider les termes financiers et la disponibilité du compte
   connecté.
6. Créer ou réutiliser `payment` et `payment_attempt`.
7. Passer atomiquement le brouillon et tous les holds à
   `PAYMENT_PROCESSING` ; définir une échéance de traitement de 30 minutes.
8. Commit.

### Appel Stripe — hors transaction

Créer le PaymentIntent avec la clé interne stable de la tentative. La clé
utilisateur n'est jamais envoyée directement à Stripe. Les paramètres sont
reconstruits exclusivement depuis le snapshot persistant.

### Transaction B — projection du résultat

Persister le PaymentIntent, son statut et le dernier identifiant de charge. Si la
réponse réseau a été perdue, le même appel avec la même clé Stripe retourne le
même PaymentIntent. Si Stripe a créé l'objet mais que la transaction B échoue,
le retry converge de la même manière.

Le retry d'une initiation déjà associée à un PaymentIntent récupère le même objet
Stripe hors verrou et renvoie son `client_secret` courant. Celui-ci n'entre jamais
dans `idempotency_records.response_body`.

Un `PENDING_PROVIDER` âgé de près de la fenêtre de conservation des clés Stripe
ne crée jamais automatiquement une nouvelle tentative. Il devient une anomalie
de réconciliation pour éviter un double débit potentiel.

## 9. Webhooks Stripe

Deux endpoints ont des secrets distincts et des URL stables :

- `/api/webhooks/stripe/platform` : PaymentIntent, Charge et Refund des
  destination charges ;
- `/api/webhooks/stripe/connect` : `account.updated` et événements de capacité du
  compte connecté.

Dans un Next.js App Router Route Handler, la route utilise le runtime Node.js et
lit exactement une fois `await request.text()` (ou le `ArrayBuffer` brut). Elle
n'appelle jamais `request.json()` avant `stripe.webhooks.constructEvent(...)` et
n'applique aucune transformation, réencodage ou normalisation au corps transmis à
la vérification de signature.

Règles :

1. lire le corps brut ;
2. vérifier `Stripe-Signature` avec le secret exact de l'endpoint, la tolérance
   anti-rejeu de cinq minutes fournie par défaut par le SDK et une horloge serveur
   synchronisée ; une tolérance de zéro est interdite ;
3. refuser avant toute écriture si la signature est invalide ;
4. n'écouter que les types requis ;
5. dédupliquer par identifiant d'événement et environnement ;
6. ne pas supposer l'ordre de livraison ;
7. retourner `2xx` seulement après la transaction métier courte ou après constat
   idempotent qu'elle est déjà terminée ; en cas d'échec transitoire, retourner
   une erreur pour provoquer le retry Stripe.

Événements minimaux : `payment_intent.succeeded`,
`payment_intent.processing`, `payment_intent.payment_failed`,
`payment_intent.canceled`, événements de refund nécessaires, et
`account.updated` côté Connect.

L'événement `charge.refund.updated` n'est pas abonné dans la configuration
Stripe du MVP. Stripe recommande d'écouter `refund.updated` pour les mises à
jour de refunds sur tous les moyens de paiement. Si `charge.refund.updated`
devient nécessaire (certains moyens de paiement spécifiques), il sera ajouté
à `REFUND_EVENT_TYPES` avec une mise à jour de cette ADR.

## 10. Confirmation atomique

Sur `payment_intent.succeeded`, une seule transaction :

1. retrouver la tentative par `provider_payment_intent_id` ou, pour le cas où le
   webhook précède la transaction B, par le `payment_attempt_id` présent dans
   l'objet reçu à l'intérieur du webhook signé, puis vérifier toutes les
   correspondances locales ;
2. verrouiller le brouillon racine ;
3. verrouiller tous ses holds par `id`, puis toutes ses allocations par `id` ;
4. verrouiller le paiement et la tentative ;
5. verrouiller ou insérer l'événement webhook dédupliqué ;
6. vérifier montant, devise, environnement, destination, commission, organisation,
   PaymentIntent et intégrité complète des lignes/allocations ;
7. créer `booking`, `booking_lines` et `booking_items` depuis les snapshots ;
8. marquer les holds `CONVERTED` et créer pour chaque exemplaire un nouveau bloc
   `BOOKING/ACTIVE` avec `source_id = booking.id` ;
9. marquer les allocations `CONVERTED`, le brouillon `CONVERTED`, le paiement et
   la tentative `SUCCEEDED` ;
10. insérer `BOOKING_CONFIRMED.v1` dans l'outbox ;
11. marquer l'événement webhook `PROCESSED` ;
12. commit.

Le helper unitaire `convertBlock` du Lot 3 n'est pas appelé bloc par bloc : la
conversion du groupe est un use case agrégé, tout ou rien.

L'ordre de verrouillage global du Lot 5 est :

```text
booking_draft → inventory_blocks (id) → allocations (id)
→ payment → payment_attempt → webhook_event
```

Tous les parcours qui touchent ces entités respectent cet ordre.
Cet ordre reprend et étend exactement le contrat ADR-009 sections 15 et 16 :
brouillon racine, holds dans un ordre stable, puis allocations. Aucun parcours
Lot 5 ne verrouille un hold isolément.

## 11. Échec, nouvelle tentative et abandon

- `payment_intent.payment_failed` met à jour la tentative et le paiement en
  `REQUIRES_PAYMENT_METHOD`. Le client peut réessayer le même PaymentIntent tant
  que l'échéance de traitement n'est pas atteinte.
- Une annulation volontaire appelle d'abord Stripe hors verrou. Les holds ne sont
  libérés qu'après constat du statut `canceled`.
- Une erreur réseau ambiguë ne libère rien et ne crée pas un second PaymentIntent.
- Un échec permanent avant création du PaymentIntent peut restaurer `HELD/ACTIVE`
  si l'échéance initiale est encore future ; sinon il expire le brouillon et
  libère les allocations dans une transaction.
- Une simple fermeture du navigateur n'est pas une preuve d'abandon. Le délai et
  la réconciliation déterminent la suite.

## 12. Réconciliation de `PAYMENT_PROCESSING`

Un Cron sécurisé traite des lots bornés. Il revendique les tentatives à examiner
avec une lease et `FOR UPDATE SKIP LOCKED`, commit, puis appelle Stripe hors de
tout verrou métier.

Application du résultat :

- `succeeded` : exécuter le même processeur de succès que le webhook ;
- `processing` : conserver les holds, programmer une nouvelle vérification et
  alerter au-delà du seuil opérationnel ;
- `requires_payment_method` ou `requires_action` après échéance : demander
  l'annulation Stripe hors verrou ; libérer uniquement après statut `canceled` ;
- `canceled` : sous verrous, passer brouillon `CANCELLED`, holds `RELEASED` et
  allocations `RELEASED` ;
- résultat incohérent ou appel impossible : conserver les holds et remonter une
  anomalie ; jamais de libération aveugle.

Les métriques minimales sont : âge du plus vieux `PAYMENT_PROCESSING`, nombre de
reconciliations, statuts Stripe observés, anomalies, compensations en attente et
durée de traitement.

### Filtrage par environnement et fencing de lease

Le claim filtre par `payments.environment` pour ne revendiquer que les paiements
de l'environnement de l'adapter injecté (TEST ou LIVE). Avant tout appel
provider, le moteur vérifie que `provider.environment` correspond à
l'environnement demandé ; un mismatch lève `PROVIDER_ENVIRONMENT_MISMATCH`.

La lease de réconciliation utilise un fencing token atomique
(`payment_attempts.reconcile_lease_token`, UUID) posé dans la même transaction
que `reconcile_lease_until`. Les mutations de release, reschedule et apply
conditionnent leur `UPDATE` sur l'égalité du token, ce qui garantit qu'un worker
ne peut effacer ou modifier que sa propre lease. Une contrainte CHECK impose que
`reconcile_lease_token` et `reconcile_lease_until` soient simultanément nuls ou
non nuls.

L'âge de la clé d'idempotency Stripe est vérifié côté PostgreSQL avec
`transaction_timestamp()` dans la transaction de claim (23h, marge de sécurité
d'1h sous la limite Stripe de 24h) plutôt qu'avec `Date.now()` côté application.

## 13. Paiement tardif et compensation

Si le paiement est `succeeded` mais que le brouillon est déjà terminal ou que les
invariants empêchent la conversion :

1. enregistrer le succès externe sans créer de réservation ;
2. créer une seule ligne `refunds` avec raison `LATE_PAYMENT_NO_BOOKING` ;
3. écrire `PAYMENT_COMPENSATION_REQUESTED.v1` dans l'outbox ;
4. un worker appelle Stripe hors transaction avec la clé de remboursement stable,
   montant total, `reverse_transfer=true` et `refund_application_fee=true` ;
5. les webhooks de refund projettent le résultat ;
6. un échec reste visible et réessayable, avec alerte humaine.

Le remboursement n'est jamais considéré réussi sur la seule réponse de création :
son état fournisseur est projeté et réconcilié.

Si le compte connecté ne possède pas un solde suffisant pour l'inversion du
transfert, Stripe peut refuser l'opération combinée au lieu de créer un
remboursement en attente. Dans ce cas, Uttily ne marque ni le remboursement ni la
compensation comme réussis, déclenche une alerte humaine, conserve la même clé
idempotente et exige une décision opérationnelle explicite avant un éventuel
remboursement financé par la plateforme. Aucun retry ne doit retirer
silencieusement `reverse_transfer` ou `refund_application_fee`.

## 14. Sécurité et données sensibles

- clés Stripe uniquement côté serveur et dans les secrets d'environnement ;
- secrets webhook distincts TEST/LIVE et plateforme/Connect ;
- corps brut pour la signature ;
- limitation de débit à l'edge avec seuil compatible avec les retries Stripe ;
- allow-list des plages webhook Stripe publiées, mise à jour depuis la source
  officielle ; derrière Vercel, l'adresse n'est utilisée que si elle provient
  d'un en-tête de proxy documenté et fiable ;
- signature Stripe toujours obligatoire, même lorsque l'IP est autorisée ;
- aucune donnée de carte dans les logs, tables, metadata ou erreurs ;
- `client_secret` non persisté, non loggé, non placé dans une URL ;
- endpoints client authentifiés et limités au propriétaire du brouillon ;
- identifiants d'organisation injectés côté serveur ;
- erreurs fournisseur mappées vers des codes fermés sans divulgation ;
- séparation explicite TEST/LIVE dans les références fournisseur ;
- API Stripe et SDK épinglés à une version lors de l'implémentation.

Le rate limiting ne doit pas transformer un pic légitime de retries en perte
d'événements : les réponses limitées sont explicites et observées, et la
réconciliation reste le filet de sécurité.

Le rate limiting des endpoints webhook est délégué à l'edge (Vercel Firewall
pour le MVP). Un verrou technique d'activation LIVE est imposé via la variable
d'environnement `STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED` : en environnement LIVE,
les endpoints webhook refusent les requêtes (503) tant que cette variable n'est
pas explicitement `true`, attestant que le rate limiting edge a été configuré
et vérifié. Cette attestation est un prérequis LIVE au même titre que
`STRIPE_WEBHOOK_IP_ALLOWLIST`.

## 15. Tests obligatoires

### Unitaires

- résolution de termes financiers et refus des inconnus ;
- mapping monotone des statuts Stripe ;
- empreinte/idempotence de l'initiation ;
- validation de montant, devise, destination, commission et environnement ;
- calcul du snapshot de confirmation sans mutation du brouillon ;
- politique de compensation.

### PostgreSQL réels

- initiation contre expiration sur le dernier exemplaire ;
- deux initiations concurrentes : un seul paiement et un seul PaymentIntent
  logique ;
- transition multi-exemplaires tout ou rien vers `PAYMENT_PROCESSING` ;
- webhook dupliqué : une réservation et un événement d'outbox ;
- deux événements Stripe distincts pour le même objet/type : un seul effet ;
- événements désordonnés : aucun retour arrière après `SUCCEEDED` ;
- webhook avant persistance de l'identifiant PaymentIntent ;
- webhook contre worker d'expiration ;
- succès contre réconciliation/annulation ;
- invariant brisé : aucune confirmation partielle ;
- paiement tardif : aucune réallocation et une compensation ;
- isolation multi-tenant de toutes les nouvelles tables ;
- rollback atomique de booking, blocs, allocations, paiement et outbox.

### Contractuels Stripe

- signature valide/invalide sur corps brut ;
- Route Handler Next.js : `request.text()` avant toute lecture JSON et runtime
  Node.js ;
- timestamp de signature ancien, tolérance de zéro interdite et horloge décalée ;
- IP webhook autorisée/refusée lorsque l'infrastructure expose une source fiable ;
- rate limiting sans contournement de la vérification de signature ;
- environnement et secret erronés ;
- retry d'appel avec la même clé Stripe ;
- Payment Element/SCA en sandbox ;
- destination et `application_fee_amount` conformes au snapshot ;
- aucun moyen de paiement différé activé.

### Checklist de revue de code

- aucun appel du provider Stripe dans un callback `db.transaction` ni entre un
  `SELECT ... FOR UPDATE` et le commit ;
- l'adapter Stripe est injectable et les tests de use case échouent si un appel
  provider survient pendant la phase transactionnelle ;
- l'ordre de verrouillage ADR-009/ADR-010 est identique dans initiation,
  confirmation, expiration, annulation et réconciliation ;
- `on_behalf_of_account_id` est soit absent, soit égal à la valeur figée dans le
  snapshot financier validé ;
- aucun log ni réponse idempotente persistée ne contient de `client_secret`.

## 16. Découpage d'implémentation

1. validation finance/juridique sous forme de configuration, sans activation LIVE ;
2. schéma, migration, contraintes et tests multi-tenant ;
3. résolveur de termes financiers ;
4. onboarding Stripe-hosted et projection du compte connecté ;
5. initiation idempotente et transition `PAYMENT_PROCESSING` ;
6. Payment Element carte/SCA ;
7. ingestion webhook signée et dédupliquée ;
8. confirmation atomique + outbox ;
9. échec, annulation et réconciliation Cron ;
10. compensation et refund ;
11. revue sécurité, concurrence, finance et test sandbox de bout en bout ;
12. activation LIVE uniquement après fermeture des verrous de section 4.

Chaque étape est revue avant commit. Aucun lot ne doit simuler un statut Stripe
réussi en production.

## 17. Alternatives rejetées

- **Checkout Session comme source de confirmation** : la confirmation reste liée
  au PaymentIntent et à son webhook ; une page de retour n'est pas fiable.
- **Direct charges** : elles dispersent les paiements sur les comptes connectés et
  compliquent la vue centrale du MVP. Le choix pourrait être réévalué si la
  responsabilité légale impose que chaque loueur porte directement le paiement.
- **Separate charges and transfers** : inutile pour un panier à une seule
  organisation et plus complexe à réconcilier.
- **Méthodes différées** : incompatibles avec un hold court et la confirmation
  immédiate attendue.
- **Appel Stripe sous verrou** : risque de transaction longue et de deadlock.
- **Polling navigateur** : non fiable comme autorité de confirmation.
- **Libération à 30 minutes sans vérifier Stripe** : risque de paiement encaissé
  sans stock.
- **Stockage du `client_secret` pour le replay** : surface sensible inutile ; le
  même PaymentIntent est récupéré auprès du fournisseur.

## 18. Références Stripe

- [Destination charges](https://docs.stripe.com/connect/destination-charges)
- [Choix du type de charge Connect](https://docs.stripe.com/connect/charges)
- [Payment Intents](https://docs.stripe.com/payments/payment-intents)
- [Statut et confirmation par webhook](https://docs.stripe.com/payments/payment-intents/verifying-status)
- [Vérification de signature](https://docs.stripe.com/webhooks/signature)
- [Bonnes pratiques webhook](https://docs.stripe.com/webhooks)
- [Requêtes idempotentes](https://docs.stripe.com/api/idempotent_requests)
- [Onboarding des comptes connectés](https://docs.stripe.com/connect/onboarding)
- [Controller properties et Accounts v2](https://docs.stripe.com/connect/accounts-v2/connected-account-configuration)
- [Migration depuis les types de compte legacy](https://docs.stripe.com/connect/migrate-to-controller-properties)
- [Plages IP Stripe](https://docs.stripe.com/ips)

## 19. Conséquences

- Le Lot 5 ajoute neuf agrégats/tables techniques au minimum : comptes de
  paiement organisation, paiements, tentatives, webhooks, réservations, lignes,
  exemplaires réservés, outbox et remboursements.
- La confirmation devient robuste aux retries, crashs et événements désordonnés,
  au prix d'un protocole en plusieurs transactions autour des appels réseau.
- Les holds `PAYMENT_PROCESSING` peuvent survivre au délai normal, mais restent
  visibles et réconciliables plutôt que libérés dangereusement.
- Uttily assume techniquement le rôle de plateforme de destination charge. La
  responsabilité juridique et financière correspondante doit être acceptée avant
  le mode LIVE.

## 20. Critères d'acceptation de l'ADR

L'ADR est acceptée pour le **périmètre technique et Stripe TEST** après revue
architecture/concurrence/sécurité du 2026-07-30 (`Approve with conditions`) et
intégration de ses cinq corrections P2. Cette acceptation autorise
l'implémentation sans autoriser l'encaissement réel.

Le mode LIVE reste bloqué jusqu'à validation et configuration explicites des six
points de la section 4. Un test ou une valeur par défaut ne peut jamais contourner
ce verrou.

## Amendement Phase 6 (2026) — Webhooks : persistance, FAILED, refunds externes

### A. `payment_webhook_events.organization_id` nullable

La colonne `organization_id` devient nullable (migration 0021). Les événements
non rattachables (aucune tentative, aucun compte connecté identifié) sont
persistés avec `organization_id = NULL` et marqués `IGNORED`. L'UUID nil
précédemment utilisé violait la contrainte de clé étrangère vers `organizations`.

### B. Motif `EXTERNAL_REFUND`

Le motif `EXTERNAL_REFUND` est ajouté à l'enum `refund_reason` pour les refunds
projetés depuis les webhooks Stripe (`charge.refunded`, `refund.created`,
`refund.updated`, `refund.failed`) qui ne sont pas des compensations tardives
(`LATE_PAYMENT_NO_BOOKING`). La contrainte unique `(payment_id, reason)` est
remplacée par un index unique partiel limité à `LATE_PAYMENT_NO_BOOKING`
(migration 0022), permettant plusieurs refunds externes pour le même paiement.

### C. `refunds.provider_event_created_at`

La colonne `provider_event_created_at` (bigint, nullable) est ajoutée à `refunds`
(migration 0022) pour supporter la garde monotone : un événement Stripe ancien
ne peut pas faire régresser le statut d'un refund déjà projeté par un événement
plus récent.

### D. Protocole FAILED pour invariants irréconciliables

Les erreurs d'invariant irréconciliables (`WEBHOOK_INVARIANT_BROKEN`,
`WEBHOOK_AGGREGATE_INCONSISTENT`, `WEBHOOK_AMOUNT_MISMATCH`, etc.) marquent
l'événement webhook `FAILED` avec un `failure_code` et retournent `2xx` (pas
`5xx`) pour arrêter les retries Stripe. Un événement `FAILED` est considéré
comme dédupliqué : un retry Stripe du même `provider_event_id` retourne `200`
sans rejouer. Les erreurs transitoires (DB, connexion) provoquent un rollback
et `5xx` (Stripe retry).
