# Plan de déblocage du premier pilote — 21-P0

**Référence de version :** document vivant ; vérifier le commit courant du dépôt
avant utilisation. Les anciennes baselines `origin/main = ...` sont historiques.
**Dernière revue de cohérence :** 2026-08-30
**Statut :** préparation externe complète ; aucune décision humaine n'est prise dans ce document.

Ce plan reprend les **31 sujets** marqués `Bloque pilote = Oui` dans
[`pilot-readiness.md`](pilot-readiness.md). Chaque ligne renvoie à un ou
plusieurs identifiants canoniques du
[`decision-registry.md`](decision-registry.md). Une décision préparée n'est pas
une décision approuvée.

## Blockers pilote

| Blocker ID | Sujet | Decision ID(s) | Owner | État | Evidence | Next action | Blocking pilot |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `C2A-01` | CGU / CGV client absentes | `LEGAL-001` | Juridique + porteur produit | `TECHNICALLY_VERIFIED` (Lot 21-L1 livré) | Pages publiques publiées (`/terms`, `/rental-terms`, `/legal`, alias `/cgu`, `/cgv`) dans `apps/web/` et notice opposable liée au paiement dans le checkout. | Sign-off juridique humain formel sur le texte publié (`LEGAL-001`). | Oui |
| `C2A-02` | Version des terms | `LEGAL-001` | Juridique | `TECHNICALLY_VERIFIED` (Lot 21-L1 livré) | `legalTermsVersion: 'v1'` côté serveur (`payment-config.ts`) et `v1` envoyé par le checkout. | Confirmation formelle de la version active v1 par le juridique. | Oui |
| `C2A-03` | Snapshot d'acceptation | `LEGAL-001` | Juridique + porteur produit | `TECHNICALLY_VERIFIED` (Lot 21-L1 livré) | `terms_acceptance_snapshot` persiste `{ termsVersion, userId, acceptedAt }` avec validation fail-closed, lié aux documents v1 publiés. | Sign-off juridique sur la chaîne d'opposabilité. | Oui |
| `C2A-04` | Conditions Pro / contrat loueur absents | `LEGAL-002` | Juridique + porteur produit | `TECHNICALLY_VERIFIED` (Lot 21-L2 livré) | Contrat loueur bilingue publié sur `/pro-terms` (v1) et case de consentement obligatoire dans l'onboarding organisation avec audit log immuable. | Sign-off juridique formel sur le contrat Pro (`LEGAL-002`). | Oui |
| `C2A-05` | Politiques d'annulation | `LEGAL-004`, `LEGAL-005` | Juridique + finance + produit | `READY_FOR_HUMAN_DECISION` | Le code applique `FLEXIBLE`/`MODERATE`/`FIRM` et la grâce `GRACE_WINDOW_24H`; Lot 4 reste en attente. | Valider seuils, grâce, exceptions et base remboursable par écrit. | Oui |
| `C2A-06` | Base de calcul des refunds | `LEGAL-005`, `FIN-002` | Juridique + finance | `TECHNICALLY_VERIFIED` (ADR-030 livré) | Calcul composant par composant (`HALF_UP_PER_COMPONENT`), déblocage de `previewBookingCancellation` et persistance du delta livré. Annulation 100 % exécutable Stripe ; annulation partielle routée en `FAILED_REQUIRES_MANUAL_ACTION`. | Sign-off Finance/Juridique sur la politique de delta et les seuils de remboursement. | Oui |
| `C2A-07` | Annulation horaire 30 minutes | `LEGAL-004` | Juridique + produit | `READY_FOR_HUMAN_DECISION` | Aucun calcul horaire de 30 minutes n'est implémenté ; question G7B-R3 ouverte. | Confirmer une règle horaire ou exclure les offres horaires du pilote ; déclencher le chantier code seulement après. | Oui |
| `C2A-08` | Dommages / dégâts matériels | `LEGAL-002`, `LEGAL-003` | Juridique + produit | `READY_FOR_HUMAN_DECISION` | `damage_reports`, `condition_reports`, `maintenance_cases` existent ; aucun barème ni clause n'est fixé. | Valider responsabilité, preuve d'état, barème, délais et contestation. | Oui |
| `C2A-09` | Retrait / restitution | `LEGAL-003` | Juridique + produit | `READY_FOR_HUMAN_DECISION` | Les états fulfillment existent ; les clauses de retard, état des lieux et litige manquent. | Documenter les clauses correspondant au parcours réellement opéré. | Oui |
| `C2A-10` | Responsabilité | `LEGAL-002`, `LEGAL-003` | Juridique | `READY_FOR_HUMAN_DECISION` | Aucun mécanisme technique ne tranche responsabilité, limitation ou transfert. | Attribuer contractuellement les responsabilités et exclusions du pilote. | Oui |
| `C2A-11` | Caution / dépôt de garantie | `FIN-007`, `LEGAL-002` | Finance + juridique + produit | `READY_FOR_HUMAN_DECISION` | Le modèle liste six stratégies ; ADR-010 exclut la caution du PaymentIntent ; aucune stratégie n'est choisie. | Choisir une stratégie ou confirmer `NO_DEPOSIT`/exclusion pilote, avec montant, durée et responsabilité. | Oui |
| `C2B-01` | Merchant / settlement | `FIN-001`, `LEGAL-007` | Finance + juridique | `READY_FOR_HUMAN_DECISION` | Destination charge ; code `PLATFORM`, `onBehalfOfAccountId: null`; Lot 5-A non rendu. | Répondre aux six questions de responsabilité et confirmer le modèle contractuel. | Oui |
| `C2B-02` | Frais marketplace | `FIN-002` | Finance + porteur produit | `READY_FOR_HUMAN_DECISION` | Décision produit enregistrée dans `ADR-029` : `split-13-7-v1`, base `subtotal + mandatory fees`, frais loueur 13 % + frais service client 7 %, `HALF_UP_PER_COMPONENT`, sans fixe. La politique de remboursement par delta est proposée dans `ADR-030`. Non approuvé LIVE. | Valider base fiscale, date d'effet, TVA, frais Stripe, refunds, chargebacks, litiges, soldes négatifs et responsabilités. | Oui |
| `C2B-03` | Statut fiscal / TVA | `FIN-003` | Expert-comptable + juridique | `READY_FOR_HUMAN_DECISION` | **CURRENT CODE BEHAVIOR :** `NOT_APPLICABLE`, montant et taux null ; la valeur est hard-codée. | Répondre `APPLIED` ou `NOT_APPLICABLE`, avec règle, taux, entité et date d'effet. | Oui |
| `C2B-04` | Émetteur de facture & mentions obligatoires | `FIN-004` | Expert-comptable + juridique | `TECHNICALLY_VERIFIED` (Lot 21-F1 livré) | Mentions légales loueur (SIRET, RCS, TVA ou art. 293 B, siège social, forme juridique) et intermédiation Uttily SAS intégrées aux reçus et contrats PDF. | Validation formelle des modèles par l'expert-comptable. | Non (technique levé) |
| `C2B-05` | Reçus / factures / documents financiers | `FIN-004`, `FIN-005` | Finance + juridique | `TECHNICALLY_VERIFIED` (Lot 21-F1 livré) | Reçu acquitté, contrat de location et confirmation PDF générés déterministement ; accès client (`/account`) et loueur (`/dashboard/.../documents/`) livrés. | Validation du catalogage comptable final. | Non (technique levé) |
| `C2B-06` | Exécution et communication des refunds | `FIN-006`, `LEGAL-005` | Finance + juridique | `READY_FOR_HUMAN_DECISION` | Worker/cron et compensation tardive existent ; `ADR-030` propose un traitement manuel sous 5 jours ouvrés, avec messages distincts avant/après application. | Approuver délai, texte, frais non récupérables, notification loueur et escalade. | Oui |
| `C2B-07` | Amendements financiers / mentions | `LEGAL-006`, `FIN-005`, `FIN-006` | Juridique + finance | `READY_FOR_HUMAN_DECISION` | G7M/ADR-023 livrés ; `ADR-030` propose le delta entre états effectifs et la répartition client/loueur/Uttily ; mentions et fiscalité restent à valider. | Valider les mentions et le traitement de chaque scénario amendement/refund/supplément. | Oui |
| `C2B-08` | Conditions Stripe Connect / responsabilités partenaire | `LEGAL-007`, `FIN-001` | Juridique + finance | `READY_FOR_HUMAN_DECISION` | ADR-010/024/025 et projection serveur existent ; acceptation partenaire non tracée dans Uttily. | Obtenir la preuve d'acceptation et confirmer la répartition frais/pertes/litiges. | Oui |
| `C2C-01` | Politique de confidentialité absente | `DPO-001`, `DPO-002` | DPO + juridique | `TECHNICALLY_VERIFIED` (Lot 21-L1 livré) | Page publique bilingue publiée (`/privacy`, alias `/politique-de-confidentialite`), responsable, contact DPO, droits et sous-traitants listés. | Sign-off formel DPO/Juridique sur la politique de confidentialité (`DPO-001`). | Oui |
| `C2C-02` | Finalités | `DPO-001` | DPO | `READY_FOR_HUMAN_DECISION` | Aucun registre des finalités ; le code ne permet pas d'inférer une base juridique. | Remplir le registre des traitements avec finalité, personne, responsable et base choisie. | Oui |
| `C2C-03` | Rétention annoncée | `DPO-002` | DPO + juridique | `TECHNICALLY_VERIFIED` (Lot 21-L1 livré) | Durées annoncées aux personnes dans la politique de confidentialité publiée (v1) ; purge analytics exécutable. | Validation formelle des durées par le DPO (`DPO-002`). | Oui |
| `C2C-04` | Effacement / anonymisation | `DPO-003` | DPO + juridique + engineering | `LEGAL: PENDING_DPO_DECISION` · `TECH: REQUEST_INTAKE_ONLY` (Lot 21-P1) | Table `privacy_requests` (0058), formulaire client et runbook 21-P1 livrés ; mécanisme effectif d'effacement/pseudonymisation différé au chantier dédié P2. | Décision formelle DPO-003 sur les données conservées/anonymisables avant lot P2 `PRIVACY-ERASURE`. | Oui |
| `C2C-05` | Export / portabilité client | `DPO-004` | DPO + engineering | `LEGAL: PENDING_DPO_SCOPE` · `TECH: IMPLEMENTED_AWAITING_VALIDATION` (Lot 21-P1) | Endpoint `/api/account/privacy/export` scindé en copie intégrale Art. 15 et dataset portable Art. 20 (sans IDs Stripe ni URLs R2). | Validation formelle par le DPO du périmètre Art. 20 et des exclusions. | Oui |
| `C2C-06` | Accès / rectification / opposition | `DPO-003` | DPO + juridique | `LEGAL: PENDING_DPO_DECISION` · `TECH: REQUEST_INTAKE_IMPLEMENTED` (Lot 21-P1) | Page client bilingue `/[locale]/account/privacy`, suivi des demandes (+1 mois calendaire), audit minimaliste ADR-016 et runbook opérateur livrés. | Validation de la procédure d'instruction et des motifs de refus fermés par le DPO. | Oui |
| `C2C-07` | Sous-traitants / DPA / transferts | `DPO-005` | DPO + juridique | `READY_FOR_HUMAN_DECISION` | Fournisseurs identifiés ; DPA, localisation et transfert non vérifiés dans la base. | Vérifier chaque fournisseur avec propriétaire, méthode, document et résultat. | Oui |
| `C2E-01` | Informations légales du partenaire Pro | `PARTNER-001` | Porteur produit + juridique | `TECHNICALLY_VERIFIED` (Lot 21-O1 livré) | Modèle BDD, validation Luhn/TVA, audit trail et écran de saisie livrés (0057). | Saisir les données réelles du partenaire pilote dans l'espace Pro et valider l'exactitude du Kbis. | Non (technique levé) |
| `C2E-02` | Facturation partenaire & Décompte de commission | `FIN-008` | Finance + expert-comptable | `TECHNICALLY_VERIFIED` (Lot 21-F1 livré) | Décompte officiel de commission et de reversement avec mentions légales Uttily/Loueur générable depuis `/finances` (`/statement`). | Validation du rythme de versement et des seuils comptables. | Non (technique levé) |
| `C2E-03` | Connected Account LIVE partenaire | `PARTNER-002`, `FIN-001`, `LEGAL-007` | Finance + produit + partenaire | `PROCEDURE_DOCUMENTED` (Runbook 21-OPS) | Readiness vérifie projection serveur, `chargesEnabled`/onboarding ; runbook [`21-ops-stripe-live-activation.md`](../runbooks/21-ops-stripe-live-activation.md) disponible. | Terminer onboarding autorisé, vérifier compte/capacités par webhook et conserver une preuve non secrète. | Oui |
| `C2E-04` | Credentials Stripe LIVE | `OPS-004`, `PARTNER-002` | Engineering + porteur produit | `PROCEDURE_DOCUMENTED` (Runbook 21-OPS) | Variables d'environnement répertoriées ; procédure d'injection Vercel et vérification hors-secret documentées. | Configurer hors dépôt après clôture des décisions, puis exécuter `pnpm readiness:live`. | Oui |
| `C2E-05` | Webhooks Stripe LIVE | `OPS-004` | Engineering + porteur produit | `PROCEDURE_DOCUMENTED` (Runbook 21-OPS) | Routes et garde-fous existent ; procédure de création Dashboard Stripe et IP allow-list documentées. | Créer/configurer les endpoints Platform et Connect, fournir les secrets au runtime hors dépôt et vérifier les signatures. | Oui |

## Cases préparatoires encore non cochées

Les dix cases de `pilot-readiness.md` restent non cochées jusqu'à preuve
humaine ou opérationnelle :

| Case | Références |
| --- | --- |
| Validation juridique CGU/CGV | `LEGAL-001` |
| Validation annulation/remboursement | `LEGAL-004`, `LEGAL-005`, `FIN-006` |
| Validation privacy/rétention/analytics | `DPO-001` à `DPO-006` |
| Validation finance/TVA/commission/invoice issuer | `FIN-001` à `FIN-006` |
| Stripe LIVE credentials configurés | `OPS-004` |
| Stripe LIVE webhooks configurés | `OPS-004` |
| Connected Account LIVE partenaire prêt | `PARTNER-002` |
| Backup/provider recovery et RPO/RTO validés | `OPS-002`, `OPS-003` |
| Contacts d'incident définis | `OPS-001` |
| Go explicite porteur produit | `PRODUCT-001` |

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
