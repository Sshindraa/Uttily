# ADR-011 — Machine à états pure des bookings

- **Statut** : accepté
- **Date** : 2026-08-03
- **Périmètre** : Lot 6 — Groupe G1, machine à états pure des bookings
- **Dépendances** : ADR-003, ADR-010

## 1. Contexte

L'ADR-010 §10 établit qu'un `booking` est créé à `CONFIRMED` par le webhook de
paiement `payment_intent.succeeded`, dans la transaction atomique de conversion
du brouillon. L'enum PostgreSQL `booking_status`
(`packages/database/src/schema.ts`) définit sept statuts pour les bookings :

```text
CONFIRMED, READY_FOR_PICKUP, ACTIVE, RETURNED, CLOSED, CANCELLED, REFUNDED
```

Les statuts `DRAFT`, `HELD`, `PAYMENT_PROCESSING` et `EXPIRED` appartiennent à
`booking_drafts` et ne sont **pas** couverts par cet ADR.

La documentation `docs/architecture/booking-and-availability.md` documente le
flux nominal d'un booking :

```text
CONFIRMED → READY_FOR_PICKUP → ACTIVE → RETURNED → CLOSED
CONFIRMED → CANCELLED
CONFIRMED → REFUNDED
```

Aucune logique de transition n'existe aujourd'hui pour ces statuts. Le Lot 6
introduit le fulfilment opérationnel (préparation, remise, réception, clôture)
et doit s'appuyer sur une machine à états explicite, vérifiable et testable,
avant d'implémenter les use cases qui persisteront les transitions.

## 2. Décision

Le Lot 6 groupe G1 introduit une fonction pure
`projectBookingStatus(currentStatus, requestedStatus)` qui calcule le résultat
d'une transition demandée. Elle ne lit ni n'écrit aucune donnée, n'appelle
aucun service externe, et ne provoque aucune connexion PostgreSQL, lecture de
variable d'environnement ou effet de bord. La source de vérité des statuts est
l'enum Drizzle `bookingStatus.enumValues` (packages/database/src/schema.ts),
importée comme description de schéma versionnée : cet import n'ouvre aucune
connexion et ne dépend ni de Stripe, ni de l'authentification, ni de Next.js.

### Tableau des transitions autorisées

| Depuis | Vers (autorisées) |
| --- | --- |
| `CONFIRMED` | `READY_FOR_PICKUP`, `CANCELLED`, `REFUNDED` |
| `READY_FOR_PICKUP` | `ACTIVE` |
| `ACTIVE` | `RETURNED` |
| `RETURNED` | `CLOSED` |
| `CLOSED` | (aucune) |
| `CANCELLED` | (aucune) |
| `REFUNDED` | (aucune) |

### Flux nominal (4 transitions)

- `CONFIRMED → READY_FOR_PICKUP`
- `READY_FOR_PICKUP → ACTIVE`
- `ACTIVE → RETURNED`
- `RETURNED → CLOSED`

### Transitions terminales (2 transitions)

- `CONFIRMED → CANCELLED`
- `CONFIRMED → REFUNDED`

`CLOSED`, `CANCELLED` et `REFUNDED` sont des états terminaux : aucune transition
sortante n'est autorisée.

## 3. Idempotence

Une transition demandée vers le statut courant produit un résultat explicite
`{ kind: 'NOOP'; currentStatus }`. Aucune écriture, aucun événement d'outbox et
aucun audit ne devront être produits par les futurs use cases lorsqu'une
transition est `NOOP`. Les use cases devront propager ce résultat sans lever
d'erreur afin de rester idempotents sous rejeu.

## 4. Transitions refusées

Toute transition non listée au tableau ci-dessus est refusée et lève une
`BookingTransitionError` typée. Deux codes d'erreur fermés :

- `TERMINAL_STATE` : `currentStatus` est `CLOSED`, `CANCELLED` ou `REFUNDED`
  (aucune transition sortante possible, quelle que soit la destination).
- `INVALID_TRANSITION` : tout autre cas refusé.

Sont notamment refusées :

- **Saut d'étape** : `CONFIRMED → ACTIVE`, `CONFIRMED → RETURNED`,
  `CONFIRMED → CLOSED`, `READY_FOR_PICKUP → RETURNED`,
  `READY_FOR_PICKUP → CLOSED`, `ACTIVE → CLOSED`.
- **Régression** : `ACTIVE → READY_FOR_PICKUP`, `ACTIVE → CONFIRMED`,
  `RETURNED → ACTIVE`, `RETURNED → READY_FOR_PICKUP`, `CLOSED → RETURNED`.
- **Sortie depuis un état terminal** : toute transition depuis `CLOSED`,
  `CANCELLED` ou `REFUNDED` → `TERMINAL_STATE`.
- **`READY_FOR_PICKUP → CANCELLED`** : refusée tant qu'aucune décision produit
  ne l'autorise. L'annulation après préparation est une question ouverte (voir
  `docs/implementation/open-questions.md`).
- **`ACTIVE → REFUNDED`, `RETURNED → REFUNDED`, `CLOSED → REFUNDED`** :
  refusées tant qu'aucune décision métier ne définit les statuts opérationnels
  pouvant passer à `REFUNDED`. `CLOSED → REFUNDED` lève `TERMINAL_STATE` (état
  terminal) ; les autres lèvent `INVALID_TRANSITION`.

## 5. Périmètre de G1

G1 livre **uniquement** la machine à états pure : types, erreurs, fonction de
projection et tests unitaires. Sont explicitement reportés aux futurs groupes
et use cases :

- autorisations et rôles des opérations terrain ;
- transactions PostgreSQL et persistance des transitions ;
- clés d'idempotence des use cases de fulfilment ;
- écriture d'audit et événements d'outbox ;
- génération de documents transactionnels ;
- intégration Stripe pour les remboursements ;
- rôle `FULFILLMENT_OPERATORS` et codes `ActionErrorCode` web.

La machine pure ne gère aucun rôle, aucune persistance et aucun effet de bord.

## 6. Règles produit encore ouvertes

Les règles produit suivantes ne sont pas tranchées par cet ADR et doivent être
résolues avant les use cases du Lot 6. Elles sont documentées dans
`docs/implementation/open-questions.md` :

- rôles autorisés pour les opérations terrain ;
- annulation autorisée après `READY_FOR_PICKUP` ;
- statuts opérationnels pouvant passer à `REFUNDED` ;
- relation exacte entre `CANCELLED` et `REFUNDED` ;
- traitement du no-show (client ne se présente pas au retrait).

Tant que ces questions sont ouvertes, la machine reste la plus stricte possible
et n'autorise que les transitions établies par `booking-and-availability.md`.

## 7. Note sur audit_log

La table `audit_log` est append-only par convention applicative. Aucun trigger
PostgreSQL n'empêche actuellement `UPDATE` ou `DELETE` sur ses lignes. La
question du renforcement de cet invariant en base (trigger bloquant
`UPDATE`/`DELETE`) est ouverte et documentée dans
`docs/implementation/open-questions.md`. Elle sera traitée dans un groupe
ultérieur et ne bloque pas G1.

## 8. Autorisation MVP et transaction G3A

### Rôles autorisés

**Décision MVP (G3A, 2026-08-03)** : tous les membres actifs de l'organisation
sont autorisés à exécuter les opérations terrain fulfillment :

- `OWNER`
- `ADMIN`
- `MANAGER`
- `STAFF`

La constante `FULFILLMENT_OPERATORS` est définie dans
`packages/core/src/fulfillment/operators.ts`. La vérification de membership
ACTIVE se fait côté serveur dans chaque use case, dans la transaction
principale, après verrouillage du booking.

Un utilisateur sans membership, avec membership non ACTIVE (`SUSPENDED` ou
`REMOVED`), ou appartenant à une autre organisation, est refusé sans aucune
mutation.

### Transaction G3A

Les use cases `prepareBooking`, `pickupBooking`, `returnBooking` et
`closeBooking` implémentent une transaction atomique unique comprenant :

1. verrouillage de la clé idempotente (`lockKey`)
2. verrouillage advisory de l'organisation (`lockOrganization`)
3. chargement et verrouillage du booking (`SELECT FOR UPDATE`)
4. vérification de l'organisation et du membership ACTIVE
5. projection de la transition (`projectBookingStatus`)
6. si APPLIED : mise à jour du booking, insertion de
   `booking_fulfillment_events`, écriture `audit_log`, insertion
   `outbox_events`, terminaison idempotente COMPLETED
7. si NOOP : terminaison idempotente COMPLETED sans événement

L'ordre des verrous (idempotency → organization → booking) est cohérent avec
les patterns des Lots 4 et 5 et évite les deadlocks.

## 9. G4A — Frontière Web sécurisée (LIVRÉ)

**Server Actions** : 6 actions livrées dans `apps/web/src/app/actions/fulfillment.ts` :

- `prepareBookingAction`, `pickupBookingAction`, `returnBookingAction`, `closeBookingAction`
- `createConditionReportAction`, `createDamageReportAction`

**Helper Web** : `requireFulfillmentOperatorOf` dans `apps/web/src/lib/fulfillment-auth.ts`. Defense in depth : vérifie l'authentification et la membership côté web, les use cases Core refont le contrôle dans la transaction.

**Read models** : `listOperationalBookings` et `getOperationalBookingDetails` dans `packages/core/src/fulfillment/read-models.ts`. Aucun champ financier, Stripe, terms snapshot ou payload JSON exposé. L'email du client n'apparaît que sur la fiche détaillée (nécessaire au retrait). Filtre `organization_id` obligatoire. Pas de N+1.

**Idempotence à la frontière Web** : la clé vient du FormData mais est validée/trimée. Aucune clé générée automatiquement côté serveur. Même soumission peut réutiliser la même clé. Aucune clé ou fingerprint dans les messages utilisateur.

**Revalidation** : `revalidatePath` appelée uniquement après succès (`/dashboard/{orgId}/operations` et `/dashboard/{orgId}/operations/{bookingId}`).

### 10. G4B — Interface dashboard des opérations terrain (LIVRÉ)

**Routes** :
- `/dashboard/[orgId]/operations` — liste des réservations opérationnelles
- `/dashboard/[orgId]/operations/[bookingId]` — fiche détaillée

**Navigation** : lien « Opérations » ajouté dans le layout du dashboard, visible pour OWNER, ADMIN, MANAGER et STAFF actifs.

**Page liste** (Server Component) :
- Authentification via `requireFulfillmentOperatorOf`
- Chargement via `listOperationalBookings` (aucun champ financier)
- Filtres rapides par statut (Toutes, À préparer, Prêtes au retrait, En cours, À réceptionner, Clôturées)
- Filtre `searchParams.status` validé contre `BOOKING_STATUSES`
- Dates formatées dans le fuseau du lieu (`locationTimeZone`)
- Aucune information client dans la liste

**Page détail** (Server Component) :
- Validation UUID du paramètre `bookingId` avant toute query
- `getOperationalBookingDetails` avec `organizationId`
- `null`/cross-org → `notFound()` (pas de fuite d'existence)
- Email client affiché uniquement sur cette page autorisée
- Timeline fulfillment chronologique
- Rapports d'état et dommages groupés par booking_item

**Actions de transition** (Client Component) :
- Bouton selon le statut : CONFIRMED → préparer, READY_FOR_PICKUP → remise, ACTIVE → réception, RETURNED → clôture
- Statuts terminaux (CLOSED, CANCELLED, REFUNDED) → lecture seule, aucun bouton
- `useActionState` avec Server Action bindée par `organizationId`
- `idempotencyKey` générée côté Server Component (`crypto.randomUUID()`), champ hidden
- `router.refresh()` après succès pour mettre à jour le statut
- Texte d'aide clair avant chaque transition irréversible

**Rapports d'état** (Client Component) :
- PICKUP : visible uniquement si `status === READY_FOR_PICKUP`
- RETURN : visible uniquement si `status === ACTIVE`
- Phase imposée par le contexte (champ hidden, pas modifiable)
- `inventoryItemId` jamais demandé au navigateur

**Dommages** (Client Component) :
- Visible uniquement si `status === ACTIVE` ou `status === RETURNED`
- Description obligatoire (max 5000), aucun champ gravité/responsabilité/montant/photo
- Texte explicite : « Cette déclaration enregistre le dommage sans modifier automatiquement l'état de l'exemplaire ni créer une maintenance. »

**Sérialisation** : les read models (avec `Date` natives) restent côté Server Components. Les Client Components ne reçoivent que les identifiants, enums et libellés nécessaires aux formulaires. Aucune donnée personnelle, financière ou historique non nécessaire n'est passée aux Client Components.

**Accessibilité** :
- Mobile-first dès 320 px
- `aria-live="polite"` pour les résultats d'action
- `role="alert"` pour les erreurs
- `aria-describedby` pour aides et erreurs de champs
- État actif des filtres identifiable autrement que par la couleur (icône + `aria-current`)
- Focus visible, ordre de tabulation logique
- Statut jamais communiqué uniquement par couleur (libellé textuel)
- Pas de `dangerouslySetInnerHTML`
