# Lot 21-P1A — Traçabilité de Provenance Git, Migrations & Concurrence

Ce document formalise la généalogie Git, les dépendances de schéma de base de données et les preuves techniques pour le **Lot 21-P1A — Privacy Request Operations (`/internal/privacy`)**.

---

## 1. Arbre de dépendance Git & Baseline

```text
origin/main (commit 01236001fd81e1777e20c582789e579bc7da235c)
 │
 ├── [Prérequis 1 : Lot 21-O1] Mentions légales & Fiche loueur
 │    └── Migration 0057_organization_legal_and_tax_identity.sql
 │
 ├── [Prérequis 2 : Lot 21-P1 Fondation] Registre RGPD & Intake client
 │    └── Migration 0058_privacy_requests.sql
 │         ├── Enums : privacy_request_type, privacy_request_status, privacy_resolution_status, privacy_decision_reason
 │         └── Table : privacy_requests
 │
 └── [Lot 21-P1A : Cockpit Opérationnel Support]
      ├── Extension gouvernance Art. 12.3 & 12.4 dans migration 0058 :
      │    ├── decision_at, decision_by_user_id, response_notified_at, response_notified_by_user_id
      │    ├── extension_reason, extended_at, extended_by_user_id, extension_notified_at
      │    ├── Invariant CHECK privacy_requests_decision_consistency (IN_REVIEW -> DECISION_READY -> COMPLETED)
      │    └── Invariant CHECK privacy_requests_extension_consistency (prorogation max +2 mois calendaires)
      ├── Core : packages/core/src/support/privacy/
      │    ├── types.ts, list-privacy-requests.ts, manage-privacy-requests.ts
      ├── Web : apps/web/src/app/internal/privacy/ & apps/web/src/features/internal/privacy-support-view.tsx
      ├── Server Actions : apps/web/src/app/actions/support-privacy.ts
      └── Preuves PostgreSQL réelles : packages/core/src/integration/privacy-concurrency.integration.test.ts
```

### Séquence recommandée pour les Pull Requests (PR)

1. **PR 1 — Lot 21-O1** : Identification légale loueur & mentions légales (Migration 0057).
2. **PR 2 — Lot 21-P1** : Fondation RGPD client & registre des demandes (Migration 0058).
3. **PR 3 — Lot 21-P1A** : Cockpit régalien `/internal/privacy`, Server Actions, gestion de la décision interne, attestation d'envoi et clôture effective.

*(Alternative : une branche d'intégration unique `feat/pilot-phase-21` combinant 0057 et 0058 avant merge sur `main`).*

---

## 2. Preuves PostgreSQL réelles de Concurrence, Invariants & Clôture

Conformément à `AGENTS.md`, la gestion de la concurrence critique et les garanties d'atomicité transactionnelle ont été éprouvées sur un moteur PostgreSQL réel (`setupIntegrationTestDb`) dans [`packages/core/src/integration/privacy-concurrency.integration.test.ts`](file:///Users/hamza/Projects/Uttily/packages/core/src/integration/privacy-concurrency.integration.test.ts) (**7 suites d'intégration réelles réussies**) :

| Preuve testée | Scénario & Mécanisme | Résultat PostgreSQL réel |
| --- | --- | --- |
| **P1.1 — Concurrence réelle** | Deux connexions indépendantes (`dbA` et `dbB`) tentent simultanément d'enregistrer une décision (`FULFILLED` vs `REFUSED`). Verrou pessimiste `FOR UPDATE`. | **PASS** : Une seule transaction s'applique, la seconde échoue avec `INVALID_STATE_TRANSITION`. Zéro écrasement silencieux. |
| **P1.2 — Rollback transactionnel** | Échec forcé lors de l'appel à `writeAuditEntry` au sein de la transaction. | **PASS** : La mutation de `privacy_requests` est 100% rollbackée. La demande conserve son état intact (`RECEIVED`). |
| **P1.3 — Notification tardive (> responseDueAt)** | Attestation de notification d'extension saisie après l'échéance nominale de 1 mois. Art. 12.3 RGPD. | **PASS** : Ne régularise JAMAIS rétroactivement le premier délai. `extensionCompliance` bascule en `NOTIFIED_LATE`, l'échéance effective reste `responseDueAt` et la demande demeure marquée `DUE_OVERDUE`. |
| **P1.4 — Distinction Décision interne vs Clôture effective (Art. 12.3 & 12.4)** | Transition `IN_REVIEW` -> `DECISION_READY` (demande reste ouverte au cockpit) puis `recordPrivacyResponseNotification` -> `COMPLETED` (boucle d'information fermée). | **PASS** : Clôture impossible avant décision arrêtée. Le premier timestamp `responseNotifiedAt` est immuable face aux retries (idempotence probante). |
| **P2.1 — Invariants structurels CHECK PostgreSQL** | Tentatives d'insertion d'états illégaux (COMPLETED sans notification, COMPLETED sans résolution, REFUSED sans motif, DECISION_READY avec notification, RECEIVED avec résolution). | **PASS** : Rejet catégorique au niveau moteur PostgreSQL (`privacy_requests_decision_consistency`). |
| **P2.2 — Parité calendaire TS vs PostgreSQL** | Test comparatif sur fins de mois et années bissextiles (31 janv. 2024 bissextile, 31 janv. 2025, 31 mars, 31 mai, 31 août, 31 oct.). | **PASS** : Correspondance exacte entre `addCalendarMonths(d, 2)` et PostgreSQL `interval '2 months'` (acceptation de la borne exacte, rejet de tout dépassement d'une seconde). |
| **P2.3 — Idempotence exhaustive** | Répétition identique sur `flagIdentityCheck`, `extendDeadline`, `recordExtensionNotification`, et `resolvePrivacyRequest`. | **PASS** : Zéro audit dupliqué, conservation stricte des premiers timestamps historiques, et conflit explicite sur intention divergente. |
| **P2.4 — Invariant de traçabilité hors délai** | Une demande répondue tardivement devient `COMPLETED`, mais sa clôture ne doit jamais effacer le fait qu’elle a été répondue hors délai (`responseNotifiedAt > effectiveDueAt`). | **PASS** : La propriété dérivée `responseCompliance: 'RESPONSE_LATE'` demeure gravée dans le modèle de lecture et affichée dans le cockpit `CLOSED`. |

---

## 3. Règle régalienne d'audit sans PII

Conformément aux directives :
- Les notes internes d'instruction et les textes libres rédigés par les demandeurs **ne sont jamais recopiés** dans `audit_log.metadata`.
- Les métadonnées auditées sont strictement restreintes aux identifiants techniques et aux codes d'état : `{ requestId, previousStatus, newStatus, resolution, decisionReasonCode }`.
- L'audit trace l'auteur via `actorUserId` et la cible via `targetId: requestId`.

---

## 4. Statut de Sign-off & Portée

> **Le lot 21-P1A dispose désormais des garanties techniques, transactionnelles et de traçabilité prévues pour le cockpit Privacy, avec un workflow aligné sur les exigences RGPD identifiées. Les décisions de conformité et le périmètre d’exécution des droits restent soumis aux validations DPO/Juridique prévues.**

- **Statut** : `21-P1A — APPROVED_FOR_MERGE` ✅
- **Prochaine étape** : Lot `21-P1B` (arbitrages DPO-003/DPO-004 et exécution matérielle des droits).
