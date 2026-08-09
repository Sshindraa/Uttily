# ADR-013 — Documents transactionnels et worker outbox

- **Statut** : Accepté (périmètre architecture, schéma, pipelines et worker provider-neutral ; fournisseurs production choisis par ADR-014 — questions 6, 7, 14 résolues ; adapter R2 implémenté, testé G5H-A et câblé au worker G5H-C2C-B3 ; adapter Resend implémenté, testé G5H-B et câblé au worker G5H-C2C-B3 ; conception finale politique d'idempotence Resend < 24 h et fail-closed verrouillée G5H-C1 §13 — implémentation livrée (G5H-C2A, C2B, C2C-A, C2C-B1, C2C-B2, C2C-B3, C2C-B4) ; G5H-C2C-B4 = smoke test local du bundle compilé (livré). Déploiement VPS et configuration réelle = lot distinct post-B4 (non livré))
- **Date** : 2026-08-03
- **Décideurs** : Équipe engineering Uttily
- **Relie à** : ADR-003, ADR-009, ADR-010, ADR-011, ADR-012, ADR-014

## 1. Contexte et périmètre

L'ADR-010 §10 établit qu'un événement `BOOKING_CONFIRMED.v1` est inséré dans la
table `outbox_events` lors de la transaction atomique de confirmation de
réservation. Ce payload contient uniquement quatre UUIDs
(`bookingId`, `paymentId`, `draftId`, `organizationId`). Aucun consommateur
actif n'existe aujourd'hui : le worker `apps/worker/src/index.ts` est une
coquille vide affichant un message de démarrage sans aucune logique d'outbox,
de génération de documents ou d'envoi d'emails.

Le présent ADR définit le périmètre de décision et de conception pour les
livrables suivants :

1. **Confirmation de réservation** — document récapitulatif envoyé au client
   après confirmation, récapitulant les éléments réservés, la période, le lieu
   et le montant.
2. **Contrat de location simple** — document contractuel entre le loueur et le
   client, reprenant les conditions acceptées et les exemplaires concernés.
3. **Reçu/justificatif de paiement** — preuve de paiement, **distincte** d'une
   facture fiscale. Le reçu constate qu'un paiement a été encaissé ; il ne
   constitue pas une facture conforme aux obligations fiscales et n'atteste
   juridiquement rien tant que l'identité de l'émetteur et le statut légal
   restent à définir.
4. **Email transactionnel** — notification envoyée au client pour l'informer de
   la confirmation et lui permettre d'accéder à ses documents.
5. **Facture fiscale** — **exclue** du périmètre G5A. Sa production nécessite
   une décision conjointe des équipes finance et juridique sur le statut légal
   d'Uttily, l'identité de l'émetteur fiscal, les mentions TVA et le régime
   applicable. Tant que ces décisions ne sont pas prises, aucune facture
   fiscale n'est générée.

**G5A est un groupe de décision et de conception uniquement.** Aucune
migration de base de données n'est exécutée, aucun worker fonctionnel n'est
implémenté, aucun PDF n'est généré, aucune dépendance externe (librairie PDF,
SDK email, SDK stockage objet) n'est installée. G5A produit uniquement cet ADR
et les questions ouvertes associées. L'implémentation est découpée en groupes
ultérieurs (G5B à G5F) détaillés en section 11.

## 2. Événement source

L'événement `BOOKING_CONFIRMED.v1` est l'événement source initial du flux
documentaire. Il est inséré dans `outbox_events` par
`apply-booking-confirmation.ts` (lignes 376-398) dans la transaction atomique
de confirmation.

Caractéristiques actuelles :

- `aggregate_type` : `'BOOKING'`
- `aggregate_id` : `bookingId`
- `event_version` : `'v1'`
- Payload JSONB : `{ bookingId, paymentId, draftId, organizationId }` (4 UUIDs
  uniquement)
- `idempotency_key` : `booking_confirmed_{bookingId}`

### Validation fail-closed du payload

Le worker doit valider le payload de manière fail-closed avant tout traitement :

- les quatre champs (`bookingId`, `paymentId`, `draftId`, `organizationId`)
  doivent être présents et être des UUIDs valides (format v4) ;
- tout champ manquant, malformé ou de type incorrect provoque le marquage
  immédiat de l'événement comme `FAILED` (anomalie durable, pas de retry) ;
- aucun champ supplémentaire n'est accepté en v1 (schéma strict).

### Recoupement obligatoire avec les autorités DB

Le worker ne fait **jamais** confiance au payload pour des données métier. Il
recharge toutes les données autoritatives depuis PostgreSQL à partir de
`bookingId`. Cependant, **aucune des tables sources n'est réellement
immuable** dans le schéma actuel : aucune ne possède de trigger interdisant
`UPDATE` ou `DELETE`. Les tables avec triggers append-only
(`inventory_movements`, `booking_fulfillment_events`, `condition_reports`,
`damage_reports`) ne contiennent aucun des champs cités ci-dessous.

Les données chargées sont donc classées en quatre catégories (détaillées en
section 9) :

1. **Snapshot métier par convention (techniquement mutable)** dans
   `bookings`/`payments` (jsonb figé à la confirmation, mais techniquement
   mutable car pas de trigger) ;
2. **Mutable mais lu au premier traitement** — nécessite un snapshot de rendu
   (organizations, locations, users, inventory_items) ;
3. **Donnée de livraison actuelle** — peut différer entre générations
   (user.email pour l'envoi, `providerLatestChargeId`) ;
4. **Donnée absente nécessitant une décision** — numéro de référence lisible,
   mentions légales, SIRET/RCS, TVA, etc.

### Champs qui doivent rester des identifiants

Le payload de l'outbox ne contient **jamais** :

- de montants (même partiels) ;
- d'emails, noms, adresses ou données personnelles ;
- de numéros de carte, `client_secret` ou secrets Stripe ;
- d'URLs signées ou de clés de stockage ;
- de snapshots JSONB métier (politiques, termes, règles fiscales).

### Décision

Le payload v1 actuel reste **suffisant pour le déclenchement**. Il ne contient
que des UUIDs et garantit que l'outbox reste un canal de déclenchement, pas un
canal de données. Cependant, le worker **doit créer un
`document_render_snapshot`** au premier traitement de l'événement (section 9,
correction 7). Ce snapshot fige toutes les données de rendu au moment du
premier traitement du worker — pas dans la transaction `BOOKING_CONFIRMED`. Tous
les retries ultérieurs utilisent exactement ce snapshot, jamais les données
live. Une version v2 du payload n'est pas nécessaire pour G5B à G5E : une table
de snapshot liée au booking/outbox résout le problème de mutabilité.

### Filtre du claim documentaire

Le claim documentaire filtre explicitement par `event_type`, `event_version`
et `aggregate_type` :

```sql
WHERE event_type = 'BOOKING_CONFIRMED'
  AND event_version = 'v1'
  AND aggregate_type = 'BOOKING'
  AND status IN ('PENDING', 'PROCESSING')
  AND available_at <= now()
  AND (lease_until IS NULL OR lease_until <= now())
  AND attempt_count < 5
```

**Note** : ce filtre `outbox_events.attempt_count < 5` est le filtre générique du
pipeline documentaire et des autres éligibilités (compensation Stripe). Il **ne
s'applique pas** au claim `READY_FOR_TRANSACTIONAL_EMAIL` : le budget email est
basé sur `outbox_effects.attempt_count` de l'effet `SEND_EMAIL`, pas sur
`outbox_events.attempt_count` (voir §13.12). `outbox_events.attempt_count` ne
bloque donc pas le claim email, et un résultat email incertain n'est **jamais**
transformé automatiquement en `FAILED`.

Un handler ne doit **jamais** prendre un événement appartenant à un autre
handler. Le consommateur Stripe existant filtre déjà
`event_type = 'PAYMENT_COMPENSATION_REQUESTED'` et n'est pas modifié. Le claim
générique est paramétré par une sélection fermée `(event_type, event_version,
aggregate_type)` propre à chaque handler.

## 3. Modèle de livraison et idempotence

Le traitement est **at-least-once** : un événement peut être traité plusieurs
fois (crash du worker, reclaim de lease, redéploiement). L'exactement-once n'est
pas garanti car le flux combine une base de données relationnelle, un stockage
objet et un fournisseur d'email — trois systèmes indépendants sans transaction
distribuée.

### Approches comparées

**Approche A — Un événement `BOOKING_CONFIRMED` avec plusieurs effets suivis
séparément.**

Chaque effet (génération confirmation, génération contrat, génération reçu,
envoi email) est exécuté séquentiellement par le worker sans table de suivi
dédiée. L'idempotence repose uniquement sur la clé d'idempotence de
`outbox_events`.

Limites :

- impossible de rejouer un effet individuel sans rejouer tout l'événement ;
- un crash partiel (contrat généré mais pas le reçu) force un rejeu complet,
  avec risque de double génération du contrat si le stockage objet n'est pas
  idempotent ;
- l'état global `PROCESSED` de l'événement ne reflète pas l'état réel des
  effets individuels.

**Approche B — Fan-out transactionnel vers des jobs enfants idempotents.**

L'événement `BOOKING_CONFIRMED` crée, dans une transaction, plusieurs lignes
dans une table de jobs distincte (un job par effet). Chaque job est claimé
indépendamment par un worker.

Limites :

- complexité opérationnelle accrue (claim, lease, fencing par job) ;
- perte de la cohérence d'ensemble : un événement n'a plus d'état global
  observable ;
- ordre des effets non garanti (un email peut partir avant que le document
  qu'il référence soit généré).

**Approche C — Table de ledger des effets par
(outbox_event_id, effect_type).**

L'événement `BOOKING_CONFIRMED` reste l'unité de claim. Une table
`outbox_effects` enregistre chaque effet individuel avec son propre statut et
sa propre clé d'idempotence. Le worker claim l'événement, puis traite chaque
effet non complété. L'événement n'est marqué `PROCESSED` que lorsque tous ses
effets sont `COMPLETED`.

Avantages :

- chaque effet est tracé individuellement avec son propre statut, son nombre de
  tentatives et son code d'erreur ;
- la contrainte `UNIQUE (outbox_event_id, effect_type)` empêche les doublons ;
- le replay est ciblé : un effet peut être rejoué sans rejouer les autres ;
- le crash partiel est géré : si le worker crash après avoir généré le contrat
  mais avant le reçu, seul le reçu est rejoué au prochain claim ;
- l'état global de l'événement reste observable (jointure sur
  `outbox_effects`).

### Décision retenue : Approche C — Table de ledger des effets `outbox_effects`

### Ensemble fermé des effets

Pour `BOOKING_CONFIRMED.v1`, l'ensemble attendu est **exactement** de 4 effets :

1. `GENERATE_CONFIRMATION`
2. `GENERATE_CONTRACT`
3. `GENERATE_RECEIPT`
4. `SEND_EMAIL`

### Initialisation atomique et idempotente

Lors du premier claim, le worker insère les 4 lignes dans `outbox_effects` avec
`ON CONFLICT DO NOTHING` dans la même transaction que le claim. La contrainte
`UNIQUE (outbox_event_id, effect_type)` garantit l'unicité. Si le worker crash
après l'initialisation, le prochain claim trouve les lignes existantes et ne les
recrée pas.

### Dépendance SEND_EMAIL → documents

L'effet `SEND_EMAIL` n'est traité que si les 3 effets `GENERATE_*` sont
`COMPLETED`. Aucun email ne part avant que les documents obligatoires soient
prêts.

### Condition de finalisation

L'événement passe à `PROCESSED` seulement si :

```sql
COUNT(outbox_effects WHERE outbox_event_id = ?) = 4
  AND COUNT(outbox_effects WHERE outbox_event_id = ? AND status = 'COMPLETED') = 4
```

Cet invariant de cardinalité empêche la finalisation prématurée : zéro effet ou
seulement 3 effets ne permet jamais `PROCESSED`.

### Invariants

- `(outbox_event_id, effect_type)` est `UNIQUE` : un seul effet par type par
  événement.
- `outbox_events.status = 'PROCESSED'` implique que **tous** les
  `outbox_effects.status` correspondants valent `'COMPLETED'` ET que leur
  nombre est exactement 4.
- Chaque effet possède sa propre `idempotency_key`, distincte de celle de
  l'événement outbox parent.
- Un effet `FAILED` ne marque pas l'événement `FAILED` automatiquement :
  l'événement reste `PROCESSING` tant qu'au moins un effet est retryable. Si un
  effet est durablement `FAILED` (anomalie non transitoire, `MAX_ATTEMPTS`
  atteint), l'événement passe à `FAILED`.

### Finalisation, reschedule et FAILED

- **Quatre effets exactement** : l'ensemble attendu pour
  `BOOKING_CONFIRMED.v1` est exactement 4.
- **PROCESSED** : quatre effets `COMPLETED` requis. `processed_at` est non-NULL
  uniquement pour `PROCESSED`. `lease_token` et `lease_until` sont nettoyés
  (`NULL`) lors de `PROCESSED`.
- **FAILED (outbox)** : au moins un effet terminal `FAILED` implique outbox
  `FAILED`. `lease_token` et `lease_until` sont nettoyés lors de `FAILED`.
  `processed_at` reste `NULL` pour `FAILED`.
- **Reschedule (erreur transitoire)** : l'effet reste `PENDING`, l'outbox
  retourne à `PENDING`, lease nettoyée, `available_at = now() + backoff`. Aucune
  outbox ne reste `PROCESSING` après la fin contrôlée d'une tentative.
- **`processed_at`** : non-NULL uniquement pour `PROCESSED` (jamais pour
  `FAILED` ou `PENDING`).
- **`lease_token` / `lease_until`** : nettoyés (`NULL`) lors de `PROCESSED`,
  `FAILED` ou reschedule.

### Finalisation spécifique à G5D

G5D ne marque **jamais** un événement `PROCESSED` : l'effet `SEND_EMAIL` n'est
pas traité dans G5D (hors scope, réservé à G5E). La finalisation dans G5D est :

- Si au moins un effet est terminally `FAILED` → outbox `FAILED`, lease nettoyée,
  `processed_at` NULL.
- Si les 3 effets `GENERATE_*` sont `COMPLETED` et `SEND_EMAIL` est `PENDING` →
  outbox `PENDING`, lease nettoyée, `processed_at` NULL, `available_at = now()`
  (immédiatement disponible pour G5E, sans délai arbitraire). Le filtre
  `NOT EXISTS` du claim documentaire empêche G5D de re-claimer cet événement.
- Si des effets sont encore `PENDING` (erreur transitoire) → le reschedule gère
  la finalisation (backoff exponentiel).
- La finalisation est calculée à partir de l'état autoritaire de la base de
  données (re-lecture de tous les effets dans la transaction Phase C), pas à
  partir de compteurs locaux de la tentative courante.

### Idempotence de l'email — reconnaissance explicite

La contrainte `UNIQUE (outbox_event_id, effect_type)` suffit à dédupliquer les
**effets** dans la base de données, mais **ne suffit pas** à dédupliquer l'appel
externe au fournisseur d'email. Si le fournisseur accepte l'envoi puis le worker
crash avant de persister `SENT`, un retry déclenche un second envoi.

La garantie réelle est **at-least-once avec déduplication côté fournisseur**.
`TransactionalEmailSender.send` reçoit une `providerIdempotencyKey` stable
(dérivée de `outbox_effects.idempotency_key`). Le fournisseur doit supporter
l'idempotence côté API. Si le fournisseur ne supporte pas l'idempotence, le
risque de double email est **explicitement reconnu** comme résiduel et
documenté. Le choix futur du fournisseur doit exiger une sémantique
d'idempotence compatible (question ouverte 14, section 12).

## 4. Modèle de données proposé

Les schémas suivants sont **proposés** pour G5B. Aucune migration n'est
exécutée dans G5A.

### Table `documents` (append-only strict)

```text
id                          uuid PK
organization_id             uuid FK → organizations
booking_id                  uuid FK → bookings
type                        enum: 'CONFIRMATION' | 'CONTRACT' | 'RECEIPT'
version                     integer
storage_key                 text (UUID opaque stable, non prédictible)
content_type                text (ex: 'application/pdf')
checksum_sha256             text (hash du contenu pour intégrité)
size_bytes                  integer
template_version            text
generated_at                timestamptz NOT NULL
source_outbox_event_id      uuid FK → outbox_events
render_snapshot_id          uuid FK → document_render_snapshots
idempotency_key             text UNIQUE
created_at                  timestamptz
```

Contraintes :

- `UNIQUE (booking_id, type, version)` — une seule version par type ;
- `INDEX (organization_id, booking_id)` sur `documents` ;
- append-only strict : trigger PostgreSQL interdisant `UPDATE` et `DELETE`
  (même pattern que `booking_fulfillment_events`, ADR-012 §5) ;
- une ligne n'est insérée **QUE** quand le document est réellement généré et
  stocké avec checksum vérifié ;
- `status` n'existe pas dans cette table : le statut technique est porté par
  `outbox_effects` ;
- `generated_at` est toujours renseigné à l'INSERT (jamais `NULL`) ;
- multi-tenant : `FK organization_id` + trigger de cohérence multi-tenant
  vérifiant que le `booking_id`, le `source_outbox_event_id` et le
  `render_snapshot_id` appartiennent à la même organisation.

Le binaire PDF n'est **pas** stocké dans PostgreSQL. Le contenu est stocké dans
le stockage objet (future infrastructure, section 5). PostgreSQL ne stocke que
les métadonnées : clé de stockage, type de contenu, checksum, taille,
horodatage.

### Table `outbox_effects` (mutable avec transitions contrôlées)

```text
id                  uuid PK
organization_id     uuid NOT NULL FK → organizations
outbox_event_id     uuid FK → outbox_events
effect_type         enum: 'GENERATE_CONFIRMATION' | 'GENERATE_CONTRACT'
                        | 'GENERATE_RECEIPT' | 'SEND_EMAIL'
status              enum: 'PENDING' | 'COMPLETED' | 'FAILED'
document_id         uuid FK → documents nullable (pour les effets de génération)
storage_key         text nullable (clé réservée avant stockage, pour GENERATE_*)
idempotency_key     text UNIQUE
attempt_count       integer default 0
failure_code        text nullable (enum fermé, pas de texte libre)
completed_at        timestamptz nullable
created_at          timestamptz
```

Contraintes :

- `UNIQUE (outbox_event_id, effect_type)` — un seul effet par type par
  événement ;
- `FK outbox_event_id → outbox_events` ;
- `FK document_id → documents` (nullable, renseigné après génération du
  document) ;
- `organization_id` NOT NULL avec `FK → organizations` ;
- trigger de cohérence multi-tenant : `outbox_effects.organization_id` =
  `outbox_events.organization_id` (trigger PostgreSQL `BEFORE INSERT/UPDATE`,
  cohérent avec ADR-012) ;
- `INDEX (organization_id, outbox_event_id)` sur `outbox_effects` ;
- `UPDATE` autorisés uniquement sur les colonnes `(status, document_id,
  storage_key, attempt_count, failure_code, completed_at)` ;
- transitions autorisées : `PENDING → PENDING` (réservation storage_key, incrément attempt_count ; failure_code reste NULL), `PENDING → COMPLETED`, `PENDING → FAILED` (trigger
  PostgreSQL) ;
- pas de retour en arrière (une fois `COMPLETED` ou `FAILED`, le statut ne
  change plus) ;
- `failure_code` est un enum fermé (section 8), jamais du texte libre.

#### Contraintes par `effect_type`

**Pour `GENERATE_*`** :

- `storage_key` peut être `NULL` avant réservation puis non-`NULL` après ;
- `status = 'COMPLETED'` exige `document_id IS NOT NULL`, `storage_key IS NOT
  NULL`, `completed_at IS NOT NULL` (CHECK) ;
- `status = 'COMPLETED'` exige `failure_code IS NULL` (CHECK) ;
- `document_id` doit désigner le bon type de document (assuré par le use case
  transactionnel avec test PostgreSQL : `GENERATE_CONFIRMATION` →
  `documents.type = 'CONFIRMATION'`, `GENERATE_CONTRACT` →
  `documents.type = 'CONTRACT'`, `GENERATE_RECEIPT` →
  `documents.type = 'RECEIPT'`).

**Pour `SEND_EMAIL`** :

- `document_id` doit être `NULL` (CHECK :
  `effect_type = 'SEND_EMAIL' AND document_id IS NULL`) ;
- `storage_key` doit être `NULL` (CHECK :
  `effect_type = 'SEND_EMAIL' AND storage_key IS NULL`) ;
- `status = 'COMPLETED'` exige une `notification_deliveries` avec
  `status = 'SENT'` liée à cet effet (contrainte inter-table — assurée par le
  use case transactionnel avec test PostgreSQL).

**Pour `FAILED`** :

- `failure_code IS NOT NULL` (CHECK :
  `status = 'FAILED' AND failure_code IS NOT NULL`) ;
- `completed_at` est renseigné pour tout statut terminal (`COMPLETED` et
  `FAILED`), pas seulement `COMPLETED`.

**Pour `PENDING`** :

- `document_id` doit être `NULL` (CHECK :
  `status = 'PENDING' AND document_id IS NULL`) ;
- `failure_code` doit être `NULL` (CHECK :
  `status = 'PENDING' AND failure_code IS NULL`) — un effet `PENDING` n'a pas
  d'erreur persistée.

**Contraintes inter-tables** (ne peuvent pas être exprimées par CHECK) :

- `outbox_effects.organization_id` = `outbox_events.organization_id` — **trigger
  PostgreSQL** ;
- `document_render_snapshots.organization_id` =
  `outbox_events.organization_id` — **trigger PostgreSQL** ;
- `documents.organization_id` cohérent avec `booking`, `source_outbox_event` et
  `render_snapshot` — **trigger PostgreSQL** ;
- `notification_deliveries.organization_id` cohérent avec `outbox` et effet
  `SEND_EMAIL` — **trigger PostgreSQL** ;
- `documents.type` correspond au `effect_type` du `outbox_effects` lié — **use
  case transactionnel** avec test PostgreSQL ;
- `notification_deliveries.status = 'SENT'` requise pour
  `outbox_effects.status = 'COMPLETED'` sur `SEND_EMAIL` — **use case
  transactionnel** avec test PostgreSQL.

### Table `notification_deliveries` (mutable avec transitions contrôlées)

```text
id                          uuid PK
organization_id             uuid FK → organizations
outbox_event_id             uuid FK → outbox_events
outbox_effect_id            uuid FK → outbox_effects (lien vers l'effet SEND_EMAIL)
recipient_email             text (snapshot au moment de l'envoi)
template_key                text (ex: 'booking_confirmed_customer')
provider_idempotency_key    text (clé stable pour le fournisseur)
status                      enum: 'PENDING' | 'SENT' | 'FAILED'
provider_message_id         text nullable
failure_code                text nullable (enum fermé)
sent_at                     timestamptz nullable
idempotency_key             text UNIQUE
created_at                  timestamptz
```

Contraintes :

- `UNIQUE idempotency_key` ;
- `INDEX (organization_id, outbox_event_id)` sur `notification_deliveries` ;
- `UPDATE` autorisés uniquement sur `(status, provider_message_id, sent_at,
  failure_code)` ;
- transitions : `PENDING → SENT`, `PENDING → FAILED` (trigger BEFORE UPDATE
  comparant OLD/NEW, même pattern que `outbox_effects`) ;
- multi-tenant : `FK organization_id` + trigger de cohérence multi-tenant
  vérifiant que `outbox_event_id` et `outbox_effect_id` appartiennent à la même
  organisation.

### Table `document_render_snapshots` (snapshot de rendu append-only garanti par trigger)

```text
id                  uuid PK
organization_id     uuid FK → organizations
outbox_event_id     uuid FK → outbox_events UNIQUE
booking_id          uuid FK → bookings
snapshot            jsonb (toutes les données de rendu figées)
template_version    text
created_at          timestamptz
```

Contraintes :

- `UNIQUE (outbox_event_id)` — un seul snapshot par événement ;
- `INDEX (organization_id, outbox_event_id)` sur `document_render_snapshots` ;
- append-only : trigger PostgreSQL interdisant `UPDATE` et `DELETE` ;
- trigger de cohérence multi-tenant :
  `document_render_snapshots.organization_id` =
  `outbox_events.organization_id` ;
- `snapshot` contient toutes les données de rendu figées au premier traitement
  du worker : `bookings`, `booking_lines`, `booking_items`, `payments`,
  `organizations`, `locations`, `users`, `inventory_items` au moment du
  premier claim ;
- le snapshot est créé au premier traitement du worker (pas dans la
  transaction `BOOKING_CONFIRMED`) ;
- tous les retries utilisent exactement ce snapshot, jamais les données live.

### Synthèse des contraintes

Le tableau ci-dessous synthétise les 7 catégories de contraintes applicables aux
tables documentaires (UNIQUE, FK, CHECK intra-ligne, triggers de cohérence
multi-tenant, triggers de transition d'état, triggers append-only, contraintes
use case transactionnel + test).

| Contrainte | Table | Mécanisme | Exprimable ? |
|---|---|---|---|
| `UNIQUE (outbox_event_id, effect_type)` | outbox_effects | UNIQUE | Oui |
| `UNIQUE idempotency_key` | outbox_effects, documents, notification_deliveries | UNIQUE | Oui |
| `UNIQUE (booking_id, type, version)` | documents | UNIQUE | Oui |
| `UNIQUE (outbox_event_id)` | document_render_snapshots | UNIQUE | Oui |
| `FK organization_id → organizations` | toutes | FK | Oui |
| `FK outbox_event_id → outbox_events` | outbox_effects, notification_deliveries, document_render_snapshots | FK | Oui |
| `FK document_id → documents` | outbox_effects | FK | Oui |
| `FK booking_id → bookings` | documents, document_render_snapshots | FK | Oui |
| `FK source_outbox_event_id → outbox_events` | documents | FK | Oui |
| `FK render_snapshot_id → document_render_snapshots` | documents | FK | Oui |
| `FK outbox_effect_id → outbox_effects` | notification_deliveries | FK | Oui |
| `status='COMPLETED' AND document_id IS NOT NULL` | outbox_effects | CHECK (intra-ligne) | Oui |
| `status='COMPLETED' AND storage_key IS NOT NULL` (GENERATE_*) | outbox_effects | CHECK (intra-ligne) | Oui |
| `status='COMPLETED' AND completed_at IS NOT NULL` | outbox_effects | CHECK (intra-ligne) | Oui |
| `status='COMPLETED' AND failure_code IS NULL` | outbox_effects | CHECK (intra-ligne) | Oui |
| `effect_type='SEND_EMAIL' AND document_id IS NULL` | outbox_effects | CHECK (intra-ligne) | Oui |
| `effect_type='SEND_EMAIL' AND storage_key IS NULL` | outbox_effects | CHECK (intra-ligne) | Oui |
| `status='FAILED' AND failure_code IS NOT NULL` | outbox_effects | CHECK (intra-ligne) | Oui |
| `status='PENDING' AND document_id IS NULL` | outbox_effects | CHECK (intra-ligne) | Oui |
| `status='PENDING' AND failure_code IS NULL` | outbox_effects | CHECK (intra-ligne) | Oui |
| `outbox_effects.organization_id = outbox_events.organization_id` | outbox_effects | trigger BEFORE INSERT/UPDATE | Oui |
| `document_render_snapshots.organization_id = outbox_events.organization_id` | document_render_snapshots | trigger BEFORE INSERT/UPDATE | Oui |
| `documents.organization_id` cohérent avec booking/source_outbox/render_snapshot | documents | trigger BEFORE INSERT/UPDATE | Oui |
| `notification_deliveries.organization_id` cohérent avec outbox/effet | notification_deliveries | trigger BEFORE INSERT/UPDATE | Oui |
| Transitions `PENDING → COMPLETED`, `PENDING → FAILED` | outbox_effects | trigger BEFORE UPDATE (OLD/NEW) | Oui |
| Transitions `PENDING → SENT`, `PENDING → FAILED` | notification_deliveries | trigger BEFORE UPDATE (OLD/NEW) | Oui |
| Append-only (interdit UPDATE/DELETE) | documents, document_render_snapshots | trigger BEFORE UPDATE/DELETE | Oui |
| `documents.type` correspond au `effect_type` lié | documents/outbox_effects | use case transactionnel + test | Oui |
| `SEND_EMAIL COMPLETED` requiert `notification_deliveries SENT` liée | outbox_effects/notification_deliveries | use case transactionnel + test | Oui |

Une contrainte CHECK PostgreSQL ne peut pas lire une autre table. Toute
contrainte inter-table est assurée par trigger ou par le use case transactionnel
avec test PostgreSQL d'intégration.

## 5. Ports d'infrastructure

Les interfaces suivantes sont définies indépendamment des fournisseurs. Elles
seront implémentées dans G5C, G5D et G5E avec des fakes pour les tests. Aucun
SDK S3, email ou PDF n'est choisi dans G5A.

```typescript
interface DocumentRenderer {
  render(templateKey: string, snapshot: RenderSnapshot): Promise<RenderedDocument>;
}

interface RenderedDocument {
  binary: Uint8Array;
  contentType: string;
  checksumSha256: string;
  sizeBytes: number;
}

interface ObjectStorage {
  putIfAbsent(input: {
    key: string;
    content: Uint8Array;
    contentType: string;
    checksumSha256: string;
    sizeBytes: number;
  }): Promise<
    | { kind: 'CREATED' }
    | { kind: 'ALREADY_EXISTS'; metadata: StoredObjectMetadata }
  >;

  head(key: string): Promise<StoredObjectMetadata | null>;
  get(key: string): Promise<Uint8Array>;
}

interface StoredObjectMetadata {
  contentType: string;
  sizeBytes: number;
  checksumSha256: string | null; // null si le fournisseur ne persiste pas de checksum fiable
}

interface TransactionalEmailSender {
  send(input: EmailInput): Promise<EmailResult>;
}

interface EmailInput {
  recipientEmail: string;
  templateKey: string;
  providerIdempotencyKey: string; // OBLIGATOIRE
  variables: Record<string, string | number>; // minimales, sans PII
}

interface EmailResult {
  providerMessageId: string;
  status: 'SENT';
}
```

Précisions :

- `DocumentRenderer` reçoit un snapshot versionné (`RenderSnapshot`), pas des
  données live. Le rendu est reproductible à snapshot identique.
- `ObjectStorage` : `putIfAbsent` est la seule méthode d'écriture — aucun
  écrasement silencieux. Un objet existant avec checksum/taille/contentType
  identiques est un replay sûr (`ALREADY_EXISTS` avec metadata matching). Un objet
  existant différent est une anomalie durable détectée en Phase B. Si le
  fournisseur ne fournit pas un checksum fiable
  (`StoredObjectMetadata.checksumSha256 = null`), le SHA-256 est calculé après
  `get`, hors transaction en Phase B.
- `TransactionalEmailSender` : `providerIdempotencyKey` obligatoire. Aucune
  donnée fournisseur brute n'est persistée dans la base de données. Les
  messages d'erreur du fournisseur ne sont jamais persistés tels quels ;
  seuls les `failure_code` normalisés le sont.

Aucun SDK S3, email ou PDF n'est choisi dans G5A. Les ports seront implémentés
dans G5C, G5D et G5E avec des fakes pour les tests. Le choix des fournisseurs
concrets est une question ouverte (section 12, questions 6 et 7).

## 6. Déterminisme des documents

Garanties exigées pour tout document généré :

- le rendu utilise le `document_render_snapshot` (pas les données live) ;
- le rendu est **reproductible à snapshot identique** : même snapshot produit
  même output binaire, donc même `checksum_sha256` ;
- les dates affichées sont dans le fuseau IANA du lieu (`locations.timeZone`),
  jamais en UTC brut ;
- les montants sont en unités mineures (entiers) avec devise explicite (EUR) ;
  le formatage en unités majeures est dérivé et déterministe ;
- le checksum SHA-256 est stable, calculé sur le binaire rendu après
  génération ;
- la version du template est incluse dans les métadonnées du document
  (`documents.template_version` et `document_render_snapshots.template_version`) ;
- **aucun accès réseau** pendant le rendu (pas de fetch de ressources
  distantes) ;
- **aucun chargement de ressource distante implicite** : polices, images et CSS
  doivent être embarqués ou générés localement, jamais chargés depuis une URL
  externe ;
- échappement strict de tout texte utilisateur (pas d'injection HTML) ;
- **aucune exécution HTML/JavaScript arbitraire** : pas de
  `dangerouslySetInnerHTML` dans les templates ;
- les timestamps de génération sont passés en input (horloge injectable
  `Clock` pour les tests déterministes), jamais lus via `Date.now()` directement
  dans le renderer.

## 7. Claim, lease et concurrence

Le mécanisme de claim/lease/fencing réutilise les invariants du worker de
compensation Stripe (ADR-010 §13) sans coupler les règles documentaires au
module Stripe.

### Mécanisme

- `SELECT FOR UPDATE SKIP LOCKED` sur `outbox_events` (même pattern que la
  compensation) ;
- filtrage documentaire : `event_type = 'BOOKING_CONFIRMED' AND event_version =
  'v1' AND aggregate_type = 'BOOKING'` (correction 5) ;
- filtrage de statut : `status IN ('PENDING', 'PROCESSING')`,
  `available_at <= now()`, (`lease_until IS NULL` OR `lease_until <= now()`),
  `attempt_count < 5` (filtre générique du pipeline documentaire — **pas** le
  budget email ; voir §13.12 pour l'exception `READY_FOR_TRANSACTIONAL_EMAIL`
  qui filtre sur `outbox_effects.attempt_count` de l'effet `SEND_EMAIL`) ;
- pose du lease : `UPDATE SET lease_until = now() + interval '2 minutes'`,
  `lease_token = UUID`, `status = 'PROCESSING'`, `attempt_count++` ;
- fencing par `lease_token` (UUID généré par le worker) ;
- lease de 2 minutes (configurable) ;
- expiration : `lease_until <= now()` permet le reclaim par un autre worker.

### Attempt count et backoff

**Règle pour `outbox_events.attempt_count`** :

- Chaque claim réussi (initial ou reclaim) incrémente
  `outbox_events.attempt_count`.
- `PENDING` 0 → `PROCESSING` 1 au premier claim.
- Après erreur transitoire : retour `PENDING`, lease nettoyée (`lease_token =
  NULL`, `lease_until = NULL`), `available_at` planifié avec backoff.
- Nouveau claim : 1 → 2.
- Après la 5e tentative échouée : `FAILED`.
- Un claim qui ne sélectionne aucune ligne n'incrémente rien.

**Règle pour `outbox_effects.attempt_count`** (séparée) :

- Incrémenté seulement quand cet effet est réellement tenté (pas quand
  l'événement est claimé).
- Les effets déjà `COMPLETED` ne sont jamais incrémentés.
- Une erreur transitoire laisse l'effet `PENDING` : `failure_code` reste
  `NULL` (la contrainte CHECK `status <> 'PENDING' OR failure_code IS NULL`
  l'impose). `failure_code` n'est renseigné qu'au passage terminal `FAILED`.
- `FAILED` est réservé aux anomalies durables ou à l'épuisement des tentatives
  de l'effet.

La formule de backoff est cohérente avec la compensation Stripe existante qui
utilise `30 * 2^attemptCount` où `attemptCount` est la valeur **avant**
incrément (0-indexé). Tableau mis à jour (`outbox_events.attempt_count`) :

| Tentative | attempt_count avant | attempt_count après | Délai si échec transitoire |
| --- | --- | --- | --- |
| 1 | 0 | 1 | 30s (30 × 2^0) |
| 2 | 1 | 2 | 60s (30 × 2^1) |
| 3 | 2 | 3 | 120s (30 × 2^2) |
| 4 | 3 | 4 | 240s (30 × 2^3) |
| 5 | 4 | 5 | FAILED (pas de retry) |

Après une erreur transitoire, `outbox_events.status` retourne à `PENDING` (pas
`PROCESSING`), lease nettoyée, `available_at = now() + backoff`. L'effet reste
`PENDING` avec `attempt_count` incrémenté.

`MAX_ATTEMPTS = 5` : après 5 tentatives, l'événement passe à `FAILED`.

**Exception email (voir §13.12)** : ce compteur `outbox_events.attempt_count` et
la règle « après la 5e tentative : `FAILED` » s'appliquent au pipeline
documentaire générique et aux autres éligibilités (compensation Stripe). Ils
**ne s'appliquent pas** au claim `READY_FOR_TRANSACTIONAL_EMAIL` :

- le budget email est `outbox_effects.attempt_count` de l'effet `SEND_EMAIL`,
  pas `outbox_events.attempt_count` ;
- `outbox_events.attempt_count` ne bloque pas le claim email ;
- un résultat email `UNCERTAIN` n'est **jamais** transformé automatiquement en
  `FAILED` — il va vers `REQUIRES_MANUAL_REVIEW` (voir §13.6 cas 25, §13.13).

### Trois phases (protocole avec réservation de storage_key)

Le protocole sépare strictement les transactions DB courtes des appels
externes. **Aucun appel `ObjectStorage` (exists, head, get, put, putIfAbsent)
n'est effectué pendant une transaction DB ou avec un verrou DB détenu.**

**Phase A — Transaction DB courte (commit)** :

- Claim `outbox_event` (`SELECT FOR UPDATE SKIP LOCKED`, pose lease,
  `attempt_count++`).
- Initialiser les 4 `outbox_effects` si pas déjà faits (`INSERT` avec
  `ON CONFLICT DO NOTHING`).
- Charger ou créer le `document_render_snapshot` (si déjà existant pour cet
  événement, le réutiliser).
- Pour chaque effet `GENERATE_*` non `COMPLETED` : générer
  `storage_key = crypto.randomUUID()` (UUID opaque stable) si pas déjà
  réservé, `UPDATE outbox_effects SET storage_key` .
- Commit.

**Phase B — Hors transaction (aucun verrou DB)** :

- Rendre le document (`DocumentRenderer.render` à partir du snapshot) — CPU.
- Calculer `checksum_sha256` et `size_bytes` du binaire.
- `ObjectStorage.putIfAbsent(storage_key, binary, contentType, checksum, size)`
  — écriture conditionnelle sans écrasement.
- Si `ALREADY_EXISTS` : `ObjectStorage.head(storage_key)` pour récupérer les
  métadonnées ; si le fournisseur ne fournit pas de checksum fiable,
  `ObjectStorage.get(storage_key)` + recalculer SHA-256 hors transaction.
- Comparer checksum/taille/contentType attendus avec l'existant.
- Aucun verrou DB détenu.

**Phase C — Transaction DB courte (commit)** :

- `SELECT outbox_events WHERE lease_token = ? AND lease_until > now() FOR
  UPDATE` (vérif lease + fencing).
- `SELECT outbox_effects WHERE outbox_event_id = ? FOR UPDATE`.
- Si l'objet existe avec checksum/taille/contentType identiques (vérifié en
  Phase B) → `INSERT documents` (`storage_key`, `checksum_sha256`,
  `size_bytes`, `content_type`, `generated_at`, etc. — **PAS de status**) +
  `UPDATE outbox_effects` (`status = 'COMPLETED'`, `document_id`,
  `completed_at`).
- Si anomalie détectée en Phase B (checksum différent, objet absent) →
  `UPDATE outbox_effects` (`status = 'FAILED'`,
  `failure_code = 'STORAGE_CHECKSUM_MISMATCH'` ou `'STORAGE_NOT_FOUND'`).
- Commit.

**AUCUN** appel `ObjectStorage` (`exists`, `head`, `get`, `put`,
`putIfAbsent`) ne doit apparaître dans la Phase C.

### Effet SEND_EMAIL

L'effet `SEND_EMAIL` suit le même protocole à trois phases, après que les 3 effets
`GENERATE_*` sont `COMPLETED` :

- **Phase A** : claim outbox_event, vérifier que les 3 `GENERATE_*` sont
  `COMPLETED`, créer la ligne `notification_deliveries` (`status='PENDING'`,
  `provider_idempotency_key`), commit.
- **Phase B (hors transaction)** : `TransactionalEmailSender.send` avec
  `providerIdempotencyKey` stable. Aucun verrou DB détenu.
- **Phase C** : vérif lease + fencing, `UPDATE notification_deliveries`
  (`status='SENT'`, `provider_message_id`, `sent_at`),
  `UPDATE outbox_effects` (`status='COMPLETED'`, `completed_at`), commit.
  Aucun appel `TransactionalEmailSender` en Phase C.

### Reconnaissance du worker périmé

Un worker ayant perdu sa lease peut encore terminer un appel externe déjà
commencé. La sécurité vient de :

- `storage_key` stable réservée en Phase A ;
- écriture conditionnelle sans écrasement (`putIfAbsent`) ;
- contenu déterministe (même snapshot → même binaire → même checksum) ;
- checksum obligatoire ;
- fencing empêchant toute persistance DB par le worker périmé (Phase C vérifie
  `lease_token`).

### Au retry (après crash entre Phase B et Phase C)

- Le worker reclaim l'événement (lease expirée).
- Il lit `outbox_effects.storage_key`. Si non-null → refait le rendu
  déterministe (même snapshot → même binaire), `putIfAbsent` retourne
  `ALREADY_EXISTS`, vérifie checksum/taille hors transaction (Phase B), puis
  marque `COMPLETED` en Phase C.
- Si `storage_key` null → reprendre depuis la Phase A.

### Sweeper

Aucune ligne `PROCESSING` abandonnée indéfiniment : un sweeper périodique
reclaim les `PROCESSING` avec `lease_until <= now()`. Le sweeper utilise le même
mécanisme de claim que le worker principal.

### Ordre des verrous

L'ordre des verrous est cohérent avec l'ordre existant
(`outbox_events → refunds → payments → payment_attempts`) et étendu aux tables
documentaires :

```text
outbox_events → outbox_effects → documents → notification_deliveries
```

### Décision

Le mécanisme générique de claim/lease/fencing doit être **partagé** (module
commun) entre la compensation Stripe et le worker documentaire. Les invariants
sont identiques ; seuls les handlers diffèrent. Ne pas dupliquer la logique de
lease. Ne pas coupler les règles documentaires au module Stripe. Aucun appel
externe n'est effectué pendant une transaction ou avec un verrou DB détenu.

## 8. Sécurité et confidentialité

- isolation `organization_id` sur toutes les queries (multi-tenant) ;
  `outbox_effects` porte `organization_id` explicitement (NOT NULL, FK vers
  `organizations`) avec trigger de cohérence multi-tenant vers
  `outbox_events.organization_id` ;
- minimisation des données personnelles : l'outbox ne contient que des UUIDs ;
- **aucune donnée personnelle dans les logs** : pas d'email, pas de nom, pas
  d'adresse dans les logs worker. Les logs ne contiennent que des identifiants
  (`outbox_event_id`, `booking_id`, `effect_type`, `failure_code`) ;
- `failure_code` est un enum fermé, non sensible : `PAYLOAD_MALFORMED`,
  `STORAGE_PUT_FAILED`, `STORAGE_CHECKSUM_MISMATCH`, `STORAGE_NOT_FOUND`,
  `RENDER_FAILED`, `EMAIL_SEND_FAILED`, `LEASE_LOST`,
  `UNKNOWN_ERROR`. Aucun message brut de fournisseur n'est persisté dans la
  base de données. Les détails techniques nettoyés (sans PII) vont uniquement
  dans des logs sécurisés ;
- `document_render_snapshot` figé au premier traitement : les données live
  mutables (organizations, locations, users, inventory_items) ne sont jamais
  relues après la création du snapshot. Les retries utilisent le snapshot, pas
  les données courantes ;
- clés de stockage **non prédictibles** : `crypto.randomUUID()` ou UUID
  aléatoire. Le `bookingId` n'apparaît jamais dans la clé de stockage ;
- documents **privés par défaut** : accès uniquement via URL signée courte
  générée à la demande ;
- URLs signées courtes : générées à la demande par `ObjectStorage`, **jamais**
  persistées dans l'outbox ou la base de données ;
- chiffrement transport (TLS) et repos assuré par le futur fournisseur de
  stockage ;
- suppression/rétention RGPD : à décider (question ouverte, section 12,
  question 5) ;
- protection contre injection HTML : échappement strict, pas de
  `dangerouslySetInnerHTML` ;
- protection contre path traversal : clés de stockage UUID, pas de
  concaténation de chemin utilisateur ;
- protection contre contenu distant : pas de fetch réseau pendant le rendu ;
- absence de secrets dans payloads, erreurs ou traces.

## 9. Contenu minimal des trois livrables

**Aucun des champs cités comme « disponible et sûr » dans la version précédente
de cet ADR n'était réellement immuable.** Aucun trigger n'empêche `UPDATE` sur
`organizations`, `locations`, `users`, `inventory_items`, `bookings`,
`booking_lines`, `booking_items`, `payments`, `payment_attempts`. Les tables
avec triggers append-only (`inventory_movements`,
`booking_fulfillment_events`, `condition_reports`, `damage_reports`) ne
contiennent aucun des champs cités.

L'inventaire ci-dessous classe les champs en quatre catégories factuelles :

1. **Snapshot métier par convention (techniquement mutable)** — jsonb figé à
   la confirmation dans `bookings`/`payments`, mais techniquement mutable (pas
   de trigger) ;
2. **Mutable mais lu au premier traitement** — `organizations`, `locations`,
   `users`, `inventory_items` ; snapshot de rendu nécessaire ;
3. **Donnée de livraison actuelle** — peut différer entre générations
   (`user.email` pour l'envoi, `providerLatestChargeId`) ;
4. **Donnée absente nécessitant une décision** — numéro de référence lisible,
   mentions légales, SIRET/RCS, TVA, etc.

### Confirmation de réservation

**Catégorie 1 — Snapshot métier par convention (techniquement mutable,
jsonb dans bookings/payments) :**

- `bookings.cancellationPolicySnapshot` (jsonb, figé à la confirmation) ;
- `bookings.termsAcceptanceSnapshot` (jsonb, figé à la confirmation) ;
- `bookings.taxRuleSnapshot` (jsonb, figé à la confirmation) ;
- `bookings.commissionRuleSnapshot` (jsonb, figé à la confirmation) ;
- `bookings.subtotalAmountMinor`, `bookings.mandatoryFeesAmountMinor`,
  `bookings.totalAmountMinor`, `bookings.currency`, `bookings.taxAmountMinor`,
  `bookings.taxRateBps`, `bookings.commissionAmountMinor` (figés par
  convention, mutable techniquement) ;
- `bookings.customerStartAt`, `bookings.customerEndAt`, `bookings.confirmedAt`
  (figés par convention, mutable techniquement) ;
- `booking_lines.variantSnapshot`, `booking_lines.quantity`,
  `booking_lines.unitPriceAmountMinor`, `booking_lines.lineTotalAmountMinor`
  (pas de `updatedAt`, mutable techniquement) ;
- `payments.amountMinor`, `payments.currency`, `payments.succeededAt`,
  `payments.taxAmountMinor`, `payments.taxRateBps`, `payments.taxRuleSnapshot`,
  `payments.commissionAmountMinor`, `payments.termsAcceptanceSnapshot`,
  `payments.financialTermsVersion`, `payments.legalTermsVersion` (figés par
  convention, mutable techniquement).

**Catégorie 2 — Mutable mais lu au premier traitement (snapshot nécessaire) :**

- `organizations.legalName`, `organizations.slug`, `organizations.isProfessional` ;
- `locations.name`, `locations.addressLine1`, `locations.addressLine2`,
  `locations.city`, `locations.postalCode`, `locations.countryCode`,
  `locations.timeZone` (IANA) ;
- `users.displayName`, `users.locale` ;
- `inventory_items.internalSku`, `inventory_items.serialNumber`,
  `inventory_items.condition`, `inventory_items.status` ;
- `booking_items` : nombre d'exemplaires alloués.

**Catégorie 3 — Donnée de livraison actuelle :**

- `users.email` (pour l'envoi email — peut changer entre la confirmation et le
  retry ; le snapshot fige l'email au premier traitement).

**Catégorie 4 — Donnée absente nécessitant une décision :**

- numéro de référence lisible (format, séquence) ;
- mentions légales de l'émetteur (SIRET, RCS, capital social) ;
- conditions générales complètes à inclure ou référencer ;
- politique de confidentialité à inclure ou référencer.

**Techniquement dérivable :**

- durée de location (depuis `customerStartAt` / `customerEndAt`) ;
- nombre total d'exemplaires (comptage de `booking_items`) ;
- montant formaté en devise (depuis `totalAmountMinor` + `currency`) ;
- dates formatées dans le fuseau du lieu (depuis `customerStartAt` /
  `customerEndAt` + `location.timeZone`).

### Contrat de location simple

**Catégorie 1 — Snapshot métier par convention (techniquement mutable) :**

- toutes les données de la confirmation (ci-dessus) ;
- `bookings.termsAcceptanceSnapshot` ;
- `payments.legalTermsVersion`.

**Catégorie 2 — Mutable mais lu au premier traitement (snapshot nécessaire) :**

- `inventory_items.internalSku`, `inventory_items.serialNumber`,
  `inventory_items.condition` ;
- `bookings.prepBufferMinutes`, `bookings.cleanupBufferMinutes` (figés par
  convention, mutable techniquement).

**Catégorie 3 — Donnée de livraison actuelle :**

- `users.email` (pour l'envoi du contrat si applicable).

**Catégorie 4 — Donnée absente nécessitant une décision :**

- texte complet du contrat (clauses, structure) ;
- clauses de responsabilité ;
- clauses d'assurance ;
- modalités de caution (si applicable) ;
- procédure en cas de dommage ;
- juridiction compétente ;
- mécanisme de signature électronique.

**Techniquement dérivable :**

- date limite d'annulation (depuis `cancellationPolicySnapshot` +
  `confirmedAt`) ;
- heures de retrait/retour (depuis `customerStartAt` / `customerEndAt` +
  buffers `prepBufferMinutes` / `cleanupBufferMinutes`).

### Reçu/justificatif de paiement

**Catégorie 1 — Snapshot métier par convention (techniquement mutable) :**

- `payments.amountMinor`, `payments.currency`, `payments.succeededAt` ;
- `payments.taxAmountMinor`, `payments.taxRateBps`, `payments.taxRuleSnapshot` ;
- `bookings.id`, `bookings.confirmedAt` ;
- `payments.id`.

**Catégorie 2 — Mutable mais lu au premier traitement (snapshot nécessaire) :**

- `organizations.legalName` ;
- `users.displayName`.

**Catégorie 3 — Donnée de livraison actuelle :**

- `users.email` (pour l'envoi) ;
- `payment_attempts.providerLatestChargeId` (mutable, mis à jour pendant le
  cycle ; snapshot nécessaire).

**Catégorie 4 — Donnée absente nécessitant une décision :**

- numéro de reçu séquentiel (format, séquence) ;
- mentions légales de l'émetteur ;
- identité du marchand de settlement (Uttily vs loueur) ;
- mentions TVA (si `taxStatus = APPLIED`) ;
- distinction explicite reçu vs facture ;
- logo / branding.

**Techniquement dérivable :**

- montant formaté en devise (depuis `amountMinor` + `currency`) ;
- date de paiement formatée (depuis `succeededAt` + `location.timeZone`).

### Stratégie de snapshot

- Persister un `document_render_snapshot` versionné (jsonb dans
  `document_render_snapshots`, snapshot de rendu append-only garanti par
  trigger) avant le premier rendu.
- Tous les retries d'un même événement utilisent exactement ce snapshot.
- La question ouverte 13 (moment du gel : `BOOKING_CONFIRMED` vs premier
  traitement du worker) reste une décision produit/architecture, mais tous les
  retries d'un même événement utilisent le même `document_render_snapshot`.
- Séparer `recipient_email` de livraison (peut avoir une politique différente
  — voir question ouverte 13).
- Ne jamais reconstruire un document déjà réservé à partir de données métier
  devenues différentes.
- Le snapshot est créé au premier traitement du worker (pas dans la
  transaction `BOOKING_CONFIRMED`).

## 10. Tests futurs exigés

Matrice de tests pour G5B à G5F (liste, sans implémentation) :

- schéma et contraintes : `UNIQUE`, `CHECK`, `FK`, append-only (triggers sur
  `documents` et `document_render_snapshots`) ;
- multi-tenant : isolation `organization_id` (une organisation ne peut pas lire
  les documents d'une autre) ;
- `organization_id` cohérent entre `outbox_events`, `outbox_effects`,
  `documents` et `notification_deliveries` (trigger de cohérence
  multi-tenant) ;
- payload malformed : UUID invalide, champ manquant, champ supplémentaire
  (fail-closed → `FAILED`) ;
- événement/version inconnus : `event_type` non géré ou `event_version`
  non supporté (fail-closed) ;
- claim documentaire ne sélectionne que `BOOKING_CONFIRMED.v1` (ne claim pas
  `PAYMENT_COMPENSATION_REQUESTED` ni événements fulfillment) ;
- replay : même événement rejoué → pas de doublon (contrainte `UNIQUE` sur
  `outbox_effects`) ;
- zéro effet ou seulement 3 effets → outbox jamais `PROCESSED` (invariant de
  cardinalité) ;
- finalisation requiert exactement 4 effets `COMPLETED` ;
- `storage_key` réservée avant stockage, retrouvée au retry après crash entre
  Phase B et Phase C ;
- objet existant avec checksum différent → anomalie durable (`FAILED` avec
  `failure_code = 'STORAGE_CHECKSUM_MISMATCH'`) ;
- crash après stockage mais avant persistance : document stocké dans
  `ObjectStorage` mais `outbox_effects` non mis à jour → le prochain claim
  refait le rendu déterministe (même snapshot → même binaire), `putIfAbsent`
  retourne `ALREADY_EXISTS`, vérifie checksum/taille hors transaction, puis
  marque `COMPLETED` en Phase C ;
- crash après envoi email accepté par fournisseur mais avant persistance
  `SENT` → retry → si fournisseur supporte idempotence avec
  `providerIdempotencyKey` → pas de double ; sinon → double email possible
  (risque résiduel documenté) ;
- crash après document mais avant email : effet génération `COMPLETED`, effet
  email `PENDING` → seul l'email est rejoué ;
- `SEND_EMAIL` non traité tant que les 3 effets `GENERATE_*` ne sont pas
  `COMPLETED` ;
- snapshot figé utilisé à tous les retries, pas de données live (les mutations
  de `organizations`, `locations`, `users`, `inventory_items` après le premier
  traitement n'affectent pas le rendu) ;
- `failure_code` ne contient pas de PII (inspection des valeurs persistées) ;
- deux workers concurrents : `SKIP LOCKED` empêche le double claim ;
- lease expirée : reclaim par un autre worker après `lease_until <= now()` ;
- sweeper : `PROCESSING` avec `lease_until <= now()` reclaimé ;
- fencing token perdu : `lease_token` mismatch → abandon sans persistance ;
- checksum : même snapshot → même `checksum_sha256` ;
- rendu déterministe : mêmes données → même binaire ;
- fuseau : dates dans `location.timeZone`, pas UTC brut ;
- caractères hostiles : échappement HTML, pas d'injection ;
- absence de données personnelles dans logs (inspection des logs de test) ;
- effet partiellement réussi : un effet `COMPLETED`, un `FAILED` → l'événement
  reste `PROCESSING` puis passe à `FAILED` si l'effet est durable ;
- erreur transitoire puis succès : retry avec backoff puis `COMPLETED` ;
- anomalie durable : `FAILED` immédiat, pas de retry ;
- backoff : 30s, 60s, 120s, 240s, puis `FAILED` à la 5e tentative ;
- aucun double email/document : contrainte `UNIQUE` sur `outbox_effects` et
  `idempotency_key` sur `documents` / `notification_deliveries`.

## 11. Plan d'implémentation

Découpage précis en groupes ultérieurs. Chaque groupe reste petit et testable.
Aucun groupe ne dépend d'un fournisseur externe réel (fakes uniquement).

- **G5B** : schéma DB (tables `documents`, `outbox_effects` avec
  `organization_id` et `storage_key`, `notification_deliveries` avec
  `provider_idempotency_key` et `failure_code`, `document_render_snapshots`) +
  contrats fermés (types TypeScript, enums, interfaces `DocumentRenderer`,
  `ObjectStorage`, `TransactionalEmailSender`). Triggers append-only sur
  `documents` et `document_render_snapshots`. Triggers de transitions sur
  `outbox_effects` et `notification_deliveries`. Aucune logique métier.

  **Statut G5B** : Livré. Migration 0028, schéma Drizzle, contrats TypeScript et tests PostgreSQL implémentés et validés.
- **G5C** : read model documentaire (chargement des données depuis DB +
  création du `document_render_snapshot` au premier traitement) + renderer
  déterministe avec fake (`DocumentRenderer` fake qui produit un binaire
  stable). Aucun stockage réel.

  **Statut G5C** : Livré. Read model documentaire, snapshot de rendu v1 figé, parser BOOKING_CONFIRMED.v1 strict, canonical JSON déterministe, fake renderer technique, tests unitaires et PostgreSQL implémentés et validés.

  **Correctif ciblé G5C** (appliqué a posteriori) :

  - **Statuts post-confirmation** : les 7 statuts de `bookingStatus.enumValues`
    sont acceptés (`CONFIRMED`, `READY_FOR_PICKUP`, `ACTIVE`, `RETURNED`,
    `CLOSED`, `CANCELLED`, `REFUNDED`). Un événement `BOOKING_CONFIRMED` peut
    être traité tardivement après une annulation ou un remboursement ; le
    worker doit toujours pouvoir produire le snapshot historique. La source
    fermée est `BOOKING_STATUSES` (dérivée de `bookingStatus.enumValues` via
    `../fulfillment/types`).
  - **Parser central** : `parseDocumentRenderSnapshotV1` (fichier
    `parse-snapshot.ts`) valide récursivement et strictement la forme, les
    types, les enums, les UUIDs, les dates ISO canoniques, les montants
    (safe integers, signes), les cohérences inter-objets
    (`organization.id === organizationId`, etc.), les relations item→line,
    le tri des tableaux et l'absence de doublons. Il remplace les
    validateurs superficiels de `get-or-create` et du fake renderer. Codes
    d'erreur : `SNAPSHOT_INVARIANT` (forme) et `VALIDATION` (type).
  - **Champs internes exclus** du snapshot client :
    `commissionAmountMinor` (booking), `commissionRuleSnapshot`,
    `taxRuleSnapshot`, `connectedAccountId`, `environment`,
    `onBehalfOfAccountId`, `client_secret` (payment), `email` (customer).
    Ces données internes ne doivent pas figurer dans le snapshot exposé.
  - **Normalisation ISO canonique** : `toCanonicalIsoTimestamp` convertit
    toute valeur DB (Date, string) vers `YYYY-MM-DDTHH:mm:ss.sssZ` via
    `date.toISOString()`. `isCanonicalIsoTimestamp` vérifie qu'une chaîne
    est déjà canonique (`new Date(value).toISOString() === value`). Toutes
    les dates du snapshot sont validées comme canoniques par le parser
    central.
  - **Type `LoadedDocumentRenderDataV1`** : `loadDocumentRenderData` retourne
    désormais `LoadedDocumentRenderDataV1` (sans `sourceOutboxEventId` ni
    `capturedAt`). Ces deux champs sont ajoutés par
    `get-or-create-document-render-snapshot` après validation de l'événement
    et capture du timestamp transactionnel. L'ancien retour
    `DocumentRenderSnapshotV1` avec `sourceOutboxEventId: ''` et
    `capturedAt: ''` violait le contrat du type.
  - **Invariants métier** vérifiés au chargement : au moins une
    `booking_line`, au moins un `booking_item`, chaque `booking_item`
    référence une `booking_line` chargée, quantité > 0,
    `billableUnitCount` > 0, montants >= 0, devises cohérentes
    (`booking.currency === payment.currency === chaque line.currency`),
    `customerStartAt < customerEndAt`.
  - **Messages d'erreur non sensibles** : aucune interpolation de
    `aggregateType`, `eventType`, `eventVersion`, `bookingStatus`,
    `timeZone`, `templateKey`, `snapshotVersion` dans les messages
    d'erreur.
- **G5D** : claim/lease/fencing (module commun partagé avec la compensation,
  filtre `event_type`/`event_version`/`aggregate_type`) + stockage idempotent
  (`ObjectStorage` fake + table `documents` + `outbox_effects` avec
  réservation de `storage_key`). Appels externes hors transaction. Vérification
  checksum au retry.

  **Statut G5D** : Livré. Module commun `outbox-claim` (claim/lease/fencing avec
  `FOR UPDATE SKIP LOCKED`), `InMemoryObjectStorage` fake déterministe, pipeline
  A/B/C (claim+init+snapshot en transaction courte → render+store hors
  transaction → persistance en transaction courte avec fencing), mapping
  effets→documents, clés d'idempotence stables, tests d'intégration PostgreSQL
  (30 scénarios) implémentés et validés.

  **Module commun `outbox-claim`** : extrait de `compensation-execution`, fournit
  `claimOutboxBatch` (SELECT+lease générique), `poseLease` (pose de lease
  uniforme), et les constantes de planification partagées (lease 2min, backoff
  30s×2^n, MAX_ATTEMPTS=5). Le module compensation-execution re-exporte les
  constantes depuis le module commun.

  **Sémantiques `attempt_count` distinctes** (documentées et préservées) :
  - **Documents (ADR-013 §7)** : `incrementStrategy='always'` — incrémente à
    CHAQUE claim (initial ET reclaim). `PENDING 0 → PROCESSING 1` au premier
    claim, `1 → 2` au reclaim.
  - **Compensation (ADR-010 §13)** : `incrementStrategy='reclaim_only'` —
    n'incrémente que lors d'un reclaim (`PROCESSING→PROCESSING`), pas lors du
    claim initial (`PENDING→PROCESSING`). Le reschedule de la compensation
    incrémente également `attempt_count +1`.
  - Les deux stratégies sont supportées par le module commun via
    `IncrementStrategy`.

  **Pipeline A/B/C** :
  - Phase A (transaction courte) : claim batch, validation fail-closed
    BOOKING_CONFIRMED.v1, initialisation 4 `outbox_effects` (ON CONFLICT DO
    NOTHING), `getOrCreateDocumentRenderSnapshotInTx`, réservation
    `storage_key` (UUID opaque, jamais remplacé).
  - Phase B (hors transaction) : render via `DocumentRenderer`, recalcul
    SHA-256 et sizeBytes depuis le binaire, vérification cohérence renderer,
    `storage.putIfAbsent`, vérification checksum si `ALREADY_EXISTS`.
  - Phase C (transaction courte) : fencing (`SELECT FOR UPDATE` avec
    `lease_token` + `lease_until > now()`), lock `outbox_effects`, INSERT
    `documents` (ON CONFLICT DO NOTHING), UPDATE effects → COMPLETED/FAILED.

  **ObjectStorage fake** : `InMemoryObjectStorage` avec copies défensives,
    `putIfAbsent` sans overwrite, injection de panne (`failPut`, `omitChecksum`,
    `notFoundOnGet`, `returnDifferentContent`). NE JAMAIS utiliser en
    production.
- **G5E** : email transactionnel idempotent (`TransactionalEmailSender` fake +
  table `notification_deliveries` avec `provider_idempotency_key`).
  Dépendance `SEND_EMAIL` → 3 `GENERATE_*` `COMPLETED`. Template minimal en
  français.

  **Statut G5E** : Implémenté. Pipeline d'envoi d'emails transactionnels
  idempotent en trois phases (A/B/C) avec `ClaimEligibility =
  READY_FOR_TRANSACTIONAL_EMAIL`, `FakeTransactionalEmailSender` avec
  déduplication sur `providerIdempotencyKey`, clés d'idempotence stables sans
  PII (`email_provider_{outboxEventId}_SEND_EMAIL_v1` et
  `email_delivery_{outboxEventId}_v1`), `recipient_email` figé au moment de la
  création de `notification_deliveries` (jamais relu depuis `users.email` lors
  des retries), transitions `PENDING → SENT / FAILED`, backoff exponentiel
  (30/60/120/240/480s), max attempts (5), finalisation `PROCESSED` uniquement
  si exactement 4 effets `COMPLETED`. G5E est provider-neutral : port
  `TransactionalEmailSender` + fake, aucun SDK choisi. L'idempotence fournisseur
  est obligatoire (`providerIdempotencyKey` requis). Tests unitaires (16) et
  d'intégration PostgreSQL (40) implémentés et validés.
- **G5F** : intégration worker, observabilité (logs sans données personnelles,
  métriques, `failure_code` normalisé) et tests de bout en bout locaux
  (crash, replay, concurrence, sweeper).

  **Statut G5F** : Validé. Suite Core complète verte (1494 passed, 0 failed, 0
  skipped, 0 timeout) avec PostgreSQL local actif. Suite worker : 95 tests au
  total, dont 81 unitaires et 14 E2E PostgreSQL ; 95 passed, 0 failed, 0
  skipped. Artefact Node exécutable (`node dist/index.js` → exit 1,
  `WorkerConfigurationError` propre). 4 tests tenant-isolation (4 passed, 0
  skipped). Node 24.18.0, PostgreSQL 16.4.

  Intégration worker (`apps/worker`) avec
  `runTransactionalDocumentsWorkerCycle` orchestrant `executeDocumentPipeline`
  PUIS `executeTransactionalEmailPipeline`, isolation des erreurs (une exception
  globale documents n'empêche pas le traitement email), logs structurés fermés
  sans PII (6 événements : `cycle_started`, `document_pipeline_completed`,
  `email_pipeline_completed`, `pipeline_failed`, `anomaly_detected`,
  `cycle_completed` — aucun `console.info` au module load), métriques à
  cardinalité bornée (labels limités à `pipeline`/`outcome`/`failureCode`
  normalisé), failure codes normalisés via switch exhaustif (8 codes publics,
  codes internes → `UNKNOWN_ERROR`), sweeper/reclaim via `claimOutboxBatch`
  existant (aucun UPDATE global, fencing par `lease_token`), composition
  injectable testable par DI, `createWorkerDependenciesFromEnv` câble les
  fournisseurs production (adapter R2 câblé G5H-C2C-B3 ; adapter Resend câblé
  G5H-C2C-B3 ; politique retry < 24 h et fail-closed conçue G5H-C1, implémentée G5H-C2A/C2B/C2C-A ;
  fournisseurs choisis par ADR-014).

  **Bundling et démarrage** : le worker est bundlé avec esbuild (bundle
  autonome, externalise `postgres`/`drizzle-orm`/`stripe`). Le point d'entrée
  démarre `runWorkerLoop` (pas de faux succès exit 0). `start` :
  `node dist/index.js` (pas `tsx`). `isMainModule` détecté via
  `fileURLToPath(import.meta.url) === process.argv[1]`.

  **Seams de test** : les seams `onAfterPhaseB` ont été ajoutés aux pipelines
  (documents et emails) pour permettre aux tests E2E de crash/replay d'injecter
  une panne après la phase B (hors transaction) sans modifier la logique de
  production. `phaseCPersist` est privée à son module (plus exportée depuis
  `@uttily/core`). Les testing utils sont dans `@uttily/core/testing` (pas dans
  l'API publique de production). `validateOutboxBatchLimit` (nom métier non
  ambigu) remplace `validateBatchLimit` dans l'API publique.

  **Worker exécutable** : le worker exécutable (`pnpm build` puis `pnpm start`)
  échoue proprement avec `WorkerConfigurationError` (pas d'`ERR_MODULE_NOT_FOUND`
  ni de crash silencieux) tant que les adapters R2/Resend ne sont pas câblés dans
  `createWorkerDependenciesFromEnv` (fournisseurs choisis par ADR-014, renderer
  PDF de production non livré).

  **`runWorkerLoop`** : valide `intervalMs` et `batchLimit` avant l'entrée dans
  la boucle (échec rapide sur config invalide). Les erreurs document/email sont
  normalisées et journalisées par `runWorkerCycle` (isolation par pipeline). Une
  erreur inattendue qui s'échappe de `runWorkerCycle` est fatale et propagée par
  `runWorkerLoop` — la boucle ne lui attribue aucun faux label et ne la
  journalise pas elle-même comme pipeline. Utilise `waitForInterval` avec
  double-check `AbortSignal`, et retire l'event listener `abort` à chaque cycle
  pour éviter son accumulation.

  **Tests unitaires worker (81 au total)** : worker-cycle 21, worker-loop 12
  (fake timers — validation `intervalMs`/`batchLimit`, propagation fatale des
  erreurs inattendues, retrait de l'listener abort, arrêt sur signal), metrics
  14, failure-codes 28, sweeper 4, index 2.

  **Tests E2E PostgreSQL (14 scénarios, 95 passed, 0 skipped)** : nominal,
  replay, crash après stockage, crash après email, crash entre documents et
  email, concurrence (barrière contrôlée), sweeper/reclaim (vrai claim),
  anomalie durable, erreur transitoire, confidentialité, snapshot figé,
  isolation multi-tenant, MAX_ATTEMPTS enforcement, fencing (reclaim après
  expiration lease avec `LEASE_LOST` réel).

  **Preuves E2E renforcées** :

  - Scénario 14 (fencing) : utilise un vrai pipeline A suspendu via barrière,
    pas des structures forgées.
  - Scénario 3 : instrumente le storage (3 `CREATED` + 3 `ALREADY_EXISTS`,
    checksums/tailles/contentTypes vérifiés).
  - Scénario 4 : compare les `providerIdempotencyKey` et `providerMessageId`
    des deux appels.
  - Scénario 7 : capture `leaseTokenB` explicitement et vérifie
    `attemptCountB === attemptCountA + 1`.

  **Stabilisations Core** :

  - 2 tests payment-initiation stabilisés (shared `FakeStripeAdapter`, timing
    advisory lock).
  - 3 hook timeouts résolus (`hookTimeout` 120s).
  - Test index payment-reconciliation rendu déterministe (100+10000 rows +
    `ANALYZE`).

  **Audit outbox-claim** : corrélation `organization_id` ajoutée dans les
  sous-requêtes d'éligibilité (défense en profondeur) + 4 tests multi-tenant de
  non-sélection (4 passed, 0 skipped).

  Provider-neutral : aucun SDK email/stockage choisi, ports + fakes uniquement.
  Les questions 6 (fournisseur de stockage objet), 7 (fournisseur d'email
  transactionnel) et 14 (support de `providerIdempotencyKey` par le fournisseur
  email) sont **résolues par ADR-014** : Cloudflare R2 (stockage), Resend
  (email), politique retry < 24 h puis fail-closed. L’adapter Cloudflare R2
  (`apps/worker/src/adapters/r2-object-storage.ts`) et l’adapter Resend
  (`apps/worker/src/adapters/resend-transactional-email-sender.ts`) sont
  implémentés, testés et câblés dans `createWorkerDependenciesFromEnv` depuis
  G5H-C2C-B3. Le renderer PDF de production (pdf-lib) est livré G5H-C2C-B2.

## 12. Questions ouvertes

Les questions suivantes sont documentées dans
`docs/implementation/open-questions.md` sous la section
« G5A — Documents transactionnels ». Les questions marquées **Résolue** sont
tranchées par ADR-014 ; les autres restent ouvertes et doivent être résolues
avant l'implémentation des groupes correspondants :

1. statut légal du « reçu » et distinction avec une facture fiscale ;
2. identité légale de l'émetteur des documents (Uttily vs loueur) ;
3. mentions contractuelles obligatoires dans le contrat de location ;
4. politique de numérotation des documents (séquentiel, UUID, format lisible) ;
5. durée de conservation des documents (RGPD) ;
6. **Résolue par ADR-014** — fournisseur de stockage objet : Cloudflare R2,
   juridiction `eu`, bucket privé, API compatible S3 ;
7. **Résolue par ADR-014** — fournisseur d'email transactionnel : Resend
   (Resend Pro pour le lancement commercial ; Free en dev/staging) ;
8. besoin de signature électronique pour le contrat ;
9. politique de téléchargement et durée des URLs signées ;
10. mentions TVA sur le reçu (si `taxStatus = APPLIED`) ;
11. logo et branding sur les documents ;
12. conditions générales de vente/usage à inclure dans la confirmation ;
13. données à figer au moment de `BOOKING_CONFIRMED` vs au premier traitement
    du worker ;
14. **Résolue par ADR-014** — exigence d'idempotence du fournisseur email :
    Resend supporte `providerIdempotencyKey` nativement dans sa fenêtre de 24 h
    (même clé + même payload → même email id ; payload différent → 409 ;
    concurrent → 409 temporaire). Politique validée : retry automatique
    strictement < 24 h, puis fail-closed et intervention manuelle. Au-delà de
    24 h, la documentation officielle ne garantit plus la déduplication ;
15. politique en cas d'objet existant avec checksum différent (anomalie
    durable, écrasement interdit ?) ;
16. régénération d'une nouvelle version documentaire (politique de versioning) ;
17. webhooks de délivrabilité et bounce — reporté à un groupe futur
    (statut `BOUNCED` retiré de `notification_delivery_status` jusqu'à décision).

## 13. G5H-C1 — Politique d'idempotence Resend < 24 h et fail-closed (conception finale)

- **Statut** : Conception finale verrouillée. Implémentation livrée (G5H-C2A, C2B, C2C-A, C2C-B1, C2C-B2, C2C-B3, C2C-B4). Câblage production livré G5H-C2C-B3 ; smoke test local du bundle compilé livré G5H-C2C-B4. Déploiement VPS et configuration réelle = lot distinct post-B4 (non livré).
- **Date** : 2026-08-05
- **Périmètre** : architecture et conception uniquement. Aucune migration, aucun
  changement de schéma TypeScript, aucun changement de pipeline, aucun changement
  d'adapter Resend, aucun changement de worker. La migration 0029 est
  **planifiée** mais non créée dans ce lot.

Cette section ferme les 9 questions de conception nécessaires pour que G5H-C2
puisse être implémenté sans inventer de règle pendant le codage. Toutes les
décisions ci-dessous sont **verrouillées**.

### 13.1 Q1 — Horodatage du premier appel fournisseur

**Décision** : ajouter une colonne
`provider_first_attempt_started_at` (timestamptz, nullable, default NULL) à la
table `notification_deliveries`.

- **Nom de la colonne** : `provider_first_attempt_started_at`.
- **Type** : `timestamptz`, nullable, default NULL.
- **Instant de persistance** : juste avant l'appel externe, dans la transaction
  courte fenced de Phase B (la même qui incrémente `attempt_count`).
- **Transaction** : la transaction courte fenced de Phase B, avant `sender.send()`.
  Le timestamp `provider_first_attempt_started_at` est persisté dans la MÊME
  transaction courte fenced que l'incrémentation de `attempt_count` (Phase B
  étape 1). Cette transaction est explicitement COMMITTÉE avant l'appel
  `sender.send()`. Ordre exact : (1) BEGIN, (2) SELECT FOR UPDATE outbox_events
  (lease check), (3) SELECT FOR UPDATE outbox_effects (SEND_EMAIL PENDING),
  (4) UPDATE attempt_count + SET provider_first_attempt_started_at =
  transaction_timestamp() WHERE OLD.provider_first_attempt_started_at IS NULL,
  (5) COMMIT, (6) appel sender.send() hors transaction. Si la transaction échoue
  avant COMMIT, le timestamp n'est pas persisté et aucun appel n'a lieu — la
  delivery reste PENDING sans timestamp, reclaimable.
- **Source temporelle PostgreSQL** : `transaction_timestamp()` (cohérent avec
  `lease_until` et les autres timestamps du pipeline).
- **Immutabilité** : une fois renseignée (non-null), JAMAIS modifiée. Un trigger
  `BEFORE UPDATE` sur `notification_deliveries` lève une exception si
  `OLD.provider_first_attempt_started_at IS NOT NULL AND
  NEW.provider_first_attempt_started_at IS DISTINCT FROM
  OLD.provider_first_attempt_started_at`.
- **Comportement au replay** : si crash après persistance du timestamp mais
  avant/pendant/après l'appel, au prochain cycle le timestamp est déjà non-null.
  On considère conservativement qu'un appel a pu avoir lieu. L'âge est calculé
  depuis ce timestamp.
- **Crash entre persistance et appel réseau** : conservativement, on suppose que
  l'appel a pu avoir lieu. Le timestamp est non-null → l'âge est calculé.

### 13.2 Q2 — Marge avant 24 heures

**Comparaison** :

- **Cutoff exact à 24 h** : risqué. La latence réseau p99 (quelques secondes), le
  décalage d'horloge NTP (millisecondes) et l'indisponibilité worker courte
  (minutes) peuvent faire dépasser la fenêtre Resend entre la décision de retry
  et l'appel effectif.
- **23 h 30** : marge 30 min — insuffisant pour absorber simultanément latence
  p99, décalage horloge, indisponibilité worker et retry backoff.
- **23 h** : marge 1 h — recommandé.

**Décision** : **cutoff à 23 heures**
(`PROVIDER_IDEMPOTENCY_WINDOW_SECONDS = 23 × 3600 = 82 800`).

**Justification** : la marge d'1 h absorbe la latence réseau p99 (quelques
secondes), le décalage d'horloge NTP (millisecondes), l'indisponibilité worker
courte (minutes) et le retry backoff. Tous les calculs d'âge utilisent PostgreSQL
`transaction_timestamp() - provider_first_attempt_started_at`, pas l'horloge
Node.js. Une delivery dont l'âge calculé en DB est ≥ 23 h est exclue du retry
automatique et passe en `REQUIRES_MANUAL_REVIEW` si le résultat n'est pas `SENT`.
Le backoff maximum cumulé est de 15 minutes (30+60+120+240+480s), largement
inférieur à la marge de 1 h, ce qui laisse ample temps pour un retry complet
dans la fenêtre sûre.

### 13.3 Q3 — États persistés

**Décision** : ajouter `REQUIRES_MANUAL_REVIEW` à l'énumération
`notification_delivery_status`.

- **Enum mis à jour** : `'PENDING'`, `'SENT'`, `'FAILED'`,
  `'REQUIRES_MANUAL_REVIEW'`.
- **Pas d'enum séparé** pour l'état/résultat fournisseur (sur-ingénierie pour
  MVP).
- **outbox_effects associé** : `SEND_EMAIL` reste `PENDING` (pas `COMPLETED` ni
  `FAILED` — l'effet n'est ni réussi ni échoué définitivement).
- **outbox_events associé** : remis en `PENDING` avec `lease_token = NULL` et
  `lease_until = NULL` (PAS `PROCESSING` avec lease expirée). `processed_at`
  reste NULL. L'événement est ensuite **exclu du claim automatique** tant que la
  notification est `REQUIRES_MANUAL_REVIEW` (via le filtre `NOT EXISTS` sur
  `notification_deliveries.status`).
- **Failure codes ajoutés** : `PROVIDER_RESULT_UNCERTAIN` (pour les résultats
  incertains après début d'appel) et `EMAIL_RETRY_WINDOW_EXPIRED` (NOUVEAU — pour
  `REQUIRES_MANUAL_REVIEW` causé par cutoff ≥ 23 h) ajoutés à
  `document_processing_failure_code`.
- **REQUIRES_MANUAL_REVIEW invariants** : `provider_message_id` NULL, `sent_at`
  NULL, `failure_code` non-null appartenant à l'ensemble fermé
  `('PROVIDER_RESULT_UNCERTAIN', 'EMAIL_RETRY_WINDOW_EXPIRED')`. Le cutoff ne
  peut être calculé que si `provider_first_attempt_started_at` est non-null.
  Donc `REQUIRES_MANUAL_REVIEW` a **toujours** un `failure_code` non-null.

**CHECK constraints à ajouter pour REQUIRES_MANUAL_REVIEW** :

```sql
CHECK (status <> 'REQUIRES_MANUAL_REVIEW'
       OR (provider_message_id IS NULL AND sent_at IS NULL
           AND failure_code IN ('PROVIDER_RESULT_UNCERTAIN', 'EMAIL_RETRY_WINDOW_EXPIRED')))
```

**Note sur `failure_code`** : `REQUIRES_MANUAL_REVIEW` a **toujours** un
`failure_code` non-null. La traduction Core → DB est la suivante :

- `FAILED` déterministe (`DETERMINISTIC_REFUSAL`) → `failure_code =
  'EMAIL_SEND_FAILED'`.
- `REQUIRES_MANUAL_REVIEW` après résultat incertain → `failure_code =
  'PROVIDER_RESULT_UNCERTAIN'`.
- `REQUIRES_MANUAL_REVIEW` après `MAX_ATTEMPTS` atteint avec résultat incertain →
  `failure_code = 'PROVIDER_RESULT_UNCERTAIN'`.
- `REQUIRES_MANUAL_REVIEW` parce que cutoff ≥ 23 h → `failure_code =
  'EMAIL_RETRY_WINDOW_EXPIRED'`.

Le cutoff ne peut être calculé que si `provider_first_attempt_started_at` est
non-null. Il n'existe pas de cas NULL pour `failure_code` de
`REQUIRES_MANUAL_REVIEW`.

**Transitions autorisées (trigger mis à jour)** :

| Transition | Acteur | Conditions |
| --- | --- | --- |
| `PENDING → PENDING` | worker | retry dans fenêtre < 23 h |
| `PENDING → SENT` | worker | succès, `providerMessageId` non vide |
| `PENDING → FAILED` | worker | refus terminal certain |
| `PENDING → REQUIRES_MANUAL_REVIEW` | worker | résultat incertain (MAX atteint ou âge ≥ 23 h) ou cutoff ≥ 23 h ; outbox remis en `PENDING` avec lease nettoyée |
| `REQUIRES_MANUAL_REVIEW → SENT` | humain uniquement | opérateur confirme envoi via Resend dashboard |
| `REQUIRES_MANUAL_REVIEW → FAILED` | humain uniquement | opérateur confirme non-envoi |
| `SENT` | immuable | — |
| `FAILED` | immuable | — |
| `REQUIRES_MANUAL_REVIEW` | immuable par le worker | seul un humain peut le résoudre |

**Note sur l'état de l'outbox lors de `PENDING → REQUIRES_MANUAL_REVIEW`** : lors
de cette transition, Phase C doit atomiquement : (1) mettre
`notification_deliveries` en `REQUIRES_MANUAL_REVIEW` ; (2) laisser `SEND_EMAIL`
en `PENDING` ; (3) remettre `outbox_events` en `PENDING` (PAS `PROCESSING`) ;
(4) nettoyer `lease_token` et `lease_until` (NULL) ; (5) laisser `processed_at`
NULL. L'événement ne doit **pas** rester en `PROCESSING` avec une lease
expirée. L'événement est ensuite exclu du claim automatique via le filtre `NOT
EXISTS` sur `notification_deliveries.status`. Cette branche respecte l'invariant
existant : aucun retour contrôlé ne laisse un événement `PROCESSING` avec une
lease active ou abandonnée.

### 13.4 Q4 — Contrat Core provider-neutral

**NOTE** : Cette section documente le CONTRAT CIBLE pour G5H-C2. Le code actuel
(G5H-B) utilise `EmailResult` (interface simple `status: 'SENT'`) et l'adapter
Resend lève `ResendEmailError`. La migration vers `EmailSendResult` sera
effectuée lors de l'implémentation G5H-C2. Voir §13.10 pour la liste exhaustive
des fichiers à modifier.

**Décision** : **résultat discriminated union retourné par le port** (pas
d'erreur typée). Les adapters conformes retournent `EmailSendResult` et
normalisent leurs erreurs attendues. C'est la convention. MAIS le pipeline Core
entoure TOUJOURS `await sender.send()` d'un try/catch défensif. Toute exception
inattendue — y compris un sender tiers défectueux ou une exception non-Error —
devient `UNCERTAIN / UNKNOWN_FAILURE_AFTER_CALL_START`. Aucun raw Error, message,
cause, stack, PII ou secret ne traverse le pipeline.

Le pipeline Core dispatch sur `result.kind` pour les résultats attendus, MAIS
conserve un try/catch défensif autour de `await sender.send()` pour toute
exception inattendue (sender défectueux, exception non-Error, bug adapter). Ce
catch normalise en `UNCERTAIN / UNKNOWN_FAILURE_AFTER_CALL_START`. Aucun raw
Error ne traverse.

**Signature exacte du contrat Core** :

```typescript
/**
 * Résultat d'un envoi d'email transactionnel via le port provider-neutral.
 * Type fermé : aucun raw Error, cause fournisseur, PII ou secret ne traverse.
 * Le Core normalise TOUTE exception en UNCERTAIN (fail-closed).
 */
export type EmailSendResult =
  | { readonly kind: 'SENT'; readonly providerMessageId: string }
  | { readonly kind: 'DETERMINISTIC_REFUSAL'; readonly failureCode: EmailDeterministicFailureCode }
  | { readonly kind: 'TRANSIENT_NOT_SENT'; readonly failureCode: EmailTransientFailureCode }
  | { readonly kind: 'UNCERTAIN'; readonly failureCode: EmailUncertainFailureCode };

/**
 * Refus terminal déterministe : l'email n'a PAS été envoyé.
 * Retry automatique interdit.
 */
export type EmailDeterministicFailureCode =
  | 'INVALID_RECIPIENT'
  | 'TEMPLATE_NOT_SUPPORTED'
  | 'PROVIDER_REFUSED_DETERMINISTIC'
  | 'IDEMPOTENT_PAYLOAD_CONFLICT';

/**
 * Refus temporaire mais certainement non envoyé : l'appel a échoué avant
 * toute acceptation possible par le fournisseur. Retry automatique autorisé
 * dans la fenêtre < 24 h.
 */
export type EmailTransientFailureCode =
  | 'CONCURRENT_IDEMPOTENT_REQUESTS'
  | 'PROVIDER_RATE_LIMITED';

/**
 * Résultat incertain après début d'appel : l'email a PU être envoyé.
 * Retry automatique idempotent autorisé dans la fenêtre < 23 h si
 * attempts < MAX_ATTEMPTS. Sinon transition vers REQUIRES_MANUAL_REVIEW.
 */
export type EmailUncertainFailureCode =
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_NETWORK_ERROR'
  | 'PROVIDER_5XX'
  | 'PROVIDER_INVALID_RESPONSE'
  | 'UNKNOWN_FAILURE_AFTER_CALL_START';
```

**Signature du port mise à jour** :

```typescript
export interface TransactionalEmailSender {
  send(input: EmailInput): Promise<EmailSendResult>;
}
```

L'adapter Resend G5H-B existant devra être mis à jour en G5H-C2 pour retourner
`EmailSendResult` au lieu de lever `ResendEmailError`. Le mapping Resend →
`EmailSendResult` est défini en §13.5.

### 13.5 Q5 — Mapping Resend

Tableau fermé. Pour chaque cas Resend : appel commencé, certitude non-envoi,
retry auto, état cible notification, failure code.

| Cas Resend | Appel commencé | Certitude non-envoi | Retry auto | État cible notification | Failure code |
| --- | --- | --- | --- | --- | --- |
| Validation locale avant appel (`INVALID_REQUEST`) | Non | Oui | Non (déterministe) | `FAILED` | `INVALID_RECIPIENT` ou `TEMPLATE_NOT_SUPPORTED` → `DETERMINISTIC_REFUSAL` |
| `invalid_idempotency_key` (400) | Oui | Oui | Non (déterministe) | `FAILED` | `PROVIDER_REFUSED_DETERMINISTIC` |
| `invalid_idempotent_request` (409, payload différent) | Oui | Oui (rejet explicite) | Non (déterministe) | `FAILED` | `IDEMPOTENT_PAYLOAD_CONFLICT` → `DETERMINISTIC_REFUSAL` |
| `concurrent_idempotent_requests` (409) | Oui | Oui (concurrent, aucun envoyé) | Oui (retry sûr) | `PENDING` | `CONCURRENT_IDEMPOTENT_REQUESTS` → `TRANSIENT_NOT_SENT` |
| 400 (autre que `invalid_idempotency_key`) | Oui | Oui | Non (déterministe) | `FAILED` | `PROVIDER_REFUSED_DETERMINISTIC` |
| 401/403 (auth) | Oui | Oui (rejet avant envoi) | Non (déterministe, config) | `FAILED` | `PROVIDER_REFUSED_DETERMINISTIC` |
| 404 | Oui | Oui | Non (déterministe) | `FAILED` | `PROVIDER_REFUSED_DETERMINISTIC` |
| 422 (validation Resend) | Oui | Oui | Non (déterministe) | `FAILED` | `PROVIDER_REFUSED_DETERMINISTIC` |
| 429 (rate limit) | Oui | Oui (rate-limit avant envoi) | Oui (retry sûr) | `PENDING` | `PROVIDER_RATE_LIMITED` → `TRANSIENT_NOT_SENT` |
| 5xx | Oui | Incertain | Oui si < 23 h et attempts < MAX (retry idempotent) ; sinon manuel | `PENDING` (retry) ou `REQUIRES_MANUAL_REVIEW` | `PROVIDER_5XX` → `UNCERTAIN` |
| timeout | Oui | Incertain | Oui si < 23 h et attempts < MAX (retry idempotent) ; sinon manuel | `PENDING` (retry) ou `REQUIRES_MANUAL_REVIEW` | `PROVIDER_TIMEOUT` → `UNCERTAIN` |
| erreur réseau | Oui | Incertain | Oui si < 23 h et attempts < MAX (retry idempotent) ; sinon manuel | `PENDING` (retry) ou `REQUIRES_MANUAL_REVIEW` | `PROVIDER_NETWORK_ERROR` → `UNCERTAIN` |
| exception inconnue | Incertain (on ne sait pas si l'appel a commencé) | Incertain | Oui si < 23 h et attempts < MAX (retry idempotent) ; sinon manuel | `PENDING` (retry) ou `REQUIRES_MANUAL_REVIEW` | `UNKNOWN_FAILURE_AFTER_CALL_START` → `UNCERTAIN` |
| réponse incohérente après appel | Oui | Incertain | Oui si < 23 h et attempts < MAX (retry idempotent) ; sinon manuel | `PENDING` (retry) ou `REQUIRES_MANUAL_REVIEW` | `PROVIDER_INVALID_RESPONSE` → `UNCERTAIN` |

**Note sur 429** : Resend rate-limits **avant** d'accepter la requête. L'email n'a
**pas** été envoyé. C'est un refus temporaire certain → `TRANSIENT_NOT_SENT`,
retry auto autorisé. Le failure code Core est `PROVIDER_RATE_LIMITED` (ajouté à
`EmailTransientFailureCode` en §13.4). La classification `TRANSIENT_NOT_SENT` est
verrouillée.

**Note sur les résultats `UNCERTAIN` (5xx, timeout, réseau, exception inconnue,
réponse incohérente)** : un résultat incertain ne signifie pas que l'email n'a pas
été envoyé — il a PU l'être. Le retry automatique est **autorisé** si l'âge < 23 h
ET `attempts < MAX_ATTEMPTS`, avec exactement la même `providerIdempotencyKey` et
le même payload. Si l'email a déjà été envoyé, Resend déduplique dans la fenêtre
24 h et retourne le même `providerMessageId`. Si l'email n'a pas été envoyé, il
est envoyé maintenant. C'est toute la valeur de l'idempotence Resend. Si l'âge ≥
23 h ou `attempts ≥ MAX_ATTEMPTS`, la delivery passe en `REQUIRES_MANUAL_REVIEW`
(car l'envoi a pu réussir, on ne peut jamais passer en `FAILED`). Voir §13.6 pour
la machine d'états complète.

**Note sur `invalid_idempotent_request`** : c'est un 409 indiquant que la clé a
déjà été utilisée avec un payload différent. Cela signifie qu'un envoi précédent
avec un payload différent a eu lieu. L'email actuel n'a **pas** été envoyé. C'est
déterministe → `DETERMINISTIC_REFUSAL` / `IDEMPOTENT_PAYLOAD_CONFLICT`. Aucun
retry. L'opérateur doit investiguer (anomalie : deux payloads différents pour la
même clé — ne devrait pas arriver car la clé est dérivée de
`outbox_event_id`).

**Note sur `invalid_idempotency_key`** : c'est une réponse fournisseur (400)
après un appel HTTP commencé. L'« Appel commencé » est donc OUI, même si le
non-envoi est certain. Classification : `DETERMINISTIC_REFUSAL` /
`PROVIDER_REFUSED_DETERMINISTIC`. Aucun retry.

### 13.6 Q6 — Machine d'états

Tableau exhaustif : état DB initial × résultat Phase B × âge première tentative →
`notification_delivery` → `outbox_effect SEND_EMAIL` → `outbox_event` → prochaine
action.

| # | État initial | Résultat Phase B | Âge | notification | SEND_EMAIL | outbox_event | Prochaine action |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `PENDING` | `SENT` | < 23 h | `SENT` | `COMPLETED` | `PROCESSED` (si 4/4) | terminé |
| 2 | `PENDING` | `DETERMINISTIC_REFUSAL` | _ | `FAILED` | `FAILED` | `FAILED` | terminé |
| 3 | `PENDING` | `TRANSIENT_NOT_SENT` | < 23 h, attempts < MAX | `PENDING` | `PENDING` + backoff | `PENDING` (available_at = now + backoff) | retry |
| 4 | `PENDING` | `TRANSIENT_NOT_SENT` | < 23 h, attempts ≥ MAX | `FAILED` | `FAILED` | `FAILED` | terminé (certain non-envoyé) |
| 5 | `PENDING` | `TRANSIENT_NOT_SENT` | ≥ 23 h | `REQUIRES_MANUAL_REVIEW` (`EMAIL_RETRY_WINDOW_EXPIRED`) | `PENDING` | `PENDING` (lease nettoyée, exclu claim) | manuel/cutoff |
| 6 | `PENDING` | `UNCERTAIN` | < 23 h, attempts < MAX | `PENDING` | `PENDING` + backoff | `PENDING` (available_at = now + backoff) | retry idempotent (même clé + même payload) |
| 7 | `PENDING` | `UNCERTAIN` | < 23 h, attempts ≥ MAX | `REQUIRES_MANUAL_REVIEW` (`PROVIDER_RESULT_UNCERTAIN`) | `PENDING` | `PENDING` (lease nettoyée, exclu claim) | manuel (incertain, MAX atteint) |
| 8 | `PENDING` | `UNCERTAIN` | ≥ 23 h | `REQUIRES_MANUAL_REVIEW` (`EMAIL_RETRY_WINDOW_EXPIRED`) | `PENDING` | `PENDING` (lease nettoyée, exclu claim) | manuel/cutoff |
| 9 | `SENT` | _ | _ | `SENT` (inchangé) | `COMPLETED` | `PROCESSED` (si 4/4) | terminé (reconcile) |
| 10 | `FAILED` | _ | _ | `FAILED` (inchangé) | `FAILED` | `FAILED` | terminé (reconcile) |
| 11 | `REQUIRES_MANUAL_REVIEW` | _ | _ | `REQUIRES_MANUAL_REVIEW` (inchangé) | `PENDING` | `PENDING` (exclu claim) | manuel (aucune action worker) |
| 12 | `PENDING` (crash avant appel, timestamp NULL) | — | NULL | `PENDING` | `PENDING` | `PENDING` (reclaimed) | retry (aucun appel n'a eu lieu) |
| 13 | `PENDING` (crash pendant/après appel, timestamp présent) | — | < 23 h, attempts < MAX | `PENDING` | `PENDING` + backoff | `PENDING` (available_at = now + backoff) | retry idempotent (conservatif : appel a pu avoir lieu, retry avec même clé) |
| 14 | `PENDING` (crash pendant/après appel, timestamp présent) | — | < 23 h, attempts ≥ MAX | `REQUIRES_MANUAL_REVIEW` (`PROVIDER_RESULT_UNCERTAIN`) | `PENDING` | `PENDING` (lease nettoyée, exclu claim) | manuel (incertain, MAX atteint) |
| 15 | `PENDING` (crash pendant/après appel, timestamp présent) | — | ≥ 23 h | `REQUIRES_MANUAL_REVIEW` (`EMAIL_RETRY_WINDOW_EXPIRED`) | `PENDING` | `PENDING` (lease nettoyée, exclu claim) | manuel/cutoff |
| 16 | _ | `LEASE_LOST` | _ | inchangé | inchangé | inchangé | autre worker reclaim |
| 17 | _ | retry concurrent (deux workers) | _ | inchangé pour le perdant | inchangé | inchangé | `LEASE_LOST` pour le perdant (fencing) |
| 18 | `PENDING` | `LEASE_LOST` pendant tx fenced Phase B avant COMMIT | NULL | `PENDING` (rollback) | `PENDING` (rollback) | reclaimable | retry (aucun appel, timestamp NULL) |
| 19 | `PENDING` (timestamp présent, âge ≥ 23 h détecté au claim/sweep) | — (branche DB sûre, aucun appel) | ≥ 23 h | `REQUIRES_MANUAL_REVIEW` (`EMAIL_RETRY_WINDOW_EXPIRED`) | `PENDING` | `PENDING` (lease nettoyée, exclu claim) | manuel/cutoff (branche DB sûre, aucun appel fournisseur) |
| 20 | `PENDING` (crash après acceptation avant Phase C, timestamp présent) | — | < 23 h, attempts < MAX | `PENDING` | `PENDING` + backoff | `PENDING` (available_at = now + backoff) | retry idempotent (l'email a pu être envoyé, retry avec même clé) |
| 21 | `PENDING` (documents ont consommé plusieurs claims, mais premier email encore autorisé) | — | `SEND_EMAIL.attempt_count` = 0, `outbox_events.attempt_count` >= MAX | `PENDING` | `PENDING` | `PENDING` (claimable email) | retry email (budget email intact) |
| 22 | `PENDING` (premier email avec `outbox.attempt_count` >= MAX mais `SEND_EMAIL.attempt_count` = 0) | — | * | `PENDING` | `PENDING` | `PENDING` (claimable email) | retry email (budget email intact) |
| 23 | `PENDING` | `SENT` (5e tentative email) | < 23 h | `SENT` | `COMPLETED` | `PROCESSED` (si 4/4) | terminé (5e tentative réussie) |
| 24 | `PENDING` | `TRANSIENT_NOT_SENT` (5e tentative, attempts >= MAX) | < 23 h | `FAILED` | `FAILED` | `FAILED` | terminé (certain non-envoyé, budget épuisé) |
| 25 | `PENDING` | `UNCERTAIN` (5e tentative, attempts >= MAX) | < 23 h | `REQUIRES_MANUAL_REVIEW` (`PROVIDER_RESULT_UNCERTAIN`) | `PENDING` | `PENDING` (lease nettoyée, exclu claim) | manuel (incertain, MAX atteint) |
| 26 | `PENDING` (lease_token NULL, lease_until NULL) + budget email épuisé (`SEND_EMAIL.attempt_count >= MAX_EMAIL_ATTEMPTS`) | — (finalizer DB-only) | < 23 h | `REQUIRES_MANUAL_REVIEW` (`PROVIDER_RESULT_UNCERTAIN`) | `PENDING` (lease nettoyée) | `PENDING` (exclu claim) | manuel (finalizer, aucun 6e appel) |
| 27 | `PENDING` (lease_token NULL, lease_until NULL) + cutoff 23 h atteint | — (finalizer DB-only) | >= 23 h | `REQUIRES_MANUAL_REVIEW` (`EMAIL_RETRY_WINDOW_EXPIRED`) | `PENDING` (lease nettoyée) | `PENDING` (exclu claim) | manuel/cutoff (finalizer, aucun appel) |
| 28 | `PROCESSING` (lease expirée exactement à `transaction_timestamp()`, `lease_until = transaction_timestamp()`) + budget épuisé | — (finalizer DB-only) | < 23 h | `REQUIRES_MANUAL_REVIEW` (`PROVIDER_RESULT_UNCERTAIN`) | `PENDING` (lease nettoyée) | `PENDING` (exclu claim) | manuel (finalizer, lease `<=` expirée, aucun appel) |
| 29 | `PROCESSING` (lease dépassée, `lease_until < transaction_timestamp()`) + cutoff 23 h | — (finalizer DB-only) | >= 23 h | `REQUIRES_MANUAL_REVIEW` (`EMAIL_RETRY_WINDOW_EXPIRED`) | `PENDING` (lease nettoyée) | `PENDING` (exclu claim) | manuel/cutoff (finalizer, lease expirée, aucun appel) |
| 30 | `PROCESSING` (lease encore active, `lease_until > transaction_timestamp()`) | — (finalizer DB-only) | * | inchangé (lease valide, finalizer skip) | inchangé | inchangé | finalizer ne mute rien (lease active) |
| 31 | `PENDING` avec `lease_token` non-null (incohérent) OU `PROCESSING` avec `lease_token` NULL (incohérent) OU `PROCESSING` avec `lease_until` NULL (incohérent) | — (finalizer DB-only) | * | inchangé (fail-closed, ignoré) | inchangé | inchangé | ignoré + log/métrique nettoyé, aucune mutation, aucun appel |
| 32 | `PENDING` (lease_token NULL, lease_until NULL) + cutoff 23 h **ET** budget épuisé simultanément | — (finalizer DB-only) | >= 23 h | `REQUIRES_MANUAL_REVIEW` (`EMAIL_RETRY_WINDOW_EXPIRED` prioritaire) | `PENDING` (lease nettoyée) | `PENDING` (exclu claim) | manuel (priorité cutoff, aucun appel) |
| 33 | notification déjà `REQUIRES_MANUAL_REVIEW` | — (finalizer DB-only) | * | inchangé (déjà terminal manuel) | inchangé | inchangé | finalizer skip (déjà finalisé) |
| 34 | * (finalizer concurrent exécuté par deux workers) | — | * | une seule transition (`FOR UPDATE SKIP LOCKED`) | inchangé pour le perdant | inchangé pour le perdant | un finalizer gagne, l'autre skip |
| 35 | * | — | * | aucune 6e requête fournisseur | — | — | invariant absolu respecté |

**Note explicative sur les cas 21-35** : les cas 21-22 illustrent la séparation
du budget (`outbox_events.attempt_count` élevé mais `SEND_EMAIL.attempt_count` =
0 → budget email intact). Les cas 26-29 illustrent les combinaisons
statut/lease couvertes par le finalizer DB-only : `PENDING` avec leases NULL
(cas 26-27, 32), `PROCESSING` avec lease expirée à `transaction_timestamp()`
(cas 28, borne inclusive `<=`), `PROCESSING` avec lease dépassée (cas 29). Le
cas 30 couvre `PROCESSING` avec lease encore active (finalizer skip). Le cas 31
couvre les combinaisons incohérentes statut/lease (ignorées fail-closed avec
log/métrique). Le cas 32 couvre cutoff + budget épuisé simultanément (priorité
cutoff). Le cas 33 couvre une notification déjà finalisée. Les cas 34-35
couvrent la concurrence et l'invariant absolu : aucune 6e requête fournisseur
n'est jamais effectuée.

**Note importante sur les cas 13, 20** : le retry après crash avec timestamp
présent est idempotent — on revoie avec exactement la même `providerIdempotencyKey`
et le même payload. Si l'email a déjà été envoyé, Resend déduplique dans la
fenêtre 24 h et retourne le même `providerMessageId`. Si l'email n'a pas été
envoyé, il est envoyé maintenant. C'est toute la valeur de l'idempotence Resend.

**Règles dérivées** :

- **Cas 1 (SENT)** : succès normal. `notification_deliveries` → `SENT`,
  `outbox_effects SEND_EMAIL` → `COMPLETED`, `outbox_events` → `PROCESSED` si les
  quatre effets sont `COMPLETED`.
- **Cas 2 (DETERMINISTIC_REFUSAL)** : refus terminal déterministe (destinataire
  invalide, template non supporté, refus fournisseur déterministe,
  `IDEMPOTENT_PAYLOAD_CONFLICT`). L'email n'a **pas** été envoyé. `FAILED`
  terminal, aucun retry.
- **Cas 3 (TRANSIENT_NOT_SENT, retry)** : refus temporaire certain (rate limit,
  requêtes concurrentes). L'email n'a **pas** été envoyé. Retry automatique avec
  backoff dans la fenêtre < 23 h si `attempts < MAX_ATTEMPTS`.
- **Cas 4 (TRANSIENT_NOT_SENT, MAX atteint)** : le non-envoi est certain.
  `FAILED` est acceptable puisque le non-envoi est certain.
- **Cas 5 (TRANSIENT_NOT_SENT, cutoff)** : âge ≥ 23 h. On ne peut plus garantir
  la déduplication Resend. `REQUIRES_MANUAL_REVIEW` avec
  `EMAIL_RETRY_WINDOW_EXPIRED`.
- **Cas 6 (UNCERTAIN, retry idempotent)** : résultat incertain mais âge < 23 h et
  `attempts < MAX_ATTEMPTS`. Retry automatique avec exactement la même
  `providerIdempotencyKey` et le même payload. notification `PENDING`,
  `SEND_EMAIL` `PENDING` + backoff, outbox `PENDING` avec `available_at = now +
  backoff`.
- **Cas 7 (UNCERTAIN, MAX atteint)** : `MAX_ATTEMPTS` atteint avec résultat
  incertain. `REQUIRES_MANUAL_REVIEW` avec `PROVIDER_RESULT_UNCERTAIN`. JAMAIS
  `FAILED`, car l'envoi peut avoir réussi.
- **Cas 8 (UNCERTAIN, cutoff)** : résultat incertain et âge ≥ 23 h.
  `REQUIRES_MANUAL_REVIEW` avec `EMAIL_RETRY_WINDOW_EXPIRED`.
- **Cas 9-10 (déjà terminal)** : reconcile sans changement.
- **Cas 11 (déjà REQUIRES_MANUAL_REVIEW)** : aucune action worker. L'événement
  reste exclu du claim.
- **Cas 12 (crash avant appel, timestamp NULL)** :
  `provider_first_attempt_started_at` est NULL. Pas de cutoff calculé. Aucun
  appel n'a eu lieu. La delivery reste `PENDING`, l'effet reste `PENDING`,
  l'événement est reclaimed. Le retry est autorisé.
- **Cas 13-15 (crash pendant/après appel, timestamp présent)** :
  `provider_first_attempt_started_at` est non-null. Conservativement, on
  considère qu'un appel a pu avoir lieu. Le retry est **autorisé** si âge < 23 h
  ET `attempts < MAX_ATTEMPTS` (cas 13), avec la même `providerIdempotencyKey` et
  le même payload. Si `MAX_ATTEMPTS` atteint (cas 14) →
  `REQUIRES_MANUAL_REVIEW` / `PROVIDER_RESULT_UNCERTAIN`. Si âge ≥ 23 h (cas 15)
  → `REQUIRES_MANUAL_REVIEW` / `EMAIL_RETRY_WINDOW_EXPIRED`.
- **Cas 16-17 (lease perdue / concurrence)** : le fencing par `lease_token` +
  `lease_until > transaction_timestamp()` garantit qu'un seul worker persiste.
  Le perdant obtient 0 lignes au `SELECT FOR UPDATE` → `LEASE_LOST`, aucune
  persistance.
- **Cas 18 (LEASE_LOST pendant tx fenced Phase B)** : rollback de la transaction
  fenced. `attempt_count` non incrémenté, timestamp NULL. Aucun appel n'a eu
  lieu. Retry autorisé.
- **Cas 19 (branche DB sûre, âge ≥ 23 h détecté au claim/sweep)** : une delivery
  `PENDING` dont `provider_first_attempt_started_at` est non-null et dont l'âge
  calculé en DB est ≥ 23 h est traitée par une branche DB sûre lors du claim ou du
  sweep : le worker détecte l'âge ≥ 23 h dans la transaction de claim (Phase A ou
  Phase B), et passe atomiquement la delivery en `REQUIRES_MANUAL_REVIEW` avec
  `failure_code = 'EMAIL_RETRY_WINDOW_EXPIRED'`, **sans effectuer d'appel
  fournisseur**. Voir §13.9 pour le détail de cette branche.
- **Cas 20 (crash après acceptation avant Phase C)** : l'email a pu être envoyé
  par le fournisseur mais le `providerMessageId` n'a pas été persisté. Le retry
  est idempotent avec la même clé et le même payload.

### 13.7 Q7 — Ordre des transactions et verrous

**Phase A** — transaction courte (claim `outbox_events` + init
`notification_deliveries` `PENDING`) :

- Verrous : `outbox_events` (`SELECT FOR UPDATE`) → `outbox_effects`
  (`SELECT FOR UPDATE ORDER BY effect_type`) → `notification_deliveries`
  (`SELECT FOR UPDATE`).
- Aucun appel externe.

**Phase B** — hors transaction pour l'appel, transaction courte fenced pour la
réservation :

1. **Transaction courte fenced (réservation)** : `SELECT FOR UPDATE`
   `outbox_events` (vérification lease) → `SELECT FOR UPDATE` `outbox_effects`
   (`SEND_EMAIL` `PENDING`) → `UPDATE attempt_count + SET
   provider_first_attempt_started_at = transaction_timestamp() WHERE NULL`.
   Verrous : `outbox_events` → `outbox_effects`.
2. **Appel `sender.send()`** : HORS transaction, HORS verrou.

La transaction fenced de Phase B (réservation + persistance du timestamp) doit
être explicitement COMMITTÉE avant tout appel réseau. L'appel `sender.send()` se
fait dans un contexte entièrement hors transaction, sur une connexion séparée ou
après libération de la connexion transactionnelle. Aucun appel réseau ne peut
être initié dans une transaction PostgreSQL active. Garde-fou : l'implémentation
G5H-C2 doit vérifier qu'aucun handle de transaction n'est actif au moment de
l'appel `sender.send()`.

**Phase C** — transaction courte (persistance + réconciliation) :

- Verrous : `outbox_events` (`SELECT FOR UPDATE`) → `outbox_effects`
  (`SELECT FOR UPDATE ORDER BY effect_type`) → `notification_deliveries`
  (`SELECT FOR UPDATE`).

**Ordre des verrous** : `outbox_events` → `outbox_effects` →
`notification_deliveries` (cohérent entre Phase A, B, C — évite deadlock).

**Deux workers concurrents** : fencing par `lease_token` + `lease_until >
transaction_timestamp()`. Le perdant obtient 0 lignes au `SELECT FOR UPDATE` →
`LEASE_LOST`.

**Sweeper** : réclame les `outbox_events` `PROCESSING` avec `lease_until <
now()`. Si `notification_deliveries` est `REQUIRES_MANUAL_REVIEW` → **exclu du
reclaim** (ne pas retraiter automatiquement). Le filtre se fait par `NOT EXISTS`
sur `notification_deliveries.status` (voir §13.9 pour le SQL complet). Le sweeper
applique aussi la branche DB sûre pour les deliveries vieillissantes (âge ≥ 23 h,
aucun appel fournisseur — voir §13.9).

**Règle absolue** : aucun appel externe sous transaction ou verrou DB.

#### Invariant de réservation atomique (Phase B étape 1)

Dans la même transaction fenced (Phase B étape 1), l'ordre exact des opérations
est le suivant :

1. lock `outbox_event` (`SELECT FOR UPDATE`) ;
2. lock `SEND_EMAIL` effect (`SELECT FOR UPDATE`) ;
3. lock `notification_delivery` (`SELECT FOR UPDATE`) ;
4. vérifier `effect.status = PENDING` ;
5. vérifier `notification.status = PENDING` ;
6. vérifier âge < 23 h (si `provider_first_attempt_started_at` non-null) ;
7. vérifier `SEND_EMAIL.attempt_count < MAX_ATTEMPTS` ;
8. incrémenter `SEND_EMAIL.attempt_count` ;
9. renseigner `provider_first_attempt_started_at` uniquement s'il est NULL ;
10. commit ;
11. seulement ensuite appeler le fournisseur.

**Si cette transaction rollback** :

- aucun compteur incrémenté ;
- aucun timestamp ajouté ;
- aucun appel fournisseur.

Cet invariant garantit que la réservation (compteur + timestamp) et l'appel
fournisseur sont strictement séquencés : la persistance précède toujours
l'appel, et un rollback annule toute trace de réservation.

### 13.8 Q8 — Plan de la migration 0029 (plan, NE PAS créer)

La migration 0029 sera créée et appliquée dans G5H-C2. Le plan est verrouillé
ici. Les migrations 0001-0028 existantes ne sont **jamais** modifiées.

**Stratégie : SEULE migration 0029 transactionnelle (remplacement transactionnel
des enums)**. Le runner Drizzle (drizzle-orm 0.36.4) exécute toutes les
migrations en attente dans **une transaction commune** (preuve locale vérifiée :
`node_modules/.pnpm/drizzle-orm@0.36.4_.../node_modules/drizzle-orm/pg-core/dialect.js`
ligne 62 — `await session.transaction(async (tx) => { for await (const migration
of migrations) { ... } })`). Séparer `ALTER TYPE ADD VALUE` dans 0029 et
utiliser les valeurs dans 0030 **ne crée pas de commit intermédiaire** lorsqu'une
base applique 0029 et 0030 ensemble. Le découpage en deux fichiers est donc
**interdit** : il ne résout pas le problème et introduit un faux sentiment de
sécurité. La stratégie retenue est le **remplacement transactionnel des enums**
dans une seule migration 0029.

**Cible PostgreSQL** : PostgreSQL 16. Ne pas affirmer « Neon est PG 17+ » sans
preuve.

**Pour `notification_delivery_status`** :

1. Supprimer temporairement les contraintes/triggers dépendants : `DROP TRIGGER
   before_check_notification_delivery_transition`, `DROP FUNCTION
   before_check_notification_delivery_transition()`, `DROP CHECK` constraints
   `notification_deliveries_pending_invariants`,
   `notification_deliveries_sent_invariants`,
   `notification_deliveries_failed_invariants`.
2. Renommer l'ancien enum : `ALTER TYPE notification_delivery_status RENAME TO
   notification_delivery_status_old;`
3. Créer le nouvel enum complet : `CREATE TYPE notification_delivery_status AS
   ENUM('PENDING', 'SENT', 'FAILED', 'REQUIRES_MANUAL_REVIEW');`
4. Supprimer le default de la colonne : `ALTER TABLE notification_deliveries
   ALTER COLUMN status DROP DEFAULT;`
5. Convertir : `ALTER TABLE notification_deliveries ALTER COLUMN status TYPE
   notification_delivery_status USING
   status::text::notification_delivery_status;`
6. Restaurer le default : `ALTER TABLE notification_deliveries ALTER COLUMN
   status SET DEFAULT 'PENDING';`
7. Supprimer l'ancien enum : `DROP TYPE notification_delivery_status_old;`
8. Recréer les CHECK constraints (mises à jour avec `REQUIRES_MANUAL_REVIEW`) et
   le trigger `before_check_notification_delivery_transition` (mis à jour pour
   autoriser `PENDING → REQUIRES_MANUAL_REVIEW` et
   `REQUIRES_MANUAL_REVIEW → SENT/FAILED` par humain uniquement).

**Pour `document_processing_failure_code`** :

1. Identifier toutes les colonnes dépendantes :
   `outbox_effects.failure_code`, `notification_deliveries.failure_code`.
2. Supprimer temporairement les CHECK constraints dépendantes (celles qui
   référencent `failure_code`).
3. Renommer l'ancien enum : `ALTER TYPE document_processing_failure_code RENAME
   TO document_processing_failure_code_old;`
4. Créer le nouvel enum complet incluant `PROVIDER_RESULT_UNCERTAIN` et
   `EMAIL_RETRY_WINDOW_EXPIRED` : `CREATE TYPE
   document_processing_failure_code AS ENUM('PAYLOAD_MALFORMED',
   'STORAGE_PUT_FAILED', 'STORAGE_CHECKSUM_MISMATCH', 'STORAGE_NOT_FOUND',
   'RENDER_FAILED', 'EMAIL_SEND_FAILED', 'LEASE_LOST', 'UNKNOWN_ERROR',
   'PROVIDER_RESULT_UNCERTAIN', 'EMAIL_RETRY_WINDOW_EXPIRED');`
5. Convertir toutes les colonnes dépendantes via cast texte : `ALTER TABLE
   outbox_effects ALTER COLUMN failure_code TYPE
   document_processing_failure_code USING
   failure_code::text::document_processing_failure_code;` et `ALTER TABLE
   notification_deliveries ALTER COLUMN failure_code TYPE
   document_processing_failure_code USING
   failure_code::text::document_processing_failure_code;`
6. Supprimer l'ancien enum : `DROP TYPE document_processing_failure_code_old;`
7. Recréer toutes les CHECK constraints et fonctions nécessaires.

**Dans cette même migration 0029, ajouter aussi** :

- Colonne `notification_deliveries.provider_first_attempt_started_at`
  (`timestamptz`, nullable, default NULL).
- CHECK constraints pour `REQUIRES_MANUAL_REVIEW` (`provider_message_id` NULL,
  `sent_at` NULL, `failure_code IN ('PROVIDER_RESULT_UNCERTAIN',
  'EMAIL_RETRY_WINDOW_EXPIRED')`).
- Trigger d'immutabilité du timestamp (`BEFORE UPDATE` sur
  `notification_deliveries` : lève une exception si
  `OLD.provider_first_attempt_started_at IS NOT NULL AND
  NEW.provider_first_attempt_started_at IS DISTINCT FROM
  OLD.provider_first_attempt_started_at`).
- Trigger de transition mis à jour (`PENDING → REQUIRES_MANUAL_REVIEW` autorisé,
  `REQUIRES_MANUAL_REVIEW → SENT/FAILED` par humain uniquement,
  `REQUIRES_MANUAL_REVIEW` immuable par le worker).
- Index partiels :
  - Index partiel sur `notification_deliveries(status) WHERE status =
    'REQUIRES_MANUAL_REVIEW'` (pour lister les livraisons en attente de revue).
  - Index partiel sur
    `notification_deliveries(provider_first_attempt_started_at) WHERE
    provider_first_attempt_started_at IS NOT NULL` (pour le sweep des incertains
    âgés).

**Aucune modification des migrations 0001-0028 existantes.**

**Backfill** :

- Lignes `PENDING` existantes : `provider_first_attempt_started_at = NULL`
  (jamais tenté selon le nouveau modèle).
- Lignes `SENT` existantes : `provider_first_attempt_started_at = NULL` (on ne
  peut pas reconstruire le timestamp du premier appel à partir de `sent_at` qui
  est le timestamp de succès, potentiellement après plusieurs retries). Ces
  lignes sont déjà terminales et ne seront jamais retraitées.
- Lignes `FAILED` existantes : `provider_first_attempt_started_at = NULL` (on ne
  sait pas).

**Compatibilité avec les 28 migrations déjà appliquées** :

- Colonne nullable sans default (instantané).
- Trigger ajout (verrou court).
- Aucun rewrite de table. Aucun downtime.

**Journal attendu** : 28 → 29 migrations (PAS 30).

**Tests PostgreSQL obligatoires en G5H-C2** (à ajouter au plan de test) :

- Migration depuis un schéma arrêté exactement après 0028.
- Migration d'une base vierge 0001 → 0029.
- Conservation des lignes `PENDING`/`SENT`/`FAILED` existantes.
- Conservation des failure codes existants dans les deux tables
  (`outbox_effects` et `notification_deliveries`).
- Rejeu idempotent du migrateur (Drizzle ne doit pas réappliquer 0029 si déjà
  appliquée).
- Vérification qu'aucune nouvelle valeur enum n'est utilisée avant d'exister.
- Migration réellement exécutée par le runner Drizzle du dépôt (drizzle-orm
  0.36.4, transaction unique).

**Note** : si une meilleure stratégie transactionnelle est proposée en G5H-C2,
elle doit être démontrée avec le runner Drizzle réel. Le simple découpage en deux
fichiers est **interdit**.

### 13.9 Q9 — Intervention manuelle

**Comportement minimal sans UI** :

- **Comment une delivery est marquée `REQUIRES_MANUAL_REVIEW`** : par le worker
  automatique en Phase C, quand `sendOutcome.kind === 'UNCERTAIN'` ET (âge ≥ 23 h
  OU `attempts ≥ MAX_ATTEMPTS`), OU quand `sendOutcome.kind ===
  'TRANSIENT_NOT_SENT'` ET âge ≥ 23 h. Le cutoff ne peut être calculé que si
  `provider_first_attempt_started_at` est non-null. Un résultat `UNCERTAIN` avec
  âge < 23 h ET `attempts < MAX_ATTEMPTS` est **retryé automatiquement** (cas 6,
  §13.6), pas passé en `REQUIRES_MANUAL_REVIEW`.
- **Comment elle est exclue du claim automatique** : le claim `outbox_events`
  filtre les événements dont la `notification_deliveries` associée est
  `REQUIRES_MANUAL_REVIEW` (JOIN avec filtre `NOT EXISTS` sur
  `notification_deliveries.status`). Le sweeper aussi.
- **Informations non sensibles pour identification** : `outbox_event_id`,
  `organization_id`, `template_key`, `failure_code`,
  `provider_first_attempt_started_at`, âge calculé. **Pas de `recipient_email`**
  dans les logs/rapports (PII). L'opérateur peut accéder à `recipient_email` via
  la DB avec les permissions appropriées (accès audité). La procédure manuelle de
  vérification via le Resend dashboard peut nécessiter une recherche par
  destinataire — l'opérateur récupère alors `recipient_email` depuis la DB, jamais
  depuis les logs du worker.
- **Aucune action automatique** pour renvoyer l'email.

#### Résolution manuelle atomique (use case administratif futur)

La résolution `REQUIRES_MANUAL_REVIEW → SENT` ou `REQUIRES_MANUAL_REVIEW →
FAILED` se fait **uniquement** via un use case administratif futur, pas via le
pipeline worker. Le worker ne fait que `PENDING → REQUIRES_MANUAL_REVIEW`. Tant
que ce use case administratif n'est pas implémenté : **aucune** instruction de
modification SQL manuelle partielle. La delivery reste en
`REQUIRES_MANUAL_REVIEW`. L'UI et le use case administratif sont reportés
explicitement.

**Résolution « envoyé confirmé » (transaction administrative atomique)** :

1. lock `outbox_events` (`SELECT FOR UPDATE`) ;
2. lock `outbox_effects` dans l'ordre (`SELECT FOR UPDATE ORDER BY effect_type`) ;
3. lock `notification_deliveries` (`SELECT FOR UPDATE`) ;
4. `REQUIRES_MANUAL_REVIEW → SENT` avec `provider_message_id` et `sent_at` ;
5. `SEND_EMAIL PENDING → COMPLETED` ;
6. si les quatre effets sont `COMPLETED`, `outbox_events → PROCESSED` ;
7. audit append-only de l'intervention ;
8. commit.

**Résolution « non envoyé confirmé » (transaction administrative atomique)** :

1. mêmes verrous ;
2. `REQUIRES_MANUAL_REVIEW → FAILED` avec `failure_code` ;
3. `SEND_EMAIL → FAILED` ;
4. `outbox_events → FAILED` ;
5. audit append-only ;
6. commit.

**Note sur le trigger PostgreSQL** : le trigger PostgreSQL ne peut pas
distinguer magiquement « humain » et « worker ». La restriction
`REQUIRES_MANUAL_REVIEW` immuable par le worker repose sur l'absence de chemin
worker + futur use case administratif autorisé et audité. Le document le dit
clairement : le worker ne fait que `PENDING → REQUIRES_MANUAL_REVIEW` ; la
résolution `REQUIRES_MANUAL_REVIEW → SENT/FAILED` se fait uniquement via le use
case administratif futur, pas via le pipeline worker.

#### Changement de code requis pour G5H-C2

Le filtre `READY_FOR_TRANSACTIONAL_EMAIL` dans
`packages/core/src/outbox-claim/claim-outbox-batch.ts` doit être mis à jour pour
exclure `REQUIRES_MANUAL_REVIEW`. Le filtre actuel utilise une clause `NOT EXISTS`
qui exclut les événements dont une delivery a un statut terminal. Il faut ajouter
`REQUIRES_MANUAL_REVIEW` à la liste des statuts exclus :

```sql
AND NOT EXISTS (
  SELECT 1 FROM "notification_deliveries" nd
  WHERE nd."outbox_event_id" = "outbox_events"."id"
    AND nd."organization_id" = "outbox_events"."organization_id"
    AND nd."status" IN ('SENT', 'FAILED', 'REQUIRES_MANUAL_REVIEW')
)
```

La clause `NOT EXISTS` exclut l'événement du claim si une delivery associée a un
statut dans la liste. Ajouter `REQUIRES_MANUAL_REVIEW` à cette liste garantit
qu'aucun worker automatique ne retraitera une delivery en attente de revue manuelle.

Le sweeper (`apps/worker/src/sweeper.ts`) doit appliquer la même exclusion. Sans ce
changement, une delivery en `REQUIRES_MANUAL_REVIEW` serait re-claimée
automatiquement, violant la politique fail-closed et risquant un double envoi.

**Branche DB sûre pour delivery vieillissante (âge ≥ 23 h détecté au
claim/sweep)** :

Une delivery `PENDING` dont `provider_first_attempt_started_at` est non-null et
dont l'âge calculé en DB est ≥ 23 h doit être traitée par une branche DB sûre lors
du claim ou du sweep : le worker détecte l'âge ≥ 23 h dans la transaction de claim
(Phase A ou Phase B), et passe atomiquement la delivery en
`REQUIRES_MANUAL_REVIEW` avec `failure_code = 'EMAIL_RETRY_WINDOW_EXPIRED'`, sans
effectuer d'appel fournisseur. Cette branche DB sûre :

- lock `outbox_events`, `outbox_effects`, `notification_deliveries` ;
- vérifie `provider_first_attempt_started_at IS NOT NULL AND
  transaction_timestamp() - provider_first_attempt_started_at >= interval '23
  hours'` ;
- `UPDATE notification_deliveries → REQUIRES_MANUAL_REVIEW`,
  `failure_code = 'EMAIL_RETRY_WINDOW_EXPIRED'` ;
- `UPDATE outbox_events → PENDING`, `lease_token = NULL`, `lease_until = NULL` ;
- commit ;
- aucun appel fournisseur.

Ainsi, une delivery vieillissante atteint `REQUIRES_MANUAL_REVIEW` sans nouvel
appel, respectant le fail-closed.

**Exclusion de SENT et FAILED du claim** : `SENT` et `FAILED` restent exclus du
claim seulement si leur effet/outbox correspondant a été réconcilié atomiquement
(ce qui est le cas via Phase C).

### 13.10 — Changements de code requis pour G5H-C2

Liste exhaustive des fichiers à modifier lors de l'implémentation G5H-C2 :

- `packages/core/src/outbox-claim/claim-outbox-batch.ts` : exclure
  `REQUIRES_MANUAL_REVIEW` du filtre + exception
  `ClaimEligibility.READY_FOR_TRANSACTIONAL_EMAIL` filtrant sur
  `SEND_EMAIL.attempt_count < MAX_ATTEMPTS` (via JOIN avec `outbox_effects`) au
  lieu de `outbox_events.attempt_count < MAX_ATTEMPTS`.
- `apps/worker/src/sweeper.ts` : exclure `REQUIRES_MANUAL_REVIEW` du reclaim.
- `packages/core/src/transactional-documents/types.ts` : remplacer `EmailResult`
  par `EmailSendResult` (unions corrigées — voir §13.4).
- `packages/core/src/transactional-documents/ports.ts` : mettre à jour la
  signature du port.
- `packages/core/src/transactional-documents/transactional-email-pipeline.ts` :
  dispatcher sur `result.kind` pour les résultats attendus, MAIS conserver un
  try/catch défensif autour de `await sender.send()` pour toute exception
  inattendue (normalisation en `UNCERTAIN /
  UNKNOWN_FAILURE_AFTER_CALL_START`).
- `apps/worker/src/adapters/resend-transactional-email-sender.ts` : retourner
  `EmailSendResult` au lieu de lever.
- `packages/database/src/schema.ts` : ajouter `REQUIRES_MANUAL_REVIEW`,
  `PROVIDER_RESULT_UNCERTAIN` et `EMAIL_RETRY_WINDOW_EXPIRED`.
- `packages/database/drizzle/0029_lot6_transactional_documents_idempotency.sql`
  : créer la SEULE migration transactionnelle (remplacement contrôlé des enums +
  colonne + CHECK + triggers + index).
- `apps/worker/src/finalizer.ts` (NOUVEAU) : helper/finalizer DB-only pour cutoff
  et tentatives épuisées.
- `apps/worker/src/finalizer.test.ts` (NOUVEAU) : tests unitaires et PostgreSQL
  du finalizer (concurrence, cutoff, MAX atteint, lease valide).

**Compte final de migrations** : 29 (PAS 30).

### 13.11 Éléments explicitement reportés

- **Implémentation G5H-C2** : migration 0029, mise à jour du contrat Core
  (`EmailSendResult`), mise à jour de l'adapter Resend, mise à jour du pipeline,
  tests unitaires et d'intégration PostgreSQL.
- **Use case administratif de résolution manuelle atomique** : reporté à un lot
  ultérieur. Les deux transactions administratives atomiques (résolution « envoyé
  confirmé » et « non envoyé confirmé ») ne sont pas implémentées dans G5H-C1 ou
  G5H-C2. Tant que ce use case n'est pas implémenté, aucune instruction de
  modification SQL manuelle partielle n'est autorisée. La delivery reste en
  `REQUIRES_MANUAL_REVIEW`.
- **UI d'intervention manuelle** : reportée à un lot ultérieur. Aucune interface
  n'est créée dans G5H-C1 ou G5H-C2.
- **Réconciliation automatique par recherche Resend** : non prévue (aucune API
  Resend de recherche par clé d'idempotence documentée au 2026-08-05).
- **Webhooks de délivrabilité/bounce** : reportés à un groupe futur (question 17
  ouverte).

### 13.12 Budget de retry email

Le claim générique filtre actuellement `outbox_events.attempt_count <
MAX_ATTEMPTS`. Mais ce compteur est déjà incrémenté lors des claims
documentaires (`GENERATE_CONFIRMATION`, `GENERATE_CONTRACT`,
`GENERATE_RECEIPT`). Il ne représente **pas** le nombre de tentatives d'envoi
d'email.

**Décision** : le budget de retry email est basé **exclusivement** sur
`outbox_effects.attempt_count` de l'effet `SEND_EMAIL`.

- L'incrément est effectué dans la transaction courte fenced juste avant l'appel
  (Phase B).
- Phase C utilise `effectAttemptCount` (`SEND_EMAIL.attempt_count`), **PAS**
  `outboxAttemptCount` (`outbox_events.attempt_count`), pour décider
  retry/`FAILED`/`REQUIRES_MANUAL_REVIEW`.
- Le compteur global `outbox_events.attempt_count` reste un compteur de
  claims/observabilité.
- Il ne doit **pas** empêcher la première tentative email ni écourter son budget.

**Pour `READY_FOR_TRANSACTIONAL_EMAIL`**, concevoir explicitement une
**exception** au filtre global `outbox_events.attempt_count < MAX_ATTEMPTS` :

- Le claim email sélectionne selon `SEND_EMAIL.attempt_count < MAX_ATTEMPTS`
  (via JOIN avec `outbox_effects`).
- Les autres éligibilités (compensation Stripe, pipeline documentaire) conservent
  leur comportement actuel.
- Compensation Stripe inchangée.
- Pipeline documentaire inchangé hors adaptation strictement nécessaire du
  filtre.

**Modification exacte attendue dans `claimOutboxBatch`** (§13.10, sans encore
l'implémenter) :

- Ajouter une exception `ClaimEligibility.READY_FOR_TRANSACTIONAL_EMAIL` qui
  filtre sur `outbox_effects.attempt_count < MAX_ATTEMPTS` pour l'effet
  `SEND_EMAIL`, au lieu de `outbox_events.attempt_count < MAX_ATTEMPTS`.
- Le filtre global `outbox_events.attempt_count < MAX_ATTEMPTS` reste pour les
  autres éligibilités.

### 13.13 Finalizer DB-only

Un finalizer DB-only indépendant du claim normal est conçu pour traiter deux
scénarios obligatoires sans effectuer d'appel fournisseur.

#### Scénario 1 : crash après dernière tentative

1. `SEND_EMAIL.attempt_count` passe de 4 à 5 dans la transaction de réservation.
2. `provider_first_attempt_started_at` existe.
3. L'appel fournisseur commence ou réussit.
4. Le worker crashe avant Phase C.
5. La lease expire.

Le claim normal ne doit **pas** effectuer un sixième appel, mais l'événement ne
doit pas rester `PROCESSING` indéfiniment.

Ce finalizer sélectionne les événements email éligibles selon les **deux seuls
états cohérents** statut/lease d'`outbox_events` :

```sql
(
  oe.status = 'PENDING'
  AND oe.lease_token IS NULL
  AND oe.lease_until IS NULL
)
OR
(
  oe.status = 'PROCESSING'
  AND oe.lease_token IS NOT NULL
  AND oe.lease_until <= transaction_timestamp()
)
```

**Conditions communes supplémentaires** (à combiner avec l'un des deux états
ci-dessus) :

- `notification_deliveries.status = 'PENDING'` ;
- `outbox_effects.effect_type = 'SEND_EMAIL'` ET `outbox_effects.status =
  'PENDING'` ;
- `notification_deliveries.provider_first_attempt_started_at IS NOT NULL` ;
- cutoff atteint (`transaction_timestamp() -
  provider_first_attempt_started_at >= interval '23 hours'`) OU
  `outbox_effects.attempt_count >= MAX_EMAIL_ATTEMPTS`.

**Règles sur les leases** :

- Une lease dont `lease_until = transaction_timestamp()` est considérée comme
  **expirée** (borne inclusive `<=`).
- Un `outbox_events` `PROCESSING` avec `lease_until > transaction_timestamp()`
  (lease encore active) n'est **jamais** modifié par le finalizer.
- Toute combinaison incohérente statut/lease (par ex. `PENDING` avec
  `lease_token` non-null, ou `PROCESSING` avec `lease_token` NULL, ou
  `PROCESSING` avec `lease_until` NULL) est **ignorée fail-closed** : aucune
  mutation, aucun appel fournisseur, mais le cas doit être observable par
  log/métrique nettoyé (sans PII) pour investigation.

**Ordre des verrous explicite** (trois opérations distinctes dans la même
transaction, pas un SELECT joint ambigu) :

1. Sélectionner et verrouiller `outbox_events` avec
   `SELECT ... FOR UPDATE SKIP LOCKED` (filtre statut/lease ci-dessus +
   `organization_id`).
2. Verrouiller l'effet `SEND_EMAIL` correspondant avec
   `SELECT ... FOR UPDATE` (même `outbox_event_id` + `organization_id` +
   `effect_type = 'SEND_EMAIL'`).
3. Verrouiller `notification_deliveries` avec `SELECT ... FOR UPDATE` (même
   `outbox_event_id` + `organization_id`).
4. **Revalider sous verrou** : statut `outbox_events`, leases, statut
   notification, statut effet, cutoff et `attempt_count`. Si une condition a
   changé entre la sélection et le verrouillage, abandonner sans mutation.
5. Appliquer les mutations atomiques (voir « État final exact » ci-dessous).

Tous les chemins concurrents concernés (claim normal, sweeper, finalizer)
respectent le même ordre de verrous :
`outbox_events` → `outbox_effects` → `notification_deliveries`.

Le finalizer n'effectue **aucun** appel fournisseur.

#### Scénario 2 : cutoff sans nouvel appel

Le finalizer DB-only doit **aussi** traiter le cutoff 23 h, **même si**
`SEND_EMAIL.attempt_count < MAX_EMAIL_ATTEMPTS`. Les conditions d'éligibilité
sont les mêmes que pour le scénario 1 (états statut/lease + conditions communes),
avec la condition supplémentaire :

- âge PostgreSQL >= 23 h (`transaction_timestamp() -
  provider_first_attempt_started_at >= interval '23 hours'`).

L'ordre des verrous et la revalidation sous verrou sont identiques au scénario 1.

#### Priorité stable si MAX_EMAIL_ATTEMPTS et cutoff sont tous deux atteints

- `EMAIL_RETRY_WINDOW_EXPIRED` si âge >= 23 h (priorité au cutoff, car la fenêtre
  Resend est expirée).
- sinon `PROVIDER_RESULT_UNCERTAIN`.

#### État final exact après finalisation

Après exécution du finalizer (scénario 1 ou 2) :

- `notification_deliveries.status` → `REQUIRES_MANUAL_REVIEW` ;
- `notification_deliveries.failure_code` :
  - `EMAIL_RETRY_WINDOW_EXPIRED` prioritaire si cutoff atteint (âge >= 23 h) ;
  - sinon `PROVIDER_RESULT_UNCERTAIN` ;
- `notification_deliveries.provider_message_id` → `NULL` (inchangé) ;
- `notification_deliveries.sent_at` → `NULL` (inchangé) ;
- `outbox_events.status` → `PENDING` ;
- `outbox_events.lease_token` → `NULL` ;
- `outbox_events.lease_until` → `NULL` ;
- `outbox_events.processed_at` → `NULL` (inchangé) ;
- `outbox_effects.status` (`SEND_EMAIL`) → `PENDING` (inchangé) ;
- **aucun compteur incrémenté** (ni `outbox_events.attempt_count`, ni
  `outbox_effects.attempt_count`) ;
- **aucun appel fournisseur** ;
- le filtre du claim exclut ensuite la delivery grâce à son statut
  `REQUIRES_MANUAL_REVIEW` (filtre `NOT EXISTS` sur
  `notification_deliveries.status`).

#### Ordre d'exécution obligatoire dans le cycle worker/sweeper

Le finalizer s'exécute **obligatoirement avant** le claim normal des emails dans
chaque cycle worker/sweeper. Le claim normal ne doit **jamais** précéder le
finalizer dans un cycle. Un événement au cutoff ou ayant épuisé son budget email
doit être finalisé **sans appel Resend** avant que le claim normal ne puisse le
sélectionner.

Le finalizer est un helper indépendant (`apps/worker/src/finalizer.ts`) qui :

- sélectionne les candidats éligibles (états statut/lease cohérents + conditions
  communes ci-dessus) ;
- verrouille dans l'ordre `outbox_events` → `outbox_effects` →
  `notification_deliveries` avec `FOR UPDATE SKIP LOCKED` sur `outbox_events`
  puis `FOR UPDATE` sur les dépendances ;
- revalide sous verrou (statut, leases, notification, effet, cutoff, compteur) ;
- applique la transition atomique vers `REQUIRES_MANUAL_REVIEW` avec l'état final
  exact ci-dessus ;
- ne mute rien si la lease est encore valide (cas 30, §13.6) ;
- un seul finalizer gagne en cas de concurrence (cas 34, §13.6) ;
- toute combinaison statut/lease incohérente est ignorée fail-closed avec
  log/métrique nettoyé (cas 31, §13.6).

**Invariant absolu (cas 35, §13.6)** : aucune 6e requête fournisseur n'est jamais
effectuée.
