# Mobile readiness — fondations M0

**Statut :** contrat et documentation uniquement. Aucun endpoint mobile, aucune
migration et aucun moteur métier n’est ajouté dans M0.

## 1. Architecture cible

PostgreSQL + PostGIS reste l’autorité transactionnelle de disponibilité, des
holds, des réservations et des droits persistés. Les use cases du Core restent
communs : ils reçoivent un contexte serveur authentifié et ne sont pas copiés
dans les clients.

```text
Web Uttily ─────────────── Server Actions adapter ───────┐
                                                         ├── Core use cases ── PostgreSQL/PostGIS
Client mobile (futur) ─── /api/v1 adapter (M1) ──────────┤
Pro mobile (futur) ────── /api/v1 adapter (M1) ──────────┘
```

- Le Web appelle les use cases via l’adaptateur Server Actions existant.
- Le futur adaptateur `/api/v1` traduira HTTP/JSON/authentification vers les
  mêmes use cases ; il ne créera pas une seconde logique de réservation.
- Un client mobile ne parle jamais directement à PostgreSQL et n’appelle
  jamais une Server Action.
- Aucun choix Client ou Pro n’est arrêté en M0. Les usages du premier pilote
  (fréquence, terrain, photos, réseau et opérations de retrait/retour)
  décideront l’ordre de la thin slice.

M0 n’introduit ni microservice, ni API complète, ni chemin produit mobile.
`@uttily/contracts` porte uniquement les éléments indépendants du Web ; le
contrat peut donc être partagé sans importer Next.js.

## 2. Convention `/api/v1`

La convention est préparée pour M1. Aucun chemin `/api/v1` n’est implémenté par
M0.

| Sujet       | Convention                                                                                             | Règle de sécurité/compatibilité                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Version     | Préfixe `/api/v1` ; une breaking change nécessite `v2`                                                 | Pas de version implicite dans l’app mobile                                                                         |
| Succès      | `{ "ok": true, "data": ..., "requestId": "...", "replayed?": true }`                                   | `data` est le read model public, jamais une ligne DB ; `replayed: true` identifie le rejeu d’une réponse persistée |
| Erreur      | `{ "ok": false, "error": { "code", "retryable", "retryPolicy", "fieldErrors?" }, "requestId": "..." }` | Union fermée, sans détail technique                                                                                |
| Dates       | RFC 3339/ISO 8601 en UTC, suffixe `Z`                                                                  | Le fuseau du lieu est une donnée séparée, jamais une conversion implicite côté client                              |
| Argent      | `amountMinor` entier + `currency` ISO 4217 (`EUR`, etc.)                                               | Aucun nombre décimal flottant et aucune devise devinée                                                             |
| Locale      | `Accept-Language` puis locale serveur autorisée, format BCP 47                                         | Le serveur résout la locale ; le client ne choisit pas un texte métier libre                                       |
| Pagination  | `limit` borné + `cursor` opaque ; réponse `{ items, page: { nextCursor, hasMore } }`                   | Pas d’offset exposant une clé interne                                                                              |
| Traçabilité | `X-Request-Id` généré/validé côté serveur et renvoyé dans l’enveloppe                                  | Ne jamais accepter une valeur qui divulgue une information interne                                                 |
| Idempotence | `Idempotency-Key` obligatoire sur chaque mutation idempotente                                          | Même intention = même clé ; intention nouvelle = nouvelle clé                                                      |
| Auth        | `Authorization: Bearer <token>` quand l’adaptateur mobile sera activé                                  | Le token est validé côté serveur, jamais décodé comme autorité par l’app                                           |

Le format de succès reprend l’idée de `ActionResult` (union discriminée), sans
réutiliser le type Server Actions ni créer un couplage entre HTTP et le Web.
Les read models API ne doivent exposer ni UUID primaire interne, ni SQL, ni
enum DB brut, ni snapshot financier interne.

## 3. Inventaire des identifiants publics

L’inventaire est vérifié dans `packages/database/src/schema.ts` et les
migrations existantes. M0 ne lance aucun backfill et ne change pas le schéma.

| Ressource mobile           | Existant vérifié                                                                                                                                                                                                                                                | Décision M0                                                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Offre publique             | `products.public_id`, `product_variants.public_id` et `locations.public_id` sont présents, uniques et immuables par triggers. Les routes publiques actuelles utilisent les identifiants produit/lieu et le formulaire utilise l’identifiant public de variante. | **Disponible** pour un read model d’offre ; ne jamais exposer les IDs internes, SKU ou attributs JSON.                                                                                                  |
| Destination                | `destinations.public_id` est présent, unique et immuable.                                                                                                                                                                                                       | Disponible si nécessaire au catalogue mobile.                                                                                                                                                           |
| Organisation publique      | `organizations` possède un `slug` et un `public_display_name`, mais pas de `public_id`.                                                                                                                                                                         | Ne pas publier un `organizationId` interne. `MOBILE_API_DEPENDENCY` si une ressource organisation doit être adressée directement.                                                                       |
| Lieu                       | `locations.public_id` est présent et utilisé comme identifiant public de lieu.                                                                                                                                                                                  | Disponible, avec contrôle d’éligibilité et d’appartenance côté serveur.                                                                                                                                 |
| Booking confirmé           | `bookings` ne possède pas de `public_id` ; son UUID `id` est interne. `booking_drafts` est également interne.                                                                                                                                                   | `MOBILE_API_DEPENDENCY` pour `GET /bookings/:publicId` et tous les deep links booking. Migration dédiée seulement en M1 si nécessaire.                                                                  |
| Booking locataire          | Le read model `customer-bookings` est scoped par l’utilisateur mais repose encore sur l’ID interne du booking.                                                                                                                                                  | `MOBILE_API_DEPENDENCY` ; le serveur devra résoudre un public ID et vérifier que le booking appartient au locataire connecté.                                                                           |
| Invitation                 | `organization_invitations` possède `id` interne et `token_hash`, sans `public_id`. Le lien Web est signé et expirant.                                                                                                                                           | Ne pas transformer l’ID ou le hash en identifiant public. Deep link mobile seulement si le modèle conserve expiration, usage unique, révocation et protection contre la fuite. `MOBILE_API_DEPENDENCY`. |
| Exemplaire/asset Pro futur | `inventory_items` possède un UUID interne et un `internal_sku`, sans `public_id`.                                                                                                                                                                               | `MOBILE_API_DEPENDENCY` avant une API Pro qui adresse un asset. Ne pas exposer SKU ou UUID interne.                                                                                                     |
| Photo produit              | `product_photos.public_id` est présent ; l’URL publique passe par l’application et masque R2.                                                                                                                                                                   | Disponible pour les read models photo, sans exposer `storage_key`.                                                                                                                                      |

La règle est stricte : lorsqu’un identifiant public manque, M0 documente la
dépendance ; il ne réutilise jamais l’ID interne et n’ajoute pas une migration
automatique « au passage ». Une migration n’est envisageable qu’en M1 si elle
est triviale et effectivement nécessaire au slice choisi.

## 4. Authentification mobile

Le fournisseur d’identité actuel est **Clerk via OIDC** (ADR-006). Le Web
utilise `currentUser()` puis synchronise l’identité dans Uttily avec
`provisionUserFromOidc`. `@uttily/auth` n’expose pas encore d’adaptateur mobile
et aucune route Bearer mobile n’existe.

Design M1 :

- l’app reçoit un token/session Clerk selon le flux mobile officiellement
  configuré ; elle envoie `Authorization: Bearer` à l’API ;
- l’API vérifie signature, audience/issuer, expiration et état de révocation
  selon la configuration Clerk retenue ; l’identité est ensuite synchronisée
  côté serveur ;
- `userId` est toujours dérivé du token validé et de la base Uttily ; le client
  ne peut pas le fournir comme autorité ;
- `orgId` n’est jamais trusté depuis l’app. Une organisation Pro est résolue
  côté serveur et la membership active ainsi que le rôle (`OWNER`, `ADMIN`,
  `MANAGER`, `STAFF`) sont vérifiés pour chaque use case ;
- un locataire est autorisé par son identité et la propriété/visibilité du
  booking, sans membership Pro ; un utilisateur Pro est autorisé par sa
  membership Uttily ; ces deux scopes ne sont pas interchangeables ;
- expiration, rafraîchissement, logout et révocation restent ceux du provider
  validé par le serveur. Les durées, le stockage sécurisé du refresh token et
  la configuration de révocation sont une dépendance de configuration M1 ;
- aucun secret, refresh token durable, credential Clerk ou secret de provider
  n’est embarqué dans le binaire mobile.

**Statut : DEPENDENCY M1.** Le provider est connu, mais le flux mobile et sa
configuration ne sont pas encore validés ; il n’est donc pas honnête d’ouvrir
`/api/v1/me` en M0.

## 5. Idempotence et résilience réseau

Une clé d’idempotence est générée par le client au moment de l’intention
utilisateur. Elle reste stable pendant tous les retries de cette intention ;
une nouvelle intention reçoit une nouvelle clé. Le serveur lie la clé à
l’opération, à l’utilisateur/tenant autorisé et à une empreinte de requête.

- Un rejeu avec la même clé et la même empreinte retourne le résultat persistant
  avec `replayed: true` ; il ne recrée pas de réservation, hold, paiement ou
  photo.
- Une même clé avec une empreinte différente retourne
  `IDEMPOTENCY_CONFLICT` ; le client ne modifie pas la clé pour masquer ce
  conflit.
- Un timeout réseau ne permet jamais de deviner si une mutation a réussi. Le
  client recharge l’état ou rejoue avec la même clé selon la politique ; il ne
  crée pas une nouvelle clé automatiquement.
- M0 ne modifie ni les moteurs booking/payment, ni les holds, ni les webhooks.
  Les règles ci-dessous sont le contrat de transport futur.

| Situation                                                                | Politique                         |
| ------------------------------------------------------------------------ | --------------------------------- |
| GET sans effet de bord, timeout ou erreur réseau                         | `RETRY_SAFE`, avec backoff borné  |
| Mutation idempotente interrompue, résultat inconnu                       | `RETRY_WITH_SAME_IDEMPOTENCY_KEY` |
| Erreur d’autorisation, validation ou conflit de clé                      | `DO_NOT_RETRY`                    |
| État métier devenu obsolète (hold expiré, disponibilité, conflit d’état) | `REFRESH_STATE_BEFORE_RETRY`      |

Le mapping fermé est exporté par `@uttily/contracts/src/mobile-api.ts` et
couvre également `retryable`. `INTERNAL_ERROR` est rejouable avec la même clé
lorsqu’il s’agit d’une mutation idempotente ; un GET reste traité comme une
opération safe par son adaptateur.

## 6. Union d’erreurs publique

Les codes minimaux sont fermés :

`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `CONFLICT`,
`IDEMPOTENCY_CONFLICT`, `HOLD_EXPIRED`, `INSUFFICIENT_AVAILABILITY`,
`PAYMENT_ACTION_REQUIRED`, `PAYMENT_PENDING`, `RATE_LIMITED`,
`INTERNAL_ERROR`.

Chaque erreur contient au minimum `code`, `retryable` et `retryPolicy`, plus
éventuellement `fieldErrors` pour une validation utilisateur. Elle ne contient
jamais SQL, stack trace, nom de table/colonne, objet Stripe brut, nom de
provider interne, UUID interne ou enum technique.

Le mapping M0 est :

| Code                                                                                                               | Retryable | Politique                                                         |
| ------------------------------------------------------------------------------------------------------------------ | --------: | ----------------------------------------------------------------- |
| `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `VALIDATION_ERROR`, `IDEMPOTENCY_CONFLICT`, `PAYMENT_ACTION_REQUIRED` |       non | `DO_NOT_RETRY`                                                    |
| `CONFLICT`, `HOLD_EXPIRED`, `INSUFFICIENT_AVAILABILITY`                                                            |       non | `REFRESH_STATE_BEFORE_RETRY`                                      |
| `PAYMENT_PENDING`                                                                                                  |       oui | `REFRESH_STATE_BEFORE_RETRY`                                      |
| `RATE_LIMITED`                                                                                                     |       oui | `RETRY_SAFE` après backoff et respect de `Retry-After` si présent |
| `INTERNAL_ERROR`                                                                                                   |       oui | `RETRY_WITH_SAME_IDEMPOTENCY_KEY` pour une mutation idempotente   |

Un statut HTTP futur sera mappé par l’adaptateur sans modifier cette union.

## 7. Deep links futurs

Les liens utiliseront des **Universal Links iOS** et **App Links Android**, avec
une URL HTTPS canonique et fallback Web. Les familles réservées sont :

- invitation d’équipe ;
- contexte de paiement/retour vers une réservation ;
- consultation d’une réservation ;
- retrait (`pickup`) ;
- restitution (`return`).

Les chemins emploieront les identifiants publics, jamais une clé interne. Aucun
deep link ne doit contenir de secret, de `client_secret` Stripe, de token de
longue durée ou de données personnelles sensibles. Une invitation mobile n’est
autorisée que si le token reste court, expirant, à usage unique, révocable et
lié à l’email/au compte après authentification ; sinon le fallback Web reste la
seule option. L’ouverture d’un lien recharge toujours l’état serveur avant
d’afficher ou de reprendre une action.

## 8. Push notifications — modèle uniquement

Le push est un signal de réveil, jamais une source de vérité. À l’ouverture,
le client ou le dashboard Pro recharge le booking et ses droits depuis le
serveur ; un push perdu, retardé ou dupliqué ne doit pas casser le workflow.

Exemples de futurs événements :

- Client : `booking.confirmed`, `booking.ready_for_pickup`,
  `booking.return_due`, `booking.status_changed` ;
- Pro : `booking.pickup_due`, `booking.return_due`, `booking.photo_required`,
  `booking.updated`.

Les payloads contiennent un type, un identifiant d’événement dédupliquable, un
identifiant public de ressource et une action de rechargement. Ils n’emportent
ni PII sensible, ni montant, ni détail financier, ni credential. APNs, FCM,
l’enregistrement des appareils, la révocation d’un device et les préférences
de notification sont hors M0 ; ils feront l’objet d’une conception M1+.

## 9. Photos et upload mobile — design uniquement

Le Web actuel passe par une Server Action authentifiée : le serveur vérifie les
octets, le MIME, les dimensions et la taille, écrit dans le bucket R2 privé via
`ProductPhotoStorage`, persiste les métadonnées et expose une route applicative
contrôlée. Le navigateur ne reçoit aucun secret R2 et ne parle pas au bucket.

Le design mobile futur, sans choisir de nouvelle stack en M0, est :

```text
1. demander une autorisation d’upload
2. le serveur valide booking + organisation + action autorisée
3. le serveur renvoie une URL signée temporaire
4. l’app envoie directement l’objet au stockage privé
5. l’app confirme l’upload
6. le serveur revalide et persiste les métadonnées validées
```

Garde-fous obligatoires : allowlist MIME (JPEG/PNG/WebP selon la politique
actuelle), taille maximale, expiration courte de l’URL, ownership/tenant,
checksum si fourni par la politique existante, vérification du contenu réel,
suppression contrôlée, retry uploadable et confirmation idempotente. Une URL
signée n’autorise pas un autre booking, tenant ou slot.

La validation métier et l’interface `ProductPhotoStorage` sont les éléments à
réutiliser avec le Web ; le Web n’utilise pas encore le chemin signed URL. M1
devra donc ajouter un adaptateur d’autorisation/confirmation mobile au-dessus
de cette même politique, sans dupliquer les contrôles ni modifier le gate de
publication à trois photos. Aucun upload mobile n’est implémenté en M0.

## 10. Thin slice M1 à préparer

Après validation de l’auth et des IDs publics, les lectures candidates sont :

| Surface | Lecture future                                                         | Mutations                                            |
| ------- | ---------------------------------------------------------------------- | ---------------------------------------------------- |
| Client  | `GET /api/v1/me`, `GET /api/v1/bookings/:publicId`                     | Plus tard, après le slice lecture et ses tests       |
| Pro     | `GET /api/v1/pro/bookings/today`, `GET /api/v1/pro/bookings/:publicId` | Plus tard, après membership/roles et besoins terrain |

`GET /api/v1/me` reste seulement un contrat M0 : l’auth mobile n’est pas encore
proprement exposée et aucun endpoint n’est ajouté. Les quatre chemins sont donc
absents de l’OpenAPI des endpoints implémentés ; ils sont listés ici comme
objectif M1, pas comme promesse de disponibilité.

## 11. Gate M1 — Mobile API Thin Slice

M1 peut commencer seulement si :

1. le Chantier 20-D est fermé et la readiness technique est connue ;
2. le premier pilote a fourni des usages observés, ou le porteur a explicité
   une priorité Client/Pro ;
3. le choix Client vs Pro découle du besoin terrain et non d’une préférence
   d’implémentation ;
4. le flux mobile Clerk (Bearer/session, expiration, refresh, logout,
   révocation) est validé dans sa configuration réelle ;
5. les public IDs nécessaires sont disponibles et tenant-safe ;
6. le slice retenu possède ses read models, tests de contrat et tests de
   sécurité avant toute mutation.

Questions à poser sur le terrain :

- À quelle fréquence les retraits et les retours sont-ils opérés ?
- Les photos sont-elles nécessaires à chaque étape, et combien par booking ?
- Les opérateurs portent-ils des gants ou travaillent-ils en extérieur ?
- Quelle qualité de réseau et quels cas de perte/retour du réseau sont réels ?
- À quelle fréquence un loueur Pro ouvrirait-il une app dédiée ?
- Les clients répètent-ils une réservation ou utilisent-ils surtout des liens ?
- Quelle valeur concrète le push apporte-t-il par rapport à l’email/Web ?
- Quelles actions doivent rester possibles après une coupure réseau, sans
  faire croire qu’une réservation ou un paiement est confirmé ?

Ces réponses guideront le premier slice et le niveau d’effort offline, push,
photo et deep links. Elles ne justifient pas d’avance une modification des
moteurs disponibilité, réservation, paiement, webhook ou analytics.

## 12. Dépendances et périmètre

M0 ajoute le contrat fermé dans `@uttily/contracts`, ce document et une
spécification OpenAPI minimale des enveloppes communes. Il n’ajoute aucune
table, migration, route, app native, SDK généré, secret, configuration Clerk
mobile, APNs/FCM ou signed URL.

Les mutations critiques, paiements, webhooks, réconciliation, remboursements,
compensations, availability, holds, confirmation, anti-overbooking et gates
analytics restent inchangés et ne sont pas une dépendance à résoudre dans ce
chantier.
