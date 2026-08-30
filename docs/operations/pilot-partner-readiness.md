# Pilot partner readiness — dossier de collecte

**Référence de version :** document vivant ; vérifier le commit courant du dépôt
avant utilisation. Les anciennes baselines `origin/main = ...` sont historiques.
**Dernière revue de cohérence :** 2026-08-30
**Statut :** `READY_FOR_DATA_COLLECTION`
**Données réelles :** aucune

Ce dossier est un formulaire de préparation. Il ne contient aucun nom,
identifiant, SIRET, compte Stripe, contact, adresse ou donnée réelle de
partenaire. Tous les champs commencent à `NOT_PROVIDED`.

États autorisés :

- `NOT_PROVIDED` : aucune donnée reçue ;
- `PROVIDED` : donnée reçue du partenaire, vérification encore attendue ;
- `VERIFIED` : donnée vérifiée par l'owner approprié avec une preuve non sensible.

## Company

| Field | Status | Owner | Evidence / next action |
| --- | --- | --- | --- |
| Legal name | `NOT_PROVIDED` | Porteur produit + juridique | Demander la dénomination légale et la pièce source ; vérifier avant usage. |
| Legal form | `NOT_PROVIDED` | Juridique | Demander la forme juridique et la preuve correspondante. |
| SIRET / SIREN | `NOT_PROVIDED` | Juridique | Collecter hors dépôt public ; vérifier la cohérence avec l'entité. |
| VAT number | `NOT_PROVIDED` | Expert-comptable + juridique | Collecter le numéro applicable et vérifier son statut. |
| Headquarters address | `NOT_PROVIDED` | Juridique | Collecter l'adresse du siège et sa preuve. |
| Legal representative | `NOT_PROVIDED` | Juridique | Collecter identité/qualité du représentant par canal sécurisé ; ne pas déposer de justificatif inutile. |

## Operations

| Field | Status | Owner | Evidence / next action |
| --- | --- | --- | --- |
| Pickup location(s) | `NOT_PROVIDED` | Partner operator + produit | Fournir adresse, ville, pays, fuseau IANA et coordonnées ; vérifier la readiness location. |
| Opening hours | `NOT_PROVIDED` | Partner operator | Fournir les plages par jour et exceptions ; vérifier avant publication. |
| Number of bikes / physical units | `NOT_PROVIDED` | Partner operator | Fournir l'inventaire physique par établissement ; vérifier les exemplaires réellement disponibles. |
| Categories | `NOT_PROVIDED` | Partner operator + produit | Fournir les catégories autorisées et le mapping catalogue. |
| Sizes / variants | `NOT_PROVIDED` | Partner operator | Fournir les tailles/variantes et leur disponibilité réelle. |
| Prices | `NOT_PROVIDED` | Partner operator + finance | Fournir prix, devise, période et éventuels suppléments ; vérifier les snapshots de prix. |
| Pickup procedure | `NOT_PROVIDED` | Partner operator + produit | Décrire identification, horaires, état et remise du matériel. |
| Return procedure | `NOT_PROVIDED` | Partner operator + produit | Décrire lieu, délai, état, validation et traitement des retards. |
| Damages procedure | `NOT_PROVIDED` | Partner operator + juridique | Décrire constat, photos/rapport, délai de signalement et escalade ; ne pas inventer de barème. |

## Finance

| Field | Status | Owner | Evidence / next action |
| --- | --- | --- | --- |
| Stripe Connected Account LIVE | `NOT_PROVIDED` | Finance + partenaire | Fournir l'identifiant fonctionnel par canal sécurisé ; vérifier l'environnement LIVE côté serveur. |
| `charges_enabled` | `NOT_PROVIDED` | Finance + engineering | Vérifier la projection `organization_payment_accounts` via webhook/lecture serveur, jamais depuis l'UI seule. |
| `payouts_enabled` | `NOT_PROVIDED` | Finance + engineering | Vérifier la projection provider et consigner seulement le statut. |
| Billing model | `NOT_PROVIDED` | Finance + expert-comptable | Décrire commission, règlement, facture/avoir et cadence ; ne pas assimiler payout et facture. |
| Tax status / invoice data | `NOT_PROVIDED` | Expert-comptable + juridique | Fournir les données fiscales vérifiées et les rattacher au pack finance. |

## Operations contacts and incidents

| Field | Status | Owner | Evidence / next action |
| --- | --- | --- | --- |
| Operations contact | `NOT_PROVIDED` | Partner operator | Fournir nom, canal et horaires d'astreinte par canal sécurisé. |
| Incident contact | `NOT_PROVIDED` | Partner operator + Uttily ops | Fournir canal, délai de réponse et pouvoir de décision. |
| Suspected overbooking | `NOT_PROVIDED` | Uttily ops + partner operator | Confirmer le contact et le protocole : arrêter la promesse, vérifier les allocations, escalader ; aucun contact fictif. |
| Refund request | `NOT_PROVIDED` | Finance + partner operator | Confirmer le canal d'escalade et les droits ; utiliser le flux refund officiel. |
| Bike unavailable | `NOT_PROVIDED` | Partner operator | Confirmer qui déclare l'indisponibilité, sous quel délai et avec quelle preuve. |

## Conditions de passage

Le dossier devient exploitable lorsque chaque champ utile est au minimum
`PROVIDED`, puis `VERIFIED` par son owner. `NOT_PROVIDED` ne doit pas être
remplacé par une valeur d'exemple. Les identifiants et secrets Stripe restent
hors dépôt et hors de ce document.
