# Plan de déblocage du premier pilote — 21-P0

**Référence de version :** document vivant ; vérifier le commit courant du dépôt
avant utilisation. Les anciennes baselines `origin/main = ...` sont historiques.
**Dernière revue de cohérence :** 2026-09-04  
**Statut :** Arbitrages et sign-offs humains DPO, Juridique et Finance formellement actés le 2026-09-04. Les 31 blockers initiaux sont levés ou résolus. Seules les étapes opérationnelles de configuration LIVE (secrets, webhooks, compte connecté) restent à finaliser.

## Blockers pilote

| Blocker ID | Sujet | Decision ID(s) | Owner | État | Evidence | Next action | Blocking pilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `C2A-01` | CGU / CGV client | `LEGAL-001` | Juridique + porteur produit | `APPROVED` ✅ | Pages `/terms`, `/rental-terms` publiées en `v1` et opposables au checkout. | Validé le 2026-09-04. | Non |
| `C2A-02` | Version des terms | `LEGAL-001` | Juridique | `APPROVED` ✅ | Version canonique `v1` formellement approuvée. | Validé le 2026-09-04. | Non |
| `C2A-03` | Snapshot d'acceptation | `LEGAL-001` | Juridique + porteur produit | `APPROVED` ✅ | Chaîne d'opposabilité `terms_acceptance_snapshot` validée. | Validé le 2026-09-04. | Non |
| `C2A-04` | Conditions Pro / contrat loueur | `LEGAL-002` | Juridique + porteur produit | `APPROVED` ✅ | Contrat Pro `/pro-terms` v1 et consentement onboarding approuvés. | Validé le 2026-09-04. | Non |
| `C2A-05` | Politiques d'annulation | `LEGAL-004`, `LEGAL-005` | Juridique + finance + produit | `APPROVED` ✅ | `FLEXIBLE`, `MODERATE`, `FIRM` et grâce 24h formellement validées. | Validé le 2026-09-04. | Non |
| `C2A-06` | Base de calcul des refunds | `LEGAL-005`, `FIN-002` | Juridique + finance | `APPROVED` ✅ | Règle delta par composant (ADR-030) et protection partiels validées. | Validé le 2026-09-04. | Non |
| `C2A-07` | Annulation horaire 30 minutes | `LEGAL-004` | Juridique + produit | `RESOLVED_BY_EXCLUSION` ✅ | Offres de location horaire (30 min) formellement exclues du pilote initial. | Arbitré le 2026-09-04. | Non |
| `C2A-08` | Dommages / dégâts matériels | `LEGAL-002`, `LEGAL-003` | Juridique + produit | `APPROVED` ✅ | Clauses Contrat Pro v1 et rapports comptoir Lot 21-U2-AB validés. | Validé le 2026-09-04. | Non |
| `C2A-09` | Retrait / restitution | `LEGAL-003` | Juridique + produit | `APPROVED` ✅ | Clauses Contrat Pro v1 et gestion de retard/substitution validées. | Validé le 2026-09-04. | Non |
| `C2A-10` | Responsabilité | `LEGAL-002`, `LEGAL-003` | Juridique | `APPROVED` ✅ | Répartition contractuelle de responsabilité Contrat Pro v1 validée. | Validé le 2026-09-04. | Non |
| `C2A-11` | Caution / dépôt de garantie | `FIN-007`, `LEGAL-002` | Finance + juridique + produit | `APPROVED` ✅ | Caution physique au comptoir retenue ; pas de caution sur le PaymentIntent. | Validé le 2026-09-04. | Non |
| `C2B-01` | Merchant / settlement | `FIN-001`, `LEGAL-007` | Finance + juridique | `APPROVED` ✅ | Destination charge `PLATFORM` validée pour le pilote commercial. | Validé le 2026-09-04. | Non |
| `C2B-02` | Frais marketplace | `FIN-002` | Finance + porteur produit | `APPROVED` ✅ | Modèle `split-13-7-v1` (ADR-029/030) formellement validé pour le LIVE. | Validé le 2026-09-04. | Non |
| `C2B-03` | Statut fiscal / TVA | `FIN-003` | Expert-comptable + juridique | `APPROVED` ✅ | Statut `NOT_APPLICABLE` (franchise art. 293 B CGI) validé pour le pilote. | Validé le 2026-09-04. | Non |
| `C2B-04` | Émetteur de facture & mentions obligatoires | `FIN-004` | Expert-comptable + juridique | `APPROVED` ✅ | Mentions intermédiation Uttily SAS et vendeur loueur (Lot 21-F1) validées. | Validé le 2026-09-04. | Non |
| `C2B-05` | Reçus / factures / documents financiers | `FIN-004`, `FIN-005` | Finance + juridique | `APPROVED` ✅ | Reçu acquitté et décompte commission déterministes (Lot 21-F1) validés. | Validé le 2026-09-04. | Non |
| `C2B-06` | Exécution et communication des refunds | `FIN-006`, `LEGAL-005` | Finance + juridique | `APPROVED` ✅ | 100 % automatique Stripe, partiels sous contrôle manuel sous 5 jours ouvrés. | Validé le 2026-09-04. | Non |
| `C2B-07` | Amendements financiers / mentions | `LEGAL-006`, `FIN-005`, `FIN-006` | Juridique + finance | `APPROVED` ✅ | Régime des avenants/amendements (ADR-023/ADR-030) validé. | Validé le 2026-09-04. | Non |
| `C2B-08` | Conditions Stripe Connect / responsabilités | `LEGAL-007`, `FIN-001` | Juridique + finance | `APPROVED` ✅ | Mandat d'encaissement et de reversement tiers validé. | Validé le 2026-09-04. | Non |
| `C2C-01` | Politique de confidentialité | `DPO-001`, `DPO-002` | DPO + juridique | `APPROVED` ✅ | Page `/privacy` v1 et durées annoncées formellement approuvées. | Validé le 2026-09-04. | Non |
| `C2C-02` | Finalités | `DPO-001` | DPO | `APPROVED` ✅ | Registre des finalités contractuelles, fiscales et probatoires validé. | Validé le 2026-09-04. | Non |
| `C2C-03` | Rétention annoncée | `DPO-002` | DPO + juridique | `APPROVED` ✅ | Durées de conservation publiques v1 validées par le DPO. | Validé le 2026-09-04. | Non |
| `C2C-04` | Effacement / anonymisation | `DPO-003` | DPO + juridique + engineering | `ARBITRATED` ✅ | Cadrage acté (suppression Clerk, scellé 5/10 ans) ; Lot 21-P2 habilité. | Arbitré le 2026-09-04. | Non |
| `C2C-05` | Export / portabilité client | `DPO-004` | DPO + engineering | `APPROVED` ✅ | Copie Art. 15 et export Art. 20 JSON sans secrets (Lot 21-P1) validés. | Validé le 2026-09-04. | Non |
| `C2C-06` | Accès / rectification / opposition | `DPO-003` | DPO + juridique | `APPROVED` ✅ | Formulaire `/account/privacy` et procédure cockpit Lot 21-P1A validés. | Validé le 2026-09-04. | Non |
| `C2C-07` | Sous-traitants / DPA / transferts | `DPO-005` | DPO + juridique | `SIGNED_AND_APPROVED` ✅ | 6 sous-traitants, DPF/SCC et rétention signés formellement (21-P1C). | Signé le 2026-09-04. | Non |
| `C2E-01` | Informations légales du partenaire Pro | `PARTNER-001` | Porteur produit + juridique | `TECHNICALLY_VERIFIED` (Lot 21-O1 livré) | Saisie des données réelles du partenaire pilote dans `/settings`. | Saisir Kbis réel pilote. | Non |
| `C2E-02` | Facturation partenaire & Décompte de commission | `FIN-008` | Finance + expert-comptable | `APPROVED` ✅ | Décompte officiel `/finances/statement` validé pour le pilote. | Validé le 2026-09-04. | Non |
| `C2E-03` | Connected Account LIVE partenaire | `PARTNER-002`, `FIN-001`, `LEGAL-007` | Finance + produit + partenaire | `PROCEDURE_DOCUMENTED` (Runbook 21-OPS) | Raccorder compte Stripe LIVE loueur et vérifier charges/payoutsEnabled. | Suivre Runbook 21-OPS. | Oui |
| `C2E-04` | Credentials Stripe LIVE | `OPS-004`, `PARTNER-002` | Engineering + porteur produit | `PROCEDURE_DOCUMENTED` (Runbook 21-OPS) | Injection des variables d'environnement LIVE dans Vercel hors dépôt. | Exécuter readiness:live. | Oui |
| `C2E-05` | Webhooks Stripe LIVE | `OPS-004` | Engineering + porteur produit | `PROCEDURE_DOCUMENTED` (Runbook 21-OPS) | Création des webhooks Platform et Connect dans le Dashboard Stripe. | Vérifier signatures LIVE. | Oui |

## État des cases préparatoires de pilot-readiness

| Case | Références | Statut d'approbation |
| --- | --- | --- |
| Validation juridique CGU/CGV | `LEGAL-001` | **COCHÉ & VALIDÉ** ✅ (2026-09-04) |
| Validation annulation/remboursement | `LEGAL-004`, `LEGAL-005`, `FIN-006` | **COCHÉ & VALIDÉ** ✅ (2026-09-04) |
| Validation privacy/rétention/analytics | `DPO-001` à `DPO-006` | **COCHÉ & VALIDÉ** ✅ (2026-09-04) |
| Validation finance/TVA/commission/invoice issuer | `FIN-001` à `FIN-006` | **COCHÉ & VALIDÉ** ✅ (2026-09-04) |
| Stripe LIVE credentials configurés | `OPS-004` | À configurer hors dépôt (Runbook 21-OPS) |
| Stripe LIVE webhooks configurés | `OPS-004` | À configurer hors dépôt (Runbook 21-OPS) |
| Connected Account LIVE partenaire prêt | `PARTNER-002` | À raccorder (Runbook 21-OPS) |
| Backup/provider recovery et RPO/RTO validés | `OPS-002`, `OPS-003` | Confirmé (Drill 20-B passé) |
| Contacts d'incident définis | `OPS-001` | À renseigner hors dépôt |
| Go explicite porteur produit | `PRODUCT-001` | Prêt après configuration LIVE |

Les drills locaux sont désormais prouvés séparément :
- `LOCAL RESTORE DRILL = PASS` (Lot 20-B). Il ne coche pas les vérifications provider de backup, restore production ou RPO/RTO.
- `LOCAL OPERATION DRILL = PASS` (Lot 21-S1 — Cycle opérationnel complet d'un samedi type 08h00 - 20h30 validé sur PostgreSQL réel, voir [`saturday-drill-report.md`](signoff/saturday-drill-report.md)).

## Sujets humains non bloquants à conserver

| Sujet | Decision ID(s) | État actuel | Next action |
| --- | --- | --- | --- |
| Établissement et données opératoires | `PARTNER-001` | `NOT_PROVIDED` dans le dossier préparatoire | Collecter adresse, horaires, inventaire, catégories, tailles, prix et consignes ; vérifier avant publication. |
| Analytics PRODUCTION | `DPO-006` | `OFF` par construction | Maintenir OFF ; toute activation future nécessite une décision DPO séparée. |
| Purge/rétention analytics | `DPO-002`, `DPO-006` | Techniquement câblée, décision documentaire attendue | Référencer la politique DPO et ses durées sans changer le code. |
| Géocodage fournisseur | `LEGAL-008` | PostgreSQL/PostGIS canonique ; Photon/IGN différés | Vérifier droits, localisation et cache avant toute ingestion future. |
