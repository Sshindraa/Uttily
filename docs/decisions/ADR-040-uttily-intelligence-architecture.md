# ADR-040 — Architecture de packages/intelligence, ports multimodaux et registre de provenance

- **Statut :** Accepted
- **Date :** 2026-09-07
- **Relie à :** [ADR-001](ADR-001-monolithe-modulaire.md), [ADR-008](ADR-008-server-actions-contract.md), [ADR-016](ADR-016-audit-log-append-only-enforcement.md), [ADR-019](ADR-019-ai-native-global-rental-infrastructure.md), [ADR-035](ADR-035-closed-outdoor-equipment-taxonomy.md), [ADR-039](ADR-039-gdpr-erasure-and-probatory-seal.md)

---

## 1. Contexte

Uttily dispose d'une infrastructure transactionnelle mature et éprouvée :
- Concurrence stricte spatio-temporelle via contraintes PostgreSQL `EXCLUDE USING gist` empêchant tout surbooking.
- Moteur financier Stripe Connect split 13/7 conforme aux règles comptables et fiscales.
- Conformité RGPD régalienne (scellement probatoire, effacement Article 17, exports Article 15/20).
- Monolithe modulaire TypeScript avec séparation stricte des domaines (`@uttily/core`, `@uttily/database`, `@uttily/contracts`, etc.).

Cependant, l'expérience utilisateur reste celle d'un SaaS/marketplace CRUD classique :
- **Côté loueur :** La création d'un équipement impose un parcours rébarbatif en 5 étapes (formulaires, saisie de la marque, modèle, caractéristiques techniques, photos, plans tarifaires).
- **Côté client :** La recherche impose une suite de listes déroulantes et de filtres rigides.

L'[ADR-019](ADR-019-ai-native-global-rental-infrastructure.md) a posé la direction stratégique d'une infrastructure mondiale de location compatible avec l'ère de l'intelligence artificielle, tout en fixant un principe directeur intangible :
> *« PostgreSQL et les use cases Uttily restent l'autorité pour la disponibilité, les autorisations, les prix et les états. Une IA peut proposer, classer, expliquer ou préparer. Elle ne contourne jamais ces autorités. »*

Les fondations déterministes étant achevées, Uttily doit désormais déployer sa couche d'intelligence opérationnelle (**Uttily Intelligence v1**) pour supprimer les frictions manuelles, en commençant par le supply (**P0 — Scan & List / AI Equipment Copilot**).

---

## 2. Principes architecturaux non négociables

### 2.1. `@uttily/intelligence` sans accès direct à la base de données
Le package `packages/intelligence` est une bibliothèque pure d'interfaces, de schémas, de prompts, d'évaluations et d'adaptateurs de fournisseurs d'IA.
- **Règle absolue :** Aucune dépendance vers `@uttily/database`, Drizzle ORM ou un pool PostgreSQL n'est autorisée dans `@uttily/intelligence`.
- **Flux transactionnel unilatéral :**
  ```text
  Image / Document / Prompt
              │
              ▼
  [ packages/intelligence ] (enrichEquipment, compileIntent)
              │
              ▼
    Proposition purement en mémoire (EquipmentEnrichmentProposal)
              │
              ▼
    Revue et validation humaine (Interface utilisateur / Server Action)
              │
              ▼
    Use cases déterministes de @uttily/core
              │
              ▼
    PostgreSQL (Stock, Contrats, Photos, Provenance)
  ```

### 2.2. Encadrement de Zod et respect d'ADR-008
- L'[ADR-008](ADR-008-server-actions-contract.md) impose une validation manuelle et explicite des entrées HTTP/FormData au niveau des Server Actions (pas de Zod aux frontières web).
- **Décision d'encadrement :** L'usage de Zod est autorisé et réservé **exclusivement** à l'intérieur de `@uttily/intelligence` pour valider et contraindre les sorties probabilistes structurées des modèles (VLM / LLM). Cette autorisation n'amende pas l'ADR-008 et n'introduit aucun Zod dans les Server Actions ou dans `@uttily/contracts`.

### 2.3. Politique d'abstention explicite : `Abstention > hallucination`
Pour mériter la confiance des professionnels, un modèle VLM doit pouvoir déclarer qu'une information n'est pas déterminable.
- Chaque champ probabiliste retourné est encapsulé dans une structure `ConfidentField<T>` :
  ```ts
  export interface ConfidentField<T> {
    value: T | null;
    confidence: number; // Intervalle [0.0, 1.0]
    reasoning?: string;
  }
  ```
- Si une photo latérale permet d'identifier formellement la marque (*Specialized*, confiance 0.99) et la famille (*VTT électrique*, confiance 0.98), mais pas la taille exacte du cadre (M, L ou XL), le modèle doit renvoyer `value: null` avec une confiance basse plutôt que de deviner une valeur arbitraire.
- L'interface met en valeur les éléments certifiés et demande confirmation uniquement pour les champs incertains ou absents.

### 2.4. Exclusion du pricing de Scan & List v1
- Scan & List v1 se concentre sur l'identité, la taxonomie canonique, les attributs techniques, la rédaction commerciale et la classification des photos.
- Aucun modèle VLM ne doit inventer un tarif à partir de ses poids probabilistes.
- La tarification reste saisie par le loueur lors de cette phase. Les recommandations de *Yield / Rental Intelligence* ne seront introduites que lorsqu'elles reposeront sur des données opérationnelles objectives (transactions réelles, saisonnalité, météo, taux d'occupation de la flotte).

### 2.5. Conservation du workflow manuel déterministe
- Le parcours d'ajout d'équipement en 5 étapes existant (`/dashboard/[orgId]/bikes/new`) est conservé intact comme repli déterministe intégral.
- L'entrée devient une bifurcation claire :
  1. `📷 Ajouter avec Uttily Intelligence` (Scan & List par photo/facture) ;
  2. `Ajouter manuellement` (parcours formulaire pas-à-pas).
- En cas d'indisponibilité du fournisseur IA, de dépassement de budget, de timeout réseau ou de rejet d'une image inexploitable, le loueur peut instantanément basculer sur le parcours manuel sans blocage.

### 2.6. Neutralité des modèles et indépendance technologique
- Aucun nom de modèle spécifique n'est gravé comme contrainte architecturale.
- Les capacités d'intelligence reposent sur des spécifications de profil :
  - Modalités d'entrée : Image (VLM) + Texte.
  - Sortie : JSON structuré garanti par schéma (Structured Outputs).
  - Budget de latence : P95 < 4 000 ms.
  - Budget de coût : plafond unitaire par inférence.
  - Exigences de localisation des données (serveurs UE / conformité DPF).
- Le modèle actif est sélectionné par configuration d'environnement au runtime parmi les fournisseurs supportés (`google`, `openai`, `anthropic`).

---

## 3. Registre de provenance et auditabilité des inférences

Pour bâtir le futur **Equipment Graph propriétaire** et respecter les exigences de gouvernance des données, chaque inférence IA consommée est enregistrée dans une table d'audit dédiée, gérée par `@uttily/database` :

```sql
CREATE TABLE intelligence_inferences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  capability TEXT NOT NULL,          -- ex: 'EQUIPMENT_ENRICHMENT'
  capability_version TEXT NOT NULL,  -- ex: 'v1.0'
  schema_version TEXT NOT NULL,      -- ex: '2026-09-07'
  provider TEXT NOT NULL,            -- ex: 'google', 'openai', 'anthropic'
  model TEXT NOT NULL,               -- nom du modèle runtime
  provider_request_id TEXT,
  prompt_version TEXT NOT NULL,
  input_fingerprint TEXT NOT NULL,   -- SHA-256 des images / du prompt d'entrée
  status TEXT NOT NULL,              -- 'SUCCESS', 'REFUSAL', 'ERROR'
  structured_output JSONB NOT NULL,  -- Résultat canonique normalisé
  latency_ms INTEGER NOT NULL,
  input_units INTEGER,               -- Tokens ou images
  output_units INTEGER,              -- Tokens de sortie
  cost_microunits INTEGER,           -- Coût estimé en micro-centimes d'euro
  subject_type TEXT,                 -- ex: 'PRODUCT'
  subject_id UUID,                   -- UUID de l'entité créée/enrichie
  feedback_status TEXT,              -- 'ACCEPTED', 'MODIFIED', 'REJECTED'
  user_correction_patch JSONB,       -- Diff entre proposition IA et validation humaine
  accepted_by_user_id UUID REFERENCES users(id),
  accepted_at TIMESTAMPTZ,
  error_code TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### Rétention et protection RGPD de `raw_output`
- La réponse brute fournisseur (`raw_output`) **n'est pas persistée de manière obligatoire dans la table SQL**.
- Pour minimiser le volume et respecter le principe de minimisation des données (RGPD), seul le `structured_output` canonique et validé est conservé durablement.
- La concordance entre l'inférence et la sortie conservée est garantie par `input_fingerprint` et `provider_request_id`.

---

## 4. Métriques de succès (KPIs) de P0 — Scan & List

Le succès du déploiement de Scan & List est mesuré par des indicateurs d'efficacité métier réels :
1. **Time to First Publish :** Réduction du temps moyen de création d'un équipement publiable de plusieurs minutes à moins de **60 secondes**.
2. **Effort humain :** Moins de **5 corrections ou saisies manuelles** nécessaires pour finaliser une fiche proposée par l'IA.
3. **Inference Acceptance Rate :** Taux d'acceptation global des fiches proposées supérieur à **80 %**.
4. **Abstention Rate :** Taux d'abstention mesuré et maîtrisé sur les champs flous (privilégiant la précision au volume).
5. **P95 Latency :** Réponse VLM complète sous **3,5 secondes**.
6. **Coût unitaire d'onboarding :** Inférieur à **0,05 € par équipement traité**.

---

## 5. Découpage du chantier Uttily Intelligence v1

1. **Jour 1 — Architecture & Contrats (Le présent lot) :**
   - Approbation d'ADR-041.
   - Initialisation de `packages/intelligence` avec ports agnostiques, schémas Zod avec gestion de l'abstention (`ConfidentField`), fake déterministe de test et tests Vitest.
2. **Jours 2–3 — Adaptateur Fournisseur & Registre de Provenance :**
   - Implémentation du provider VLM multimodal avec structured outputs.
   - Migration de la table `intelligence_inferences` dans `@uttily/database`.
   - Tests d'intégration et benchmark sur corpus réel d'équipements.
3. **Jours 4–5 — Expérience Pro Scan & List :**
   - Interface loueur `ScanAndListZone` dans `/dashboard/[orgId]/bikes/new`.
   - Carte de révision interactive Human-in-the-Loop.
   - Branchement direct sur les use cases `@uttily/core` existants.
