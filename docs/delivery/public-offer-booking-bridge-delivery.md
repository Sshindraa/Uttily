# Rapport de livraison — Pont Recherche Publique → Booking Checkout (G7E / Pont Checkout)

## 1. Contexte et Objectif Produit

Ce lot établit et durcit le pont transactionnel direct entre le moteur de recherche publique Uttily et le tunnel de réservation/checkout initial :

```
Recherche publique (/[locale]/search)
  └──> Consultation de l'offre (/[locale]/offers/[publicProductId]/[publicLocationId])
         └──> Configuration du créneau (DAY_RANGE ou TIME_RANGE) et de la variante
                └──> Server Action d'autorité (createBookingDraftAction)
                       └──> Création atomique du booking draft avec hold temporaire (10 min)
                              └──> Redirection vers le checkout (/checkout/[draftId])
```

---

## 2. Durcissement de l'Architecture et de la Sécurité

### 2.1 Identité publique des variantes (`publicVariantId` & Migration 0038)
- **Schéma & Migration** : `0038_product_variants_public_id.sql` ajoute la colonne `public_id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid()` sur la table `product_variants`.
- **Trigger d'immutabilité** : `prevent_product_variants_public_id_mutation` interdit toute modification ou nullification de `public_id`.
- **Zéro fuite interne** : Aucun identifiant primaire interne (`product_variants.id`), SKU suffix ou attribut JSON n'est exposé au navigateur, aux balises HTML, aux attributs `value`/`id` ou aux query parameters.

### 2.2 Réduction du Read Model Public (`PublicOfferVariant`)
- Le contrat public `PublicOfferVariant` est restreint à :
  ```typescript
  export interface PublicOfferVariant {
    publicVariantId: string;
    name: string;
  }
  ```
- Suppression de l'affichage de prix journalier unitaire sur les variantes : la fiche publique précise explicitement que le montant contractuel exact est validé au checkout avant tout paiement.

### 2.3 Résolveur d'Autorité Côté Serveur (`resolvePublicBookingAuthority`)
- Un résolveur partagé applique strictement les mêmes règles d'éligibilité pour la réservation que pour la consultation publique :
  1. Produit en statut `PUBLISHED` et non supprimé (`deletedAt IS NULL`).
  2. Organisation non supprimée.
  3. Établissement publiquement listé (`isPubliclyListed = true`), retrait activé (`pickupEnabled = true`) et non supprimé.
  4. Pays de l'établissement actif (`countries.isActive = true`).
  5. Stricte cohérence multi-tenant : produit, établissement et variante appartiennent à la même organisation.
  6. Variante active et non supprimée.
  7. Gating photo PostgreSQL réel (`PostgresPhotoPublicationGate` : minimum 3 photos valides).

### 2.4 Idempotence Déterministe et Assainissement des Messages
- **Empreinte métier pure** : `computeBookingFormFingerprint` et `getOrCreateIdempotencyKey` stabilisent la clé d'idempotence via `useRef`. Une nouvelle clé n'est générée que si les paramètres métier du formulaire changent réellement.
- **Messages fermés** : `mapBookingDraftError` convertit tous les codes d'erreur Core en messages utilisateur sûrs (FR et EN). Aucun nom de table SQL, secret ou UUID interne n'est divulgué.

---

## 3. Matrice des Preuves de Tests

### 3.1 Base de données & Migration (`@uttily/database`)
- `src/schema-product-variants-public-id.test.ts` : **4/4 tests PostgreSQL passés**
  - Application de la migration 0038 après les 37 migrations antérieures.
  - Génération automatique d'UUIDs publics uniques et distincts des IDs internes.
  - Rejet des mutations de `public_id` par le trigger d'immutabilité.
  - Upgrade réel 0037 → 0038 avec backfill des variantes existantes, vérification du hash Drizzle et idempotence du rejeu.

### 3.2 Core (`@uttily/core`)
- `src/public-search/get-public-offer-details.test.ts` : **4/4 tests unitaires passés**
- `src/public-search/get-public-offer-details.integration.test.ts` : **13/13 tests PostgreSQL passés**
  - Test de sentinelles : prouve l'absence absolue de tout ID interne, SKU suffix ou attribut JSON dans le read model.
  - Couverture exhaustive des gardes d'éligibilité (tenant isolation, publication, suppression, pays inactif, photos).
- `src/public-search/resolve-public-booking-authority.test.ts` : **4/4 tests unitaires passés**
- `src/public-search/resolve-public-booking-authority.integration.test.ts` : **10/10 tests PostgreSQL passés**
  - Résolution autoritaire nominale et rejets fail-closed.

### 3.3 Application Web (`@uttily/web`)
- `src/app/actions/bookings.test.ts` : **6/6 tests unitaires passés**
  - Validation des entrées, authentification, résolution d'autorité, assainissement des messages et sentinelles d'erreur.
- `src/app/actions/bookings.integration.test.ts` : **4/4 tests PostgreSQL passés**
  - Happy path avec création de draft `HELD` et hold temporaire.
  - Concurrence réelle déterministe : 2 utilisateurs distincts tentent le même dernier exemplaire simultanément (`mockResolvedValueOnce`) → 1 succès, 1 `CONFLICT_BLOCK`, exactement 1 hold/draft en base.
  - Idempotence : rejeu de clé sans duplication de hold.
  - Gardes d'éligibilité cohérentes.
- `src/app/[locale]/offers/[publicProductId]/[publicLocationId]/offer-page.test.tsx` : **7/7 tests SSR passés**
  - Rendu SSR FR et EN.
  - Sentinelles SSR : aucune présence d'ID interne ou de secret dans le balisage HTML.
  - Tests des fonctions pures d'idempotence (`computeBookingFormFingerprint`, `getOrCreateIdempotencyKey`).
- **Suite globale Web** : **429/429 tests passés** (27 fichiers de test).
- **Contrôles qualité globaux** :
  - `pnpm typecheck` : 0 erreur (8 projets).
  - `pnpm lint` : 0 avertissement / 0 erreur.
  - `pnpm build` : compilation Next.js Turbopack réussie.

---

## 4. Statut du Backlog

Le pont de réservation publique vers le checkout initial est entièrement durci et vérifié.
Le lot **G7I** (Validation transversale globale du Lot 7) reste en cours d'exécution.
