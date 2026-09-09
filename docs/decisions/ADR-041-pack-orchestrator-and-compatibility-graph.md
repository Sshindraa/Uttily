# ADR-041 — Domaine Pack, Graphe de Compatibilité et Allocation Atomique Multi-Équipements

- **Statut :** Accepted
- **Date :** 2026-09-07
- **Relie à :** [ADR-001](ADR-001-monolithe-modulaire.md), [ADR-008](ADR-008-server-actions-contract.md), [ADR-009](ADR-009-booking-draft-pricing-idempotency-and-holds.md), [ADR-019](ADR-019-ai-native-global-rental-infrastructure.md), [ADR-035](ADR-035-closed-outdoor-equipment-taxonomy.md), [ADR-040](ADR-040-uttily-intelligence-architecture.md)

---

## 1. Contexte & Problématique

Le moteur de recherche public d'Uttily opère historiquement sur des offres unitaires (`searchPublicOffers`) : un utilisateur recherche une famille d'équipement (ex. vélo), sélectionne une offre, puis configure une variante isolée.

Dans la pratique de la location de loisir et d'aventure, la majorité des demandes émane de **groupes ou de familles** exprimant un projet d'activité global (ex. *« 2 adultes et 1 enfant de 6 ans, tour du lac en vélos électriques ce samedi »*). 

Cette réalité se heurte à deux limites majeures :
1. **La fragmentation des recherches** : Le locataire doit effectuer plusieurs recherches manuelles indépendantes pour trouver simultanément 2 vélos adultes, un dispositif de transport d'enfant et des casques compatibles.
2. **L'invariant du panier mono-loueur** : Pour des raisons de responsabilité juridique, de logistique de retrait et d'encaissement Stripe Connect, une réservation Uttily ne peut contenir que les produits d'une **seule et même organisation** de loueur professionnel.

Plutôt que de traiter le panier mono-loueur comme une contrainte technique limitante, la présente décision en fait un **avantage produit distinctif** :
> *« Un groupe. Une activité. Un loueur. Un retrait. Un paiement. »*
> Uttily ne cherche pas de simples équipements isolés ; Uttily compose une solution de location cohérente, disponible et retirable au même endroit.

---

## 2. Décision d'Architecture

Nous introduisons dans `@uttily/core` le sous-domaine **Pack Orchestration** et le **Graphe de Compatibilité**, appuyés sur la couche de compréhension probabiliste `@uttily/intelligence` définie dans l'[ADR-040](ADR-040-uttily-intelligence-architecture.md).

```text
[ REQUÊTE UTILISATEUR ]
          │
          ▼
┌──────────────────────────────────────┐
│ @uttily/intelligence                 │
│ IntentCompiler                       │
│ Produit : CompiledIntentProposal     │
│ (faits, inconnues, préférences)      │
└──────────────────┬───────────────────┘
                   ▼
┌──────────────────────────────────────┐
│ @uttily/core                         │
│ Intent Normalizer                    │
│ PartyModel & RequirementModel        │
└──────────────────┬───────────────────┘
                   ▼
         Informations manquantes ?
             │            │
            Oui          Non
             │            │
      UI visuelle         ▼
                 ┌──────────────────────────────────────┐
                 │ CompatibilityGraph (@uttily/core)    │
                 │ Règles sourcées, versionnées         │
                 └──────────────────┬───────────────────┘
                                    ▼
                 ┌──────────────────────────────────────┐
                 │ PackSolver (@uttily/core)            │
                 │ Résolution déterministe mono-loueur  │
                 │ Contraintes temps réel PostgreSQL    │
                 └──────────────────┬───────────────────┘
                                    ▼
                          Solution exacte trouvée ?
                             │            │
                            Oui          Non
                             │            ▼
                             │     Repair Engine (@uttily/core)
                             │     Relaxations explicites
                             │            │
                             └──────┬─────┘
                                    ▼
                 ┌──────────────────────────────────────┐
                 │ PackRanker (@uttily/core)            │
                 │ Classement déterministe et auditable │
                 └──────────────────┬───────────────────┘
                                    ▼
                 ┌──────────────────────────────────────┐
                 │ Explanation Layer                    │
                 │ Justification transparente des choix │
                 └──────────────────┬───────────────────┘
                                    ▼
                 ┌──────────────────────────────────────┐
                 │ Atomic Pack Hold                     │
                 │ Allocation transactionnelle GiST     │
                 └──────────────────────────────────────┘
```

---

## 3. Principes Fondateurs

### 3.1. Souveraineté du `PartyModel` dans `@uttily/core`

Le modèle de groupe (`PartyModel`) n'appartient pas à l'IA. Le LLM produit uniquement une **proposition compilée** (`CompiledIntentProposal`) contenant des faits extraits, des préférences probabilistes et des inconnues explicites.

C'est `@uttily/core` qui valide et instancie le modèle canonique :
```ts
export interface ExtractedFact {
  readonly kind: 'DESTINATION' | 'DATE' | 'PARTY_MEMBER' | 'EQUIPMENT_NEED';
  readonly value: unknown;
  readonly confidence: number;
}

export interface MissingField {
  readonly field: 'DESTINATION' | 'DATES' | 'HEIGHT' | 'AGE';
  readonly partyMemberIndex?: number;
  readonly promptReason: string;
}

export interface CompiledIntentProposal {
  readonly facts: readonly ExtractedFact[];
  readonly unknowns: readonly MissingField[];
  readonly rawQueryCleaned: string;
  readonly confidence: number;
}
```

Ce découplage garantit que `PartyModel` pourra être alimenté indifféremment par du langage naturel (LLM), un formulaire d'accueil visuel, une API de conciergerie ou un partenaire hôtelier.

### 3.2. Règle du `UNKNOWN` : Zéro supposition statistique

Pour mériter la confiance des professionnels et des locataires, Uttily n'extrapole jamais de données morphologiques statistiques non fournies (ex. ne jamais déduire qu'un enfant de 6 ans mesure 115 cm ou qu'un adulte fait une taille M).
- Tout attribut physique non mentionné est instancié à `UNKNOWN`.
- Lorsque l'attribution d'une taille physique d'exemplaire est nécessaire, l'interface utilisateur pose explicitement la question via des composants visuels directs (sélecteurs de taille par palier).

### 3.3. Graphe de Compatibilité Sourcé et Versionné

Le `CompatibilityGraph` réside dans `@uttily/core` et modélise les relations physiques, mécaniques et de sécurité entre variantes d'équipements et besoins fonctionnels.

**Règle cardinale : Aucune recommandation de sécurité n'est inventée par le LLM.**
- Le LLM identifie le besoin fonctionnel (ex. `CHILD_TRANSPORT`).
- Le graphe détermine les solutions admissibles et leurs conditions d'assemblage.

Chaque règle critique du graphe est obligatoirement **sourcée et auditée** :
```ts
export interface CompatibilityRule {
  readonly id: string;
  readonly requirementType: string;
  readonly compatibleCategorySlug: string;
  readonly compatibleSubtype?: string;
  readonly requiredAccessorySlug?: string;
  readonly maxChildWeightKg?: number;
  readonly minChildAgeMonths?: number;
  readonly sourceManual: string;
  readonly sourceVersion: string;
  readonly verifiedAt: string;
}
```

### 3.4. Séparation stricte entre `PackRanker` déterministe et Couche d'Explication

Le classement des packs candidats est **100% déterministe, auditable et sans composante probabiliste** :
```text
score = (exact_requirement_match * 1000)
      + (single_pickup_location * 300)
      + (requested_date_match * 200)
      - (distance_meters * penalty_per_meter)
      - (repair_deviation_score * penalty_per_deviation)
      - (price_cents * price_tie_breaker)
```

La couche d'explication (`Explanation Layer`) prend les métriques de scoring et les raisons structurelles pour générer une synthèse claire pour le locataire (*« Pourquoi ce pack ? »*). **L'IA explique le classement, elle ne le crée pas.**

### 3.5. Moteur de Réparation : Relaxations Explicites, Zéro Altération Silencieuse

Si aucun loueur dans la zone ne dispose de l'ensemble exact des équipements demandés sur le créneau souhaité, le `RepairEngine` explore des relaxations selon un ordre de priorité strict :
1. **Substitution d'équipement / accessoire** autorisée par le `CompatibilityGraph` chez le même loueur (ex. remorque enfant homologuée au lieu d'un siège bébé).
2. **Décalage horaire** sur la même journée (créneau voisin disponible).
3. **Décalage de date** (lendemain, ex. dimanche au lieu de samedi).
4. **Extension du rayon géographique** (loueur alternatif dans un périmètre élargi).

Chaque relaxation produit un objet `PackRepair` et un score d'écart (`deviationScore`) :
```ts
export interface PackRepair {
  readonly type: 'EQUIPMENT_SUBSTITUTION' | 'TIME_SHIFT' | 'DATE_SHIFT' | 'RADIUS_EXPANSION';
  readonly originalRequirement: string;
  readonly proposedRequirement: string;
  readonly deviationScore: number;
  readonly explanationFr: string;
  readonly explanationEn: string;
}
```
L'interface utilisateur distingue formellement une **Correspondance exacte** d'une **Alternative avec adaptation**.

### 3.6. Allocation Atomique Multi-Équipements (`Atomic Pack Hold`)

Pour respecter les garanties de concurrence établies dans l'[ADR-009](ADR-009-booking-draft-pricing-idempotency-and-holds.md), la réservation d'un pack ne peut jamais être partielle.

**Invariant transactionnel :**
Lors de la sélection d'un pack, tous les exemplaires physiques identifiés doivent être réservés simultanément au sein d'une seule transaction PostgreSQL :
```sql
BEGIN;

-- 1. Vérification de non-conflit sur l'ensemble des exemplaires du pack
SELECT id FROM inventory_items 
WHERE id = ANY($item_ids) 
FOR UPDATE;

-- 2. Insertion des holds temporaires pour chaque exemplaire
INSERT INTO booking_holds (booking_id, inventory_item_id, start_at, end_at, expires_at)
VALUES ...;

-- Si une seule allocation échoue (conflit de hold ou maintenance concurrente) :
-- ROLLBACK intégral immédiat.
COMMIT;
```
Les contraintes `EXCLUDE USING gist` au niveau de la table garantissent mathématiquement l'absence de chevauchement.

---

## 4. Conséquences & Impacts

### Positifs
- **Expérience utilisateur unifiée** : Résolution en une seule étape d'un besoin multi-personnes complexe.
- **Taux de conversion marketplace** : Élimination des paniers abandonnés causés par la dispersion des stocks entre loueurs.
- **Sécurité et conformité irréprochables** : Les compatibilités matérielles reposent sur des manuels constructeurs sourcés, sans hallucination de modèle.
- **Robustesse transactionnelle** : Maintien intégral des garanties d'idempotence et d'exclusion PostgreSQL.

### Négatifs / Contraintes
- Nécessite d'alimenter et maintenir les règles de compatibilité constructeur (`CompatibilityGraph`).
- Complexité algorithmique de résolution supérieure à une simple clause `WHERE category = ...` (bipartite matching entre besoins du groupe et exemplaires physiques disponibles d'un loueur).

---

## 5. État d'Implémentation & Prochaines Étapes

1. Définition des types et schémas `PartyModel`, `FunctionalRequirement` et `PackRequest` dans `@uttily/core`.
2. Implémentation du `CompatibilityGraph` dans `packages/core/src/compatibility/`.
3. Implémentation du use-case `solvePackForParty` dans `packages/core/src/pack-solver/`.
4. Intégration dans la Server Action `apps/web/src/app/actions/pack-search.ts`.
5. Interface utilisateur Pack dans `apps/web/src/features/packs/`.
