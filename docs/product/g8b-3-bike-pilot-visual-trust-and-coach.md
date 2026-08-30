# G8B-3 — Pilote Vélo Lyon, Confiance Publique & Spécification Photo Coach

- **Statut** : standard visuel vélo validé ; enforcement serveur livré ; badge professionnel restant
- **Date** : 2026-08-27
- **Périmètre** : Cadrage commercial Lyon (G8B-3A), Standard de confiance & vérité produit, Expérience & Moteur technique Photo Coach
- **Relie à** : ADR-002, ADR-010, ADR-014, ADR-017, ADR-020, ADR-026, G8B-1, G8B-3B, G8B-3B1, G8B-3B4, `docs/product/mvp-scope.md`, `docs/product/lot5-finance-legal-validation.md`

### État d’implémentation vérifié le 2026-08-30

Le contrat des slots (`BIKE_PHOTO_SLOTS`), la migration `0040` ajoutant
`product_photos.slot_type`, la persistance du slot, le Photo Coach du dashboard,
les overlays SVG, la checklist, la progression et le fallback caméra sont livrés
et testés. Le stockage et la livraison photo réelle sont couverts séparément par
G8B-1 et son smoke test staging.

L'enforcement serveur du standard sémantique est livré par l'ADR-031 : pour la
catégorie `bike`, le gate PostgreSQL, Core et la visibilité publique exigent les
trois slots canoniques `HERO_PROFILE`, `THREE_QUARTER_FRONT` et
`SECONDARY_VIEW`, en plus de trois checksums distincts. L’action serveur et
l’ancienne surface « Mes vélos » utilisent les noms canoniques. Le badge
« loueur professionnel vérifié » reste une spécification ; aucun statut de
vérification ni calcul auditable n’est encore implémenté. Aucune analyse
d’image par IA n’est activée.

---

## Sommaire

1. [Cadrage Commercial & Déploiement Pilote (Lyon)](#1-cadrage-commercial--déploiement-pilote-lyon)
   - 1.1 [Positionnement territorial](#11-positionnement-territorial)
   - 1.2 [Clientèle et usage initiaux](#12-clientèle-et-usage-initiaux)
   - 1.3 [Offre vélo pilote](#13-offre-vélo-pilote)
   - 1.4 [Modèle économique & proposition aux loueurs](#14-modèle-économique--proposition-aux-loueurs)
   - 1.5 [État réel et critères de passage au Go Pilote](#15-état-réel-et-critères-de-passage-au-go-pilote)
   - 1.6 [Découpage du lot G8B-3](#16-découpage-du-lot-g8b-3)
2. [Standard de Confiance Publique & Vérité Produit](#2-standard-de-confiance-publique--vérité-produit)
   - 2.1 [Invariant absolu : Représentation catalogue vs Constat d'exemplaire](#21-invariant-absolu--représentation-catalogue-vs-constat-dexemplaire)
   - 2.2 [Consignes de prise de vue et cycle de vie](#22-consignes-de-prise-de-vue-et-cycle-de-vie)
   - 2.3 [Badge « Loueur professionnel vérifié »](#23-badge-loueur-professionnel-vérifié)
   - 2.4 [Présentation d'équipe atelier et guides locaux](#24-présentation-déquipe-atelier-et-guides-locaux)
   - 2.5 [Tableau de vérité : Données réelles vs Affichages autorisés & interdits](#25-tableau-de-vérité--données-réelles-vs-affichages-autorisés--interdits)
3. [Le Standard Visuel par Slots Sémantiques](#3-le-standard-visuel-par-slots-sémantiques)
   - 3.1 [Slots obligatoires (tout vélo)](#31-slots-obligatoires-tout-vélo)
   - 3.2 [Slots complémentaires VAE (non bloquants)](#32-slots-complémentaires-vae-non-bloquants)
   - 3.3 [Contrat de données TypeScript (`BIKE_PHOTO_SLOTS`)](#33-contrat-de-données-typescript-bike_photo_slots)
4. [Spécification UX : Le Photo Coach Uttily](#4-spécification-ux--le-photo-coach-uttily)
   - 4.1 [Vision et principes fondateurs](#41-vision-et-principes-fondateurs)
   - 4.2 [La boucle utilisateur en 6 étapes](#42-la-boucle-utilisateur-en-6-étapes)
   - 4.3 [Animations vectorielles et overlays anatomiques par slot](#43-animations-vectorielles-et-overlays-anatomiques-par-slot)
   - 4.4 [Modes d'usage : Parcours Découverte vs Mode Rapide](#44-modes-dusage--parcours-découverte-vs-mode-rapide)
5. [Architecture Technique Frontend & Caméra](#5-architecture-technique-frontend--caméra)
   - 5.1 [Architecture en couches et Adapter UI](#51-architecture-en-couches-et-adapter-ui)
   - 5.2 [Intégration Caméra Web (`getUserMedia`) & Fallback](#52-intégration-caméra-web-getusermedia--fallback)
   - 5.3 [Échelons de maturité technique (Roadmap en 3 niveaux)](#53-échelons-de-maturité-technique-roadmap-en-3-niveaux)
6. [Séquencement d'Implémentation & Références](#6-séquencement-dimplémentation--références)

---

## 1. Cadrage Commercial & Déploiement Pilote (Lyon)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CADRAGE STRATÉGIQUE PILOTE LYON                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ Territoire        : France (échelle nationale) · Lyon (1re zone activée)    │
│ Clientèle cible   : Particuliers (résidents ou visiteurs) en location courte│
│ Matériel initial  : Vélos de ville & Vélos à assistance électrique (VAE)   │
│ Cible d'inventaire: 20 vélos physiquement réservables sur 2 loueurs pro     │
│ Modèle économique : 13 % loueur + 7 % client · 0 € fixe / mois             │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 1.1 Positionnement territorial

Uttily se présente comme un service disponible à l'échelle de la France et ne
code aucune règle métier spécifique à Lyon. Lyon est toutefois la première zone
commerciale activée et la première zone dans laquelle Uttily cherche à constituer
une offre réelle.

Une ville n'est pas présentée comme disponible tant qu'aucun loueur professionnel
et aucun exemplaire physique publiable n'y sont configurés. Une recherche sans
offre peut afficher l'absence de résultat et les alternatives géographiques déjà
prévues (10 / 25 / 50 km), mais ne collecte pas d'email et ne crée pas de liste
d'attente.

L'ouverture ultérieure d'une autre ville française est une simple activation de
données et d'offre, sans réécriture du produit.

### 1.2 Clientèle et usage initiaux

Le premier client cible est un **particulier ayant un besoin ponctuel de location**,
qu'il habite la région ou qu'il soit de passage. Le pilote ne distingue pas deux
produits séparés « touriste » et « habitant ».

Les abonnements client, les déplacements domicile-travail récurrents et les
réservations d'entreprise ou de flotte restent hors du pilote. Le parcours
nominal demeure :
1. Rechercher une période et un lieu ;
2. Réserver un équipement disponible auprès d'un seul loueur ;
3. Payer en ligne (hold temporaire + confirmation Stripe Connect) ;
4. Retirer l'exemplaire physique en établissement.

### 1.3 Offre vélo pilote

Les deux familles initiales sont :
- **Vélos de ville** (musculaires) ;
- **Vélos à assistance électrique (VAE)**.

Le VTT, le vélo de route et le vélo cargo ne sont pas nécessaires au Go initial.
Ils pourront être ajoutés comme catégories configurées lorsque l'offre partenaire,
les règles de sécurité, les accessoires et la politique de caution seront prêts.

La cible d'ouverture est de **20 vélos physiquement réservables**, répartis de
préférence entre **deux loueurs professionnels** (environ dix vélos par loueur,
sans imposer ce ratio comme contrainte bloquante pour une organisation individuelle).
Les trois photos conformes, le prix, les horaires, le lieu de retrait et chaque
exemplaire physique restent strictement obligatoires pour la publication.

### 1.4 Modèle économique & proposition aux loueurs

Le pilote ne facture **ni abonnement, ni frais fixe d'accès**, et n'impose **aucune
exclusivité** au loueur. PRODUCT DECISION : le modèle marketplace courant est
`split-13-7-v1` : frais plateforme loueur de 13 % et frais de service client de
7 %, tous deux calculés sur `subtotalAmountMinor + mandatoryFeesAmountMinor` et
arrondis avec `HALF_UP_PER_COMPONENT`. L'application fee Stripe porte la somme
des deux composants ; le total client inclut le seul frais de service client.

La décision produit ne vaut pas sign-off Finance/Juridique : la TVA, la
facturation, la qualification comptable, les frais Stripe et le traitement
contractuel des remboursements restent bloqués comme décrit dans
`docs/product/lot5-finance-legal-validation.md`. Aucune valeur de démonstration
ou de staging ne peut devenir une valeur LIVE implicite ; `FIN-002` reste
`BLOCKED` avant activation LIVE.

### 1.5 État réel et critères de passage au Go Pilote

Aucun loueur pilote n'est engagé à la date de référence (2026-08-27). Uttily peut
préparer le contenu modèle, la collecte structurée des informations et la checklist
d'onboarding, mais ne peut pas déclarer le pilote commercial prêt.

Le contenu d'une organisation fictive reste strictement une fixture de
développement ou de staging ; il ne constitue jamais une offre commerciale.

Le passage au **Go pilote commercial** exige au minimum :
1. Deux loueurs professionnels onboardés (ou décision explicite autorisant un
   démarrage avec un seul) ;
2. Vingt vélos réels publiables et réservables à Lyon ;
3. Un parcours TEST final validé avec les données représentatives de chaque loueur ;
4. Les validations finance, juridique et RGPD nécessaires au LIVE ;
5. Les configurations LIVE séparées, sans réutilisation des secrets TEST.

### 1.6 Découpage du lot G8B-3

- **G8B-3A — Cadrage commercial** : territoire, client, catégories, inventaire et
  proposition loueur.
- **G8B-3B — Kit d'onboarding vélo** : fiche de collecte loueur, établissement,
  horaires, vélos, variantes, prix, accessoires, photos et responsables
  (`docs/implementation/g8b-3b-assisted-bike-onboarding.md`).
- **G8B-3C — Contenu réel pilote** : création et vérification des 2 loueurs et
  des 20 vélos (bloqué sans partenaires engagés).
- **G8B-3D — Go/No-Go LIVE** : validations finance, juridique, RGPD, Stripe LIVE,
  observabilité et smoke test final.

---

## 2. Standard de Confiance Publique & Vérité Produit

### 2.1 Invariant absolu : Représentation catalogue vs Constat d'exemplaire

La fiche publique doit permettre au client de comprendre immédiatement ce qu'il
loue, auprès de quel professionnel, et avec quelle apparence et configuration le
matériel est présenté. Uttily pose une distinction stricte et non négociable :

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                 FRONTIÈRE ÉTANCHE REPRÉSENTATION VS CONSTAT                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. PHOTOS PUBLIQUES DE CATALOGUE (attachées au Product)                     │
│    = Représentation fidèle du modèle commercial et de ses composants clés.  │
│    -> Ne prouve JAMAIS l'état d'usure ou l'historique d'un vélo précis.     │
│                                                                             │
│ 2. RAPPORTS D'ÉTAT CONTRADICTOIRES (attachés à l'InventoryItem alloué)      │
│    = Constat d'état physique contradictoire au retrait et à la restitution. │
│    -> SEULE source probatoire en cas de dommage ou contestation.            │
└─────────────────────────────────────────────────────────────────────────────┘
```

Le vocabulaire **« état »**, **« condition »** ou **« défaut constaté »** est
strictement réservé aux rapports d'état attachés à l'exemplaire (`inventory_item`).
Une photo commerciale de catalogue ne doit en aucun cas être réutilisée ou
interprétée comme preuve de l'état d'un vélo remis.

### 2.2 Consignes de prise de vue et cycle de vie

#### Consignes opérationnelles pour le loueur :
- Smartphone récent suffisant (aucun équipement photo professionnel requis) ;
- Lumière naturelle ou éclairage homogène d'atelier, sans flash agressif ;
- Arrière-plan dégagé avec contraste net par rapport au cadre ;
- Sujet centré, horizontal, cadré sans rognage intempestif ;
- Résolution conforme aux limites techniques (ADR-020 et ADR-026 : min 1200×800 px,
  max 10 Mo, formats JPEG / PNG / WebP) ;
- Aucun filtre modifiant la teinte ou masquant la géométrie ;
- Défaut cosmétique ou structurel d'un modèle d'exposition non retouché.

#### Déclencheurs d'obsolescence photo
Uttily considère les photos d'un produit comme obsolètes et requiert une
actualisation lors des événements suivants :
- Changement de modèle commercial ou de millésime / génération ;
- Variation notable de couleur ou de géométrie de cadre ;
- Modification substantielle de la transmission ou du type de freinage ;
- Ajout ou retrait d'un accessoire permanent significatif (panier fixe, porte-bagages,
  antivol de cadre) ;
- Évolution majeure d'un composant VAE (batterie, moteur, console).

### 2.3 Badge « Loueur professionnel vérifié »

L'organisation professionnelle est l'entité contractuelle, juridique et la source
première de confiance :

> **Vélo Lyon Centre** — loueur professionnel vérifié  
> Retrait à Lyon 2e · paiement sécurisé · remise par un professionnel

Le badge est un **état strictement calculé et révocable**, jamais une étiquette
éditoriale statique ou un argument marketing complaisant. Il est explicable au survol/clic :

> *« Uttily a vérifié les informations professionnelles requises et atteste que ce
> loueur remplit actuellement l'ensemble des conditions d'éligibilité et de
> publication de la plateforme. »*

#### Modèle d'évaluation :
- **Statut** : `professional_verification_status` (`eligible` | `ineligible` | `pending`) ;
- **Horodatage** : `evaluated_at` (mis à jour à chaque événement d'organisation) ;
- **Traçabilité** : liste des critères non satisfaits en cas d'inéligibilité.

#### Prédicats d'éligibilité :
1. Informations professionnelles obligatoires fournies et identité validée
   conforme au processus d'onboarding Uttily ;
2. Compte Stripe Connect satisfaisant `stripe_account_operational_for_rental`
   (`charges_enabled`, `payouts_enabled` et absence de blocages dans `requirements`) ;
3. Au moins un établissement public configuré (adresse, horaires, coordonnées, retrait activé) ;
4. Processus d'onboarding initial accompagné par l'équipe Uttily validé.

*Découplage du stock* : L'éligibilité au badge est une propriété identitaire de
l'organisation. Une rupture temporaire de stock ne retire pas le badge de l'organisation.

### 2.4 Présentation d'équipe atelier et guides locaux

- **Contact humain atelier** (ex. « Marc, responsable atelier ») : présentation
  éditoriale facultative et consentie. Le départ d'un contact n'altère en rien
  l'historique, les réservations ni la conformité de l'organisation.
- **Guides locaux & itinéraires** : valorisation territoriale facultative (non
  bloquante pour la publication). Distinction formelle entre conseil éditorial
  du loueur, futur itinéraire audité par Uttily, et voirie publique officielle.
  Le terme « spot secret » est proscrit.

### 2.5 Tableau de vérité : Données réelles vs Affichages autorisés & interdits

| Situation et données réelles | Affichage et formulation autorisés | Formulations et promesses strictement interdites |
| :--- | :--- | :--- |
| **3 photos valides techniquement** avec checksums distincts (gate actuel) | Galerie photo du produit, vue d'ensemble | « 3 vues contrôlées », « Standard visuel vérifié » |
| **Slots sémantiques renseignés** (`HERO_PROFILE`, `THREE_QUARTER_FRONT`, `SECONDARY_VIEW`) dans le contrat et l’UI ; enforcement serveur par slot en attente | Présentation guidée et détaillée des composants clés | Promesse d'analyse d'image automatisée par IA |
| **Photos rattachées au `product`** (aucun `inventory_item` alloué) | Modèle et configuration générale illustrés | « Photo de votre vélo exact », « État d'usure contractuel » |
| **`inventory_item` alloué** + rapport d'état contradictoire | Fiche d'état de l'exemplaire (retrait / retour) | Assimilation des photos catalogue comme preuve de dommage |
| **Tous critères d'éligibilité satisfaits** (`eligible`) | Badge « Loueur professionnel vérifié » + explication | « Meilleur loueur », « Garantie zéro défaut » |
| **Évaluation `pending` (en cours de vérification)** | Organisation affichée sans badge | Affichage anticipé ou complaisant du badge |
| **Évaluation impossible / source indisponible** | Organisation affichée sans badge ; fail-closed | Déduction implicite d'éligibilité (unknown ≠ eligible) |
| **1 critère d'éligibilité perdu** (`ineligible`) | Nom d'organisation brut, sans badge | Maintien manuel ou affichage partiel de complaisance |
| **Inventaire à zéro mais organisation éligible** | Badge maintenu sur la fiche pro ; offre non réservable | Retrait du badge d'organisation pour rupture de stock |
| **Profil / bio responsable absent ou supprimé** | Fiche organisation et produits complètes | Blocage onboarding, alerte de profil incomplet |
| **Aucun guide local renseigné** | Fiche produit et réservation standard | Mention dépréciative ou blocage de mise en ligne |

---

## 3. Le Standard Visuel par Slots Sémantiques (Narration en 3 Vues)

Pour un service de location haut de gamme, le client recherche avant tout **une expérience désirable, claire et rassurante**. Les caractéristiques techniques détaillées (freins, chaîne, dérailleur) figurent dans les données structurées de la fiche.

La galerie photo obéit à un standard simple mais non rigide, articulé autour d'une **narration visuelle en 3 temps forts** :

> **1. Je découvre le vélo (Profil Hero) → 2. Je visualise son volume et son dynamisme (Vue 3/4 avant) → 3. Je découvre ce qui le rend pratique ou unique (Vue libre valorisante : détail utile ou 3/4 arrière).**

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   NARRATION VISUELLE VÉLO EN 3 TEMPS FORTS                  │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. HERO_PROFILE (Obligatoire, min 1, max 3)                                 │
│    Vue Hero de profil complet : accroche principale, proportions, fond net. │
│                                                                             │
│ 2. THREE_QUARTER_FRONT (Obligatoire, min 1, max 3)                          │
│    Vue 3/4 avant dynamique : volume, perspective, guidon et dynamisme.      │
│                                                                             │
│ 3. SECONDARY_VIEW (Obligatoire, min 1, max 5, multi-médias recommandé)      │
│    Vue libre valorisante : atout pratique/confort (cockpit, panier, écran,  │
│    selle) OU vue 3/4 arrière sous un autre angle si aucun détail marquant.  │
│                                                                             │
│ 4. SLOTS VAE / COMPLÉMENTAIRES (Optionnels non bloquants, min 0, max 2)     │
│    BATTERY · MOTOR · DISPLAY · CHARGER                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3.1 Slots obligatoires (tout vélo)

1. **`HERO_PROFILE`** ($\ge 1$ média, max 3) :
   - Vélo entier de profil, lumière homogène, belle accroche commerciale ;
   - Cadré sans coupure des roues ni du guidon, arrière-plan dégagé et valorisant ;
   - Marge de respiration d'environ 10 % autour des extrémités.
2. **`THREE_QUARTER_FRONT`** ($\ge 1$ média, max 3) :
   - Prise de vue à 45° avant valorisant le volume, la perspective et le poste de pilotage ;
   - Donne vie au produit et projette l'utilisateur dans l'expérience de conduite.
3. **`SECONDARY_VIEW`** ($\ge 1$ média, max 5, multi-médias recommandé) :
   - Vue libre valorisante choisie par le loueur parmi ce qui existe réellement :
     - Détail utile ou attractif : cockpit/guidon, console VAE, panier, phare design, selle confort, antivol de cadre ;
     - Ou à défaut, une vue 3/4 arrière dynamique sous un autre angle ;
   - Évite d'imposer artificiellement un « détail signature » sur un modèle épuré.

### 3.2 Slots complémentaires VAE (non bloquants)

Pour les vélos à assistance électrique, des slots enrichissent la fiche sans
bloquer la publication si les données figurent dans les champs structurés :
- **`BATTERY`** : intégration cadre, poignée et serrure de verrouillage ;
- **`MOTOR`** : bloc moteur central (pédalier) ou moteur moyeu ;
- **`DISPLAY`** : console / écran de contrôle au guidon et commandes d'assistance ;
- **`CHARGER`** : chargeur secteur fourni et connecteur spécifique.

### 3.3 Contrat de données TypeScript (`BIKE_PHOTO_SLOTS`)

Le contrat de domaine reste **strictement agnostique vis-à-vis du moteur de rendu visuel** (Rive, SVG interactif, Lottie ou Canvas). Il n'expose que des clés sémantiques universelles (`animationKey`, `overlayKey`) résolues par la couche de présentation.

```typescript
export type PhotoSlotType =
  | 'HERO_PROFILE'
  | 'THREE_QUARTER_FRONT'
  | 'SECONDARY_VIEW'
  | 'THREE_QUARTER'
  | 'SIGNATURE_DETAIL'
  | 'FULL_BIKE'
  | 'DRIVETRAIN'
  | 'BRAKES_TIRES'
  | 'BATTERY'
  | 'MOTOR'
  | 'DISPLAY'
  | 'CHARGER';

export interface PhotoSlotDefinition {
  type: PhotoSlotType;
  title: string;
  shortDescription: string;
  required: boolean;
  minMediaCount: number;
  maxMediaCount: number;
  multiMediaRecommended: boolean;
  checklistItems: readonly string[];
  guide: {
    animationKey: string;
    overlayKey: string;
    helperHint: string;
  };
}

export const BIKE_PHOTO_SLOTS: Record<PhotoSlotType, PhotoSlotDefinition> = {
  FULL_BIKE: {
    type: "FULL_BIKE",
    title: "Vue complète",
    shortDescription: "Vélo entier de profil, côté transmission (côté droit / chaîne)",
    required: true,
    minMediaCount: 1,
    maxMediaCount: 3,
    multiMediaRecommended: false,
    checklistItems: [
      "Vélo entier visible sans coupure des roues ni du guidon",
      "Pris de profil avec la transmission (chaîne/pédalier) face à vous",
      "Arrière-plan dégagé et contraste net avec le vélo",
    ],
    guide: {
      animationKey: "full-bike-intro",
      overlayKey: "full-bike",
      helperHint: "Placez le vélo dans le repère, sans couper les roues",
    },
  },
  DRIVETRAIN: {
    type: "DRIVETRAIN",
    title: "Transmission",
    shortDescription: "Pédalier, chaîne, cassette et dérailleur",
    required: true,
    minMediaCount: 1,
    maxMediaCount: 3,
    multiMediaRecommended: false,
    checklistItems: [
      "Plateau, manivelle et chaîne bien nets et éclairés",
      "Cassette ou pignon arrière visible",
      "Cadrage de proximité sans élément masquant",
    ],
    guide: {
      animationKey: "drivetrain-zoom",
      overlayKey: "drivetrain-anatomy",
      helperHint: "Rapprochez-vous du bloc pédalier et dérailleur",
    },
  },
  BRAKES_TIRES: {
    type: "BRAKES_TIRES",
    title: "Freins et pneus",
    shortDescription: "Système de freinage et profil des pneumatiques",
    required: true,
    minMediaCount: 1,
    maxMediaCount: 5,
    multiMediaRecommended: true,
    checklistItems: [
      "Système de freinage (étrier / disque / patin) clairement identifiable",
      "Sculpture ou profil de la bande de roulement du pneu net",
      "Plusieurs photos recommandées pour dissocier freins et pneus",
    ],
    guide: {
      animationKey: "brakes-tires-spotlight",
      overlayKey: "brakes-tires",
      helperHint: "Montrez les étriers/disques et la surface du pneu",
    },
  },
  BATTERY: {
    type: "BATTERY",
    title: "Batterie (VAE)",
    shortDescription: "Intégration cadre et serrure",
    required: false,
    minMediaCount: 0,
    maxMediaCount: 2,
    multiMediaRecommended: false,
    checklistItems: ["Batterie en place", "Serrure ou connecteur visible"],
    guide: {
      animationKey: "battery-highlight",
      overlayKey: "battery",
      helperHint: "Cadrez le logement et le verrou de la batterie",
    },
  },
  MOTOR: {
    type: "MOTOR",
    title: "Moteur (VAE)",
    shortDescription: "Bloc moteur central ou moyeu",
    required: false,
    minMediaCount: 0,
    maxMediaCount: 2,
    multiMediaRecommended: false,
    checklistItems: ["Marque ou bloc moteur visible"],
    guide: {
      animationKey: "motor-highlight",
      overlayKey: "motor",
      helperHint: "Cadrez le bloc moteur au niveau du pédalier ou du moyeu",
    },
  },
  DISPLAY: {
    type: "DISPLAY",
    title: "Écran / Commande (VAE)",
    shortDescription: "Console au guidon",
    required: false,
    minMediaCount: 0,
    maxMediaCount: 2,
    multiMediaRecommended: false,
    checklistItems: ["Écran allumé ou commandes visibles"],
    guide: {
      animationKey: "display-highlight",
      overlayKey: "display",
      helperHint: "Cadrez l'afficheur au guidon sans reflet gênant",
    },
  },
  CHARGER: {
    type: "CHARGER",
    title: "Chargeur (VAE)",
    shortDescription: "Chargeur secteur fourni",
    required: false,
    minMediaCount: 0,
    maxMediaCount: 2,
    multiMediaRecommended: false,
    checklistItems: ["Chargeur et embout de charge nets"],
    guide: {
      animationKey: "charger-highlight",
      overlayKey: "charger",
      helperHint: "Posez le chargeur à plat et montrez l'embout",
    },
  },
};
```

---

## 4. Spécification UX : Le Photo Coach Uttily

### 4.1 Vision et principes fondateurs

Le **Photo Coach Uttily** remplace l'écran passif « *Ajoutez 3 photos* » par un
parcours d'apprentissage interactif directement intégré au geste de prise de vue.

L'interface repose sur quatre principes fondateurs :

1. **L'animation enseigne, le texte accompagne (Pédagogie positive)** : une courte séquence
   vectorielle de 1,5 à 2 secondes démontre le cadrage attendu par une transition fluide
   (ex. trop près ✕ → recul → cadrage attendu avec petite icône pédalier : *« Placez la transmission face à vous »*).
2. **Continuité pédagogique absolue** :
   > **L'état final de l'animation d'exemple devient exactement le repère initial (Ghost Overlay) du viseur caméra.**  
   L'utilisateur n'a aucune rupture cognitive entre ce qu'il vient de voir et le calque filaire présent dans son viseur.
3. **Le guide reste dans le viseur (Ghost Overlay 20–30 %)** : une silhouette semi-transparente
   superposée au flux vidéo donne immédiatement l'échelle, la perspective et les marges nécessaires.
4. **Honnêteté technique et zéro faux signal** : le système guide l'humain et lui soumet une
   checklist d'auto-évaluation **initialement vierge**. Il ne prétend jamais qu'une IA a « certifié » la photo
   et invite l'utilisateur à cliquer sur *« Utiliser cette photo »* plutôt que « Valider ».

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                    LES 5 PILIERS DU PHOTO COACH UTTILY                      │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Animations ultra-courtes (1,5–2s) : zéro friction, pédagogie positive.   │
│ 2. Continuité stricte : dernière frame d'animation == Ghost Overlay caméra. │
│ 3. Overlays anatomiques : silhouette du cadre et repères de transmission.   │
│ 4. Zéro faux signal IA : cases à cocher vierges + « Utiliser cette photo ». │
│ 5. Mode rapide sur préférence : adapté aux flottes pro sans bloquer.        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 4.2 La boucle utilisateur en 6 étapes

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                            BOUCLE PHOTO COACH                               │
│                                                                             │
│  [1. Micro-anim 1,5–2s] ──> [2. Viseur + Overlay] ──> [3. Capture terminal] │
│           │                                                        │        │
│  [6. Slot suivant]      <── [5. Progression Filaire] <── [4. Checklist]     │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Étape 1 : Micro-animation d'intention (1,5 à 2 secondes)
À l'ouverture d'un slot (ex. `FULL_BIKE`), transition dynamique continue :
```text
Trop près / mal calé ✕  ──>  Recul fluide  ──>  Cadrage attendu (silhouette finale)
```
- Consigne positive et claire : *« Placez la transmission (côté chaîne) face à vous »* ;
- La dernière frame se fige exactement dans la forme de l'overlay caméra.

#### Étape 2 : Viseur caméra avec *Ghost Overlay* anatomique
- Silhouette vectorielle stylisée superposée au flux vidéo (opacité 20 % à 30 %) ;
- Consigne épurée : *« Placez le vélo dans le repère »* ;
- Bouton miniature « Exemple » : rejoue l'animation sans couper le flux ;
- **Invariant technique** : l'overlay est un calque SVG/CSS client. Il n'est
  **jamais incrusté** dans le fichier image capturé.

```
┌──────────────────────────────────────────────────┐
│ Vue complète — 1/3                     [Exemple] │
│                                                  │
│               ┌──────────────────┐               │
│               │   / \      __    │  <- Ghost     │
│               │  ○───◉──────○    │     Overlay   │
│               └──────────────────┘     (25% op.) │
│                                                  │
│      Placez la transmission face à vous          │
│                                                  │
│                     [ ● ]                        │
└──────────────────────────────────────────────────┘
```

#### Étape 3 : Capture à la meilleure résolution exploitable
Capture directe à la meilleure résolution exploitable fournie par le terminal (idéalement $\ge 1920\times 1080$), soumise ensuite aux gates techniques d'ADR-020 et ADR-026 (min 1200×800 px, max 10 Mo). Pas de compression destructive client altérant la colorimétrie. Option de sélecteur système sur les terminaux restreints.

#### Étape 4 : Auto-évaluation humaine (Checklist transparente)
Image présentée en plein cadre avec cases **initialement non cochées** pour confirmation humaine active, et bouton d'acceptation sobre :

```
┌──────────────────────────────────────────────────┐
│                                                  │
│                 [ APERÇU PHOTO ]                 │
│                                                  │
│  Vue complète — Vérifiez avant d'enregistrer :   │
│  ○ Vélo entier visible sans coupure              │
│  ○ Pris de profil côté transmission              │
│  ○ Aucun élément masquant le matériel            │
│                                                  │
│   [ Reprendre ]        [ Utiliser cette photo ]  │
└──────────────────────────────────────────────────┘
```

#### Étape 5 : Micro-récompense et progression filaire
Dès utilisation de la photo :
- Transition fluide (300–500 ms) vers la vignette de progression ;
- **Construction incrémentale de l'illustration vélo Uttily** :
  - Slot 1 → cadre et roues s'affichent en trait plein ;
  - Slot 2 → pédalier et chaîne s'assemblent ;
  - Slot 3 → freins et pneus complètent l'illustration ;
- Message de progression : *« Standard photo vélo : 2/3 complétés »*.

#### Étape 6 : Transition vers le slot suivant
Enchaînement vers le slot suivant jusqu'à la complétude de la fiche.

### 4.3 Animations vectorielles et overlays anatomiques par slot

- **`FULL_BIKE`** :
  - *Micro-animation (1,5–2s)* : Vélo centré, mise en avant du côté transmission, recul laissant 10 % de marge.
  - *Ghost Overlay* : Silhouette complète anatomique (cadre, cintre, roues).
- **`DRIVETRAIN`** :
  - *Micro-animation (1,5–2s)* : Zoom fluide depuis le vélo vers le bloc pédalier/chaîne/dérailleur.
  - *Ghost Overlay anatomique* : Repère circulaire subtil autour du plateau/manivelle + tracé filaire guidant vers la cassette et le dérailleur arrière (met en valeur la zone mécanique exacte plutôt qu'un rectangle abstrait).
- **`BRAKES_TIRES`** :
  - *Micro-animation (1,5–2s)* : Éclairage successif de l'étrier de frein avant puis de la bande de roulement du pneu.
  - *Ghost Overlay* : Double zone repère concentrique (étrier/disque et flanc/profil du pneu).
  - *Multi-médias* : Bouton `[ + Ajouter une photo détaillée ]` avec conseil : *« Recommandé pour présenter le frein et le pneu séparément »*.
- **Slots VAE (`BATTERY`, `MOTOR`, `DISPLAY`, `CHARGER`)** :
  - Zooms ciblés sur le verrouillage batterie, le bloc moteur, l'afficheur au guidon et le chargeur à plat.

### 4.4 Modes d'usage : Parcours Découverte vs Mode Rapide

Pour concilier prise en main des nouveaux arrivants et efficacité des gestionnaires de flotte :
1. **Parcours Découverte (par défaut lors du 1er vélo)** :
   - Lecture automatique de la micro-animation (1,5s) avant ouverture caméra ;
   - Checklist d'auto-évaluation complète post-capture.
2. **Mode Rapide (préférence utilisateur explicite)** :
   - À la fin du premier produit ou via un toggle dédié dans l'interface, le loueur peut choisir :  
     *« Passer en mode rapide pour les prochains vélos »* ;
   - Ouverture directe du viseur caméra avec le Ghost Overlay immédiatement actif ;
   - Bouton « *Exemple* » toujours disponible en coin d'écran à la demande ;
   - Préférence mémorisée localement et réversible à tout instant.

---

## 5. Architecture Technique Frontend & Caméra

### 5.1 Architecture en couches et Adapter UI

Pour garantir la pérennité du modèle, le domaine expose des clés de guide agnostiques (`animationKey`, `overlayKey`). Un **Adapter UI** (`PhotoGuideAnimationAdapter`) fait le pont vers le moteur d'animation retenu (ex. **Rive** via `BikePhotoGuide.riv`, machine à états `PhotoCoachStateMachine`, ou SVG interactif/Canvas) :

```typescript
// Contrat d'interface du contrôleur d'animation côté UI
export interface PhotoGuideController {
  setSlot(slot: PhotoSlotType): void;
  triggerExample(): void;
  markSuccess(): Promise<void>;
}

// Couche de mapping présentation (UI Adapter)
export interface PhotoGuideAnimationAdapter {
  resolveAnimation(animationKey: string): { artboard: string; stateMachine: string };
  resolveOverlay(overlayKey: string): React.ComponentType<{ className?: string }>;
}
```

### 5.2 Intégration Caméra Web (`getUserMedia`) & Fallback

L'intégration Web / PWA utilise l'API standard `MediaDevices` :

```typescript
export const CAMERA_CONSTRAINTS: MediaStreamConstraints = {
  audio: false,
  video: {
    facingMode: { ideal: "environment" },
    width: { ideal: 1920, min: 1280 },
    height: { ideal: 1080, min: 720 },
  },
};
```

- **Fallback automatique** vers `<input type="file" accept="image/*" capture="environment">` sur les navigateurs ou contextes sécurisés ne supportant pas l'accès direct au flux vidéo.

### 5.3 Échelons de maturité technique (Roadmap en 3 niveaux)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       ÉCHELONS DE MATURITÉ DU COACH                         │
├─────────────────────────────────────────────────────────────────────────────┤
│ NIVEAU 1 — MVP (Validé pour implémentation)                                 │
│ • Animations vectorielles interactives 1,5–2s (Rive / SVG)                  │
│ • Ghost Overlays passifs dans le flux vidéo (20-30% opacité)                │
│ • Checklist humaine transparente                                            │
│ • Contrôles techniques stricts existants (ADR-020/026, R2, dimensions)      │
│                                                                             │
│ NIVEAU 2 — Confort client préventif                                         │
│ • Détection locale côté navigateur : sous-exposition critique, flou         │
│ • Messages d'aide non bloquants (« La photo semble sombre, reprendre ? »)   │
│                                                                             │
│ NIVEAU 3 — Vision Computer & Détection en temps réel                        │
│ • Modèle ML embarqué (détection de cadre, orientation, transmission)        │
│ • Transition dynamique du repère : Gris ──> Orange ──> Vert                │
│ • Affirmation explicite de contrôle sémantique validée                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 6. Séquencement d'Implémentation & Références

### 6.1 Séquencement d'implémentation

1. **Socle & Typage Core — livré** : types `PhotoSlotType`, `PhotoSlotDefinition`
   et champ `slot_type` nullable dans `product_photos` (migration `0040`) ;
2. **Composants Viseur & Ghost Overlay — livré** : `CameraViewfinder`, support
   `getUserMedia`, fallback fichier et calques SVG ;
3. **Guide visuel — livré partiellement** : adapter des overlays, transitions et
   animations CSS de présentation livrés ; le fichier Rive déclaré par l’adapter
   n’est pas un moteur de validation sémantique et l’analyse IA reste hors périmètre ;
4. **Checklist & Progression — livré** : boucle d’auto-évaluation, progression
   et intégration dans le formulaire produit du dashboard ;
5. **Enforcement serveur des slots — livré** : ADR-031 et migration `0050`
   appliquent le gate « un slot canonique requis par vue » à la catégorie `bike`
   dans Core, PostgreSQL et la visibilité publique ;
6. **Calcul de confiance loueur — restant** : moteur auditable du badge professionnel
   (`eligible`, `ineligible`, `pending`) lié aux états d’organisation et Stripe ;
7. **Enrichissement facultatif** : profils d’équipe et guides locaux post-onboarding.

### 6.2 Références d'inspiration

- Airbnb, « How to take great photos for your listing » :
  <https://www.airbnb.com/resources/hosting-homes/a/how-to-take-great-photos-for-your-listing-687>
- Airbnb, informations affichées sur un profil hôte :
  <https://www.airbnb.com/help/article/3811>
- Airbnb, guidebooks publics : <https://www.airbnb.com/help/article/249>
- Stripe, gestion des comptes Connect et exigences opérationnelles :
  <https://docs.stripe.com/connect/migrate-to-stripe>
