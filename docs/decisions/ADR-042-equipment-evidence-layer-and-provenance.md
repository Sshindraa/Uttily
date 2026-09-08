# ADR-042 — Equipment Evidence Layer, Provenance des Attributs & Garde-Fous Probabilistes

- **Statut :** Accepted
- **Date :** 2026-09-07
- **Relie à :** [ADR-001](ADR-001-monolithe-modulaire.md), [ADR-008](ADR-008-server-actions-contract.md), [ADR-019](ADR-019-ai-native-global-rental-infrastructure.md), [ADR-031](ADR-031-category-photo-requirements-and-publication-gate.md), [ADR-035](ADR-035-closed-outdoor-equipment-taxonomy.md), [ADR-040](ADR-040-uttily-intelligence-architecture.md), [ADR-041](ADR-041-pack-orchestrator-and-compatibility-graph.md)

---

## 1. Contexte & Problématique

La Phase 2 a introduit le Photo Quality Coach dans Uttily pour assister les loueurs professionnels lors de la prise de vue et extraire des attributs techniques visibles (`isElectric`, `hasLuggageRack`, `hasTrailerHitch`, `hasChildSeatCompatibleMount`).

L'enrichissement de l'inventaire par vision par ordinateur (VLM) expose l'architecture à deux risques de conception majeurs :

1. **Confusion entre observation visuelle et compatibilité certifiée** :
   Ce n'est pas parce qu'un modèle multimodal détecte visuellement ce qui ressemble à un axe traversant ou un crochet d'attelage (`hasTrailerHitch = true`) que cet équipement est mécaniquement et juridiquement compatible avec une remorque enfant donnée. Assimiler une observation probabiliste à une compatibilité matérielle certifiée violerait les engagements de sécurité d'Uttily.
2. **Veto probabiliste du VLM** :
   Donner à un modèle probabiliste le pouvoir de bloquer unilatéralement la publication d'un équipement (via un statut `REJECTED` infranchissable) inverse l'autorité : un système probabiliste devient censeur métier. Cela réintroduirait la dérive explicitement bannie par l'ADR-019.
3. **Hygiène et confidentialité des photos d'atelier** :
   Les photos prises dans les locaux professionnels peuvent contenir des métadonnées EXIF (coordonnées GPS précises, horodatage, modèle d'appareil) ou des éléments personnels qui doivent être purgés avant tout traitement ou transfert vers des tiers.

---

## 2. Doctrine Produit Fondamentale

La présente décision grave dans le marbre la doctrine produit d'Uttily pour l'ensemble des systèmes intelligents :

> **« Uttily préfère une information inconnue à une information plausible mais inventée. »**

Cette doctrine se décline en quatre règles inviolables :
1. **Observation visuelle ≠ compatibilité certifiée** : Une détection d'image est une observation, pas un fait homologué.
2. **Pas de décision de sécurité sur inférence pure** : Toute relation critique pour l'intégrité physique des utilisateurs (remorques enfants, sièges bébés, EPI) exige un niveau de preuve vérifié.
3. **Pas de veto probabiliste** : L'IA conseille et guide ; elle ne bloque jamais seule la publication d'un matériel si les critères déterministes minimaux sont satisfaits.
4. **Souveraineté et responsabilité du professionnel** : Le loueur est l'autorité humaine qui confirme l'état de son parc.

---

## 3. Architecture des Niveaux de Preuve (Evidence Levels)

Nous formalisons trois niveaux de vérité hermétiques pour les caractéristiques d'équipement :

```text
┌──────────────────────────────────────────────────────────────────┐
│ 1. AI_OBSERVED                                                   │
│    Observation visuelle issue d'une inférence multimodale.       │
│    Confiance statistique. INSUFFISANT pour la sécurité.          │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
                                  ▼ Confirmation par le loueur
┌──────────────────────────────────────────────────────────────────┐
│ 2. HUMAN_CONFIRMED                                               │
│    Le loueur professionnel atteste que l'équipement existe       │
│    et engage sa responsabilité contractuelle d'exploitant.       │
└─────────────────────────────────┬────────────────────────────────┘
                                  │
                                  ▼ Rapprochement constructeur / norme
┌──────────────────────────────────────────────────────────────────┐
│ 3. SOURCE_VERIFIED                                               │
│    Compatibilité mécanique certifiée par une source officielle   │
│    (norme EN/ISO, manuel constructeur, certificat technique).    │
│    Autorité absolue pour le CompatibilityGraph et le PackSolver. │
└──────────────────────────────────────────────────────────────────┘
```

### 3.1. Structure de Données de Provenance

Dans `@uttily/contracts` et `@uttily/database` (`productVariants.attributes`) :

```ts
export type EvidenceLevel = 'AI_OBSERVED' | 'HUMAN_CONFIRMED' | 'SOURCE_VERIFIED';

export interface EquipmentAttributeEvidence<T = unknown> {
  readonly key: string;
  readonly value: T;
  readonly evidenceLevel: EvidenceLevel;
  readonly inferenceId?: string;
  readonly confirmedBy?: string;
  readonly confirmedAt?: string;
  readonly sourceStandard?: string;
}
```

### 3.2. Règles de Consommation par le CompatibilityGraph

Dans `@uttily/core` (`packages/core/src/packs/compatibility-graph.ts`) :
- Pour les accessoires généraux de confort (paniers, sacoches, sonnettes), le niveau `HUMAN_CONFIRMED` ou `AI_OBSERVED` (avec avertissement) peut être toléré.
- Pour les accessoires **safety-critical** (`CHILD_TRAILER`, `CHILD_SEAT`) :
  - L'accessoire doit être homologué selon une norme officielle (`SOURCE_VERIFIED`).
  - Le support sur le vélo porteur doit être a minima `HUMAN_CONFIRMED` par le loueur (engageant sa responsabilité de conformité) ou `SOURCE_VERIFIED` par compatibilité de modèle (ex: axe traversant vérifié).
  - Un attribut `AI_OBSERVED` seul est **strictement insuffisant** et traité comme `UNKNOWN` par le `PackSolver`.

---

## 4. Garde-Fous Probabilistes : Suppression du Veto VLM

Nous établissons une séparation stricte entre deux types de contrôles :

### 4.1. Hard Blockers Déterministes (Invariants Code)
- Fichier non fourni, vide ou corrompu.
- Format non supporté (seuls JPEG, PNG et WebP sont autorisés).
- Résolution inférieure au seuil de lisibilité minimale (< 800×600 px).
- Absence physique de photo sur un slot obligatoire lors de la soumission de publication (ADR-031).

Ces contrôles sont codés en dur dans le serveur. Si l'un échoue, la requête est rejetée avec un code d'erreur déterministe (`VALIDATION`).

### 4.2. Diagnostic Qualité Probabiliste (VLM Advisory)
Le score de qualité (netteté, cadrage, exposition, arrière-plan) et le verdict (`CONFORMANT`, `WARNING`, `REJECTED`) calculés par le modèle multimodal sont des **recommandations d'atelier**, non des censures :
- Un verdict `REJECTED` déclenche une alerte explicative et met en avant l'action recommandée *« Reprendre la photo 📷 »*.
- **Le loueur dispose toujours de l'action de recours** : *« Continuer malgré tout avec cette photo »*. Cette action enregistre la confirmation humaine explicite et permet la publication si les hard blockers déterministes sont levés.

---

## 5. Confidentialité & Hygiène des Médias

Pour respecter le principe de minimisation des données (RGPD) et protéger la confidentialité des ateliers :

1. **Expurgation EXIF systématique** :
   - Tout flux d'image entrant est expurgé de ses segments d'en-tête APP1 (EXIF : localisation GPS, horodatage, numéro de série d'appareil) avant transfert au modèle multimodal ou stockage durable.
2. **Minimisation des transferts** :
   - L'image envoyée au modèle multimodal est redimensionnée et compressée aux dimensions d'analyse utiles (1280px max) pour minimiser la bande passante et le coût d'inférence.
3. **Limitation de finalité (*Purpose Limitation*)** :
   - Les photos de catalogue servent exclusivement à la vérification qualité et à l'enrichissement d'inventaire. Aucune donnée n'est cédée pour l'entraînement de modèles tiers.

---

## 6. Conséquences & Bénéfices

- **Fiabilité absolue du PackSolver** : Les packs résolus ne courent aucun risque de défaillance mécanique due à des hallucinations d'accessoires.
- **Respect de l'humain responsable** : Le loueur professionnel conserve le dernier mot sur son outil de travail tout en bénéficiant de conseils de standardisation premium.
- **Sécurité juridique et RGPD** : Aucune métadonnée personnelle (GPS d'atelier) ne fuit vers les fournisseurs de modèles d'IA.
