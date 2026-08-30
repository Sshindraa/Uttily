# Doctrine Produit — Expérience Loueur & Fiche Vélo Unifiée

> **Règle fondamentale :**  
> *Une profondeur technique d'URL ou de modèle relationnel n'implique jamais une profondeur d'expérience utilisateur.*

Ce document définit la vision produit et l'arborescence UX d'Uttily Pro. Il fixe la séparation claire entre la **rigueur du modèle relationnel PostgreSQL** (la vérité transactionnelle) et le **modèle mental fluide du loueur professionnel** (l'expérience utilisateur).

---

## 1. Core Relationnel vs Expérience Utilisateur

Dans Uttily, la base de données PostgreSQL garantit l'intégrité transactionnelle, l'anti-surbooking et l'immutabilité financière :

```
┌─────────────────────────────────────────────────────────────────────────────┐
│              RÉALITÉ DU MODÈLE TRANSACTIONNEL (PostgreSQL & Core)           │
│                                                                             │
│  Organization ──► Location (PostGIS / Horaires / Retrait)                   │
│         │                                                                   │
│         └──► Product (Nom, Description, Catégorie)                          │
│                 │                                                           │
│                 └──► ProductVariant (Taille, SKU)                           │
│                         ├──► ProductPhoto[] (Checksum SHA-256, 3 vues)      │
│                         ├──► PricingPlan[] (DAILY, EUR, Immutable, Tiers)   │
│                         └──► InventoryItem[] (Numéro série, Disponibilité)  │
└─────────────────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼  (Projection & Composition UX)
┌─────────────────────────────────────────────────────────────────────────────┐
│                    MODÈLE MENTAL DU LOUEUR PROFESSIONNEL                    │
│                                                                             │
│                 « Mes Vélos » ──► « Canyon Roadlite M »                     │
│                                          ├── 📸 3 photos guidées            │
│                                          ├── 🏷️ 25 € / jour                │
│                                          └── 🔢 3 vélos disponibles         │
└─────────────────────────────────────────────────────────────────────────────┘
```

Le loueur ne doit jamais avoir l'impression de manipuler un ERP relationnel à travers 4 pages successives (`/catalog` $\to$ `/[productId]` $\to$ `/variants/[variantId]` $\to$ `/pricing`). L'interface doit au contraire lui présenter une entité concrète et unifiée : **le vélo qu'il propose à la location**.

---

## 2. Les Deux Mondes dès l'Accueil

Dès la racine `/`, Uttily distingue explicitement deux publics aux intentions totalement différentes :

```text
/
│
├── 🛒 LOCATAIRE / GRAND PUBLIC
│   │
│   └── /[locale]/search
│       │
│       ├── Recherche géolocalisée (PostGIS, rayon dynamique)
│       │
│       └── /[locale]/offers/[publicProductId]/[publicLocationId]
│           │
│           ├── Fiche publique de l'offre (Photos 3 vues, tarif, horaires)
│           │
│           └── /checkout/...
│               └── Réservation temps réel avec hold et séquestre Stripe
│
│
└── 💼 LOUEUR / PROFESSIONNEL
    │
    ├── /sign-in (Clerk / OIDC)
    │
    └── /dashboard
        │
        └── /dashboard/[orgId]  (Uttily Pro — Espace d'administration)
```

---

## 3. Arborescence UX Cible du Dashboard Pro

Pour sortir de la logique technique « par table » et épouser le quotidien d'un magasin de location, l'arborescence cible s'articule autour des verbes et concepts métiers :

```text
Uttily Pro

🏠 Accueil (Tableau de bord)
│   ├── Vue d'ensemble de l'activité
│   ├── Jauge de Readiness (Onboarding 7/7)
│   └── Actions prioritaires du jour
│
🚲 Mes Vélos (Offres & Catalogue)
│   ├── Liste des vélos (Actifs, Brouillons, En révision)
│   ├── Ajouter un vélo (Création fluide en un flux)
│   └── Fiche Vélo Unifiée (Identité, Photos, Prix, Flotte)
│
📅 Réservations (Opérations)
│   ├── Départs du jour (Check-in & État des lieux)
│   ├── Retours du jour (Check-out & Signalement casse)
│   ├── En cours
│   └── Historique & Avenants
│
🔧 Flotte & Disponibilité
│   ├── Alertes matérielles & maintenance
│   ├── Vélos indisponibles / en réparation
│   └── Transferts entre magasins
│
📍 Établissements
│   ├── Boutiques physiques & points de retrait
│   ├── Horaires d'ouverture & jours fériés
│   └── Coordonnées GPS & accès
│
💰 Finances & Virements
│   ├── Solde disponible & prochains virements
│   ├── Compte Stripe Connect
│   └── Historique des transactions
│
👥 Équipe & Rôles
│   ├── Membres (Propriétaire, Gérant, Équipe terrain)
│   └── Invitations en attente
│
⚙️ Paramètres
    ├── Raison sociale & informations juridiques
    └── Devises & préférences
```

---

## 4. La Fiche Vélo Unifiée : Définition & Composition

> **Important :** La *Fiche Vélo Unifiée* n'est **en aucun cas une nouvelle table en base de données**.  
> C'est une **projection UX / Read-Model composite** qui agrège les domaines existants pour simplifier l'édition.

La Fiche Vélo Unifiée regroupe sur un seul écran ou dans un flux sans couture les 4 piliers de l'offre :

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                              FICHE VÉLO UNIFIÉE                             │
│                                                                             │
│  1. IDENTITÉ & MODÈLE                                                       │
│     Nom commercial, marque, catégorie, taille du cadre, description.        │
│                                                                             │
│  2. STANDARD PHOTO (Photo Coach)                                            │
│     Les 3 vues normées : Profil Hero, 3/4 Avant, Vue libre valorisante.     │
│                                                                             │
│  3. GRILLE TARIFAIRE (Pricing)                                              │
│     Prix de base à la journée (ex: 25,00 €) + réductions 3j / 7j / 14j.     │
│                                                                             │
│  4. FLOTTE PHYSIQUE DISPONIBLE (Inventory)                                  │
│     « Combien d'exemplaires identiques avez-vous ? [ − 3 + ] »              │
│     (Uttily crée sous le capot les 3 InventoryItems rattachés au magasin).  │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Invariants Métier Intangibles (Garanties Serveur)

L'expérience utilisateur peut être aussi fluide et synthétique que possible, elle ne doit **jamais contourner ni affaiblir les garanties d'architecture suivantes** :

1. **Isolation stricte par Tenant (`organizationId`)** : Toutes les écritures et lectures sont vérifiées côté serveur via l'appartenance de l'utilisateur (`requireMembership`).
2. **Exemplaires physiques unitaires (`InventoryItem`)** : Aucune réservation n'est créée sans allocation d'exemplaires physiques précis. Aucun concept de « stock flottant » approximatif.
3. **Publication fail-closed** : Un vélo ne devient visible dans la recherche publique que si l'établissement est publiable, le tarif est `ACTIVE`, $\ge 3$ photos valides sont présentes, et $\ge 1$ exemplaire physique est disponible.
4. **Immutabilité financière du prix (`PricingPlan`)** : Un tarif actif n'est jamais modifié par un `UPDATE` direct. Une nouvelle version est créée en brouillon (`DRAFT`) puis activée (`ACTIVE`), archivant l'ancienne en `RETIRED`.
5. **Standard de confiance Photo Coach** : Le Photo Coach guide les trois vues
   narratives et les photos sont validées techniquement puis dédupliquées par
   empreinte SHA-256 côté serveur. Le gate de publication actuel exige trois
   photos distinctes, mais ne vérifie pas encore la présence d’un slot de chaque
   type ; le badge « loueur professionnel vérifié » n’est pas encore exposé.
6. **Séquestre et Readiness Stripe** : Aucun encaissement réel n'est initié si le compte Stripe Connect n'est pas pleinement configuré (`charges_enabled = true`).

### 5.1. Séparation Stricte des 3 Niveaux de Readiness

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. BIKE PUBLICATION READINESS (Fiche Catalogue)                             │
│    Source unique : collectPublicationFailures(Batch)                        │
│    - Nom ≥ 2 car., description non vide                                     │
│    - Catégorie active & variante active                                     │
│    - Standard Photo : ≥ 3 photos valides (checksums SHA-256 distincts)      │
│      + slots narratifs persistés quand fournis (enforcement par slot à venir)│
│    (Aucun stock ni prix requis : un produit sans stock peut être publié)    │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. BIKE OFFER READINESS (Disponibilité de l'Offre)                          │
│    - Produit publié (PUBLISHED)                                             │
│    - Tarif journalier actif sur la variante                                 │
│    - Au moins 1 exemplaire physique actif (ACTIVE)                          │
│    => Statut Loueur : 🟢 En ligne · Disponible / 🔴 En ligne · Indisponible │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. DATE-SPECIFIC BOOKABILITY (Réservation Réelle Temporelle)                │
│    - Offre disponible                                                       │
│    - Établissement exploitable & Stripe Connect configuré                   │
│    - Disponibilité sur la plage horaire/dates demandée (anti-surbooking,     │
│      holds actifs, maintenances programmées)                                │
│    => Moteur de disponibilité publique / checkout                           │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Roadmap de Transition Produit

```text
┌─────────────────────────┐
│   G8B-3B1 Établissement │ (Livré le 2026-08-27)
│   Adresse, GPS, Horaires│
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│   G8B-3B2 Tarification  │ (Livré le 2026-08-27)
│   Prix / jour & Paliers │
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│   G8B-3B3 Readiness 7/7 │ (Livré le 2026-08-27)
│   Checklist Serveur Pro │
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│   Fiche Vélo Unifiée v1 │ (Livré le 2026-08-27)
│   Read-Model & Mes Vélos│
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│   Fiche Vélo Unifiée v2 │ ◄── PROCHAIN CHANTIER
│   Actions sur place     │ (Inline pricing, flotte − 3 +, photo coach intégré)
└────────────┬────────────┘
             ▼
┌─────────────────────────┐
│   Navigation Pro Cible  │
│   Dashboard Exploitation│
└─────────────────────────┘
```
