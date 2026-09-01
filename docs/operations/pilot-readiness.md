# Pilot Readiness — Matrice unique de clôture avant pilote réel

**Chantier :** 21-P0 — External Decision Preparation (matrice héritée du Chantier 20-C)
**Branche :** `chantier/21-p0-external-decisions`
**Référence de version :** document vivant ; vérifier le commit courant du dépôt
avant utilisation. Les anciennes baselines `origin/main = ...` sont historiques.
**Dernière revue de cohérence :** 2026-08-30
**Date d'établissement :** 2026-08-28
**Mise à jour 21-P0 :** 2026-08-29

## Statut de ce document

Ce document est la **source de vérité unique** de la clôture avant le premier
pilote réel. Toute question de type « peut-on lancer le pilote ? » se répond
ici, et nulle part ailleurs.

> **Avertissement — ce chantier ne donne AUCUN avis juridique.**
> Il recense, qualifie et relie des preuves. Il ne valide aucune conformité. Il
> ne se substitue à aucun avocat, expert-comptable ou DPO.

**Règle absolue :** un sujet marqué `HUMAN_SIGNOFF_REQUIRED` ne devient
**jamais** `APPROVED` sans une preuve humaine explicite **déjà présente** dans
le dépôt (décision écrite, référencée et datée). L'absence de validation n'est
jamais une validation.

## États autorisés

| État | Signification |
| --- | --- |
| `TECHNICALLY_VERIFIED` | Mécanisme présent, exécutable et prouvé par le code ou les tests. Ne préjuge en rien de sa validité juridique. |
| `HUMAN_SIGNOFF_REQUIRED` | Validation humaine écrite attendue. Aucun défaut technique, aucune valeur par défaut et aucune absence de réponse ne peut s'y substituer. |
| `APPROVED` | Validation humaine explicite **déjà présente** dans le dépôt, référencée dans la colonne preuve. |
| `BLOCKED` | Capacité absente ou incohérence majeure : un chantier de construction ou une décision préalable est requis avant toute évaluation. |
| `NOT_APPLICABLE` | Hors périmètre du premier pilote, sans risque résiduel identifié à ce stade. |

## Résumé de clôture

**39 sujets** sont inventoriés, chacun portant deux états : l'état technique et
l'état documentaire.

| État | État technique | État documentaire |
| --- | --- | --- |
| `APPROVED` | **0** | **0** |
| `TECHNICALLY_VERIFIED` | 25 | 0 |
| `HUMAN_SIGNOFF_REQUIRED` | 0 | 25 |
| `BLOCKED` | 8 | 11 |
| `NOT_APPLICABLE` | 6 | 3 |

Un sujet n'est clos que lorsque **ses deux états** valent `APPROVED`.

**Aucun sujet n'est `APPROVED`, dans aucune des deux colonnes.** Aucune preuve
de validation humaine écrite (juridique, comptable, DPO) n'existe dans le dépôt
à la base `eb08f2830abad5fd6643978aee6056e6e59e7171`.

**Verdict : le premier pilote réel est bloqué.** 31 sujets sur 39 bloquent le
pilote (`Bloque pilote = Oui`).

## Préparation des décisions externes — Chantier 21-P0

La préparation externe est complète, mais aucune décision humaine n'est
approuvée par cette matrice :

| Statut | Valeur | Référence |
| --- | --- | --- |
| `TECHNICAL_READY` | Repris de la preuve du Chantier 20, non recalculé ici | [`mvp-pilot-readiness.md`](../implementation/mvp-pilot-readiness.md) |
| `EXTERNAL_DECISION_READY` | `PASS` | [`decision-registry.md`](decision-registry.md), [`pilot-unblock-plan.md`](pilot-unblock-plan.md) |
| `EXTERNAL_SIGNOFF_READY` | `BLOCKED` | Les réponses humaines restent absentes |
| `PILOT_READY` | `BLOCKED` | Les 31 blockers et les cases préparatoires restent ouverts |

Packs de décision : [`legal-decision-pack.md`](signoff/legal-decision-pack.md),
[`finance-decision-pack.md`](signoff/finance-decision-pack.md),
[`privacy-decision-pack.md`](signoff/privacy-decision-pack.md) et
[`subprocessors-inventory.md`](signoff/subprocessors-inventory.md).
La collecte partenaire et l'exécution opérateur sont préparées dans
[`pilot-partner-readiness.md`](pilot-partner-readiness.md) et
[`live-operator-checklist.md`](live-operator-checklist.md).

**Règle absolue 21-P0 :** les valeurs techniques existantes (`v1`,
`NOT_APPLICABLE`, `invoiceIssuer: Uttily`, taux documenté), les états provider
et le drill local ne valent pas une approbation humaine ou commerciale.

---

## C2.A — Contractuel / client

| Sujet | État technique | État documentaire | Owner du sign-off | Preuve / lien | Bloque pilote |
| --- | --- | --- | --- | --- | --- |
| CGU / CGV (texte client) | `TECHNICALLY_VERIFIED` | `BLOCKED` | Juridique + Porteur produit | Version et snapshot persistés et validés (`payments.legal_terms_version`, `bookings.legal_terms_version`, `terms_acceptance_snapshot` ; validation règle 15 dans `packages/core/src/financial-terms/resolve-financial-terms.ts:215`). **Aucun texte de CGU/CGV n'existe** : aucune page, aucun fichier, aucune occurrence dans `apps/`, `packages/` ou `public/`. | **Oui** |
| Versions des terms | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Juridique | Version `v1` codée en dur côté serveur (`apps/web/src/lib/payment-config.ts`, `legalTermsVersion: 'v1'`) et côté client (`apps/web/src/features/checkout/checkout-client.tsx:219`). Voir C3-F1. | **Oui** |
| Snapshot d'acceptation | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Juridique | `{ termsVersion, userId, acceptedAt }` persisté (`packages/database/src/schema.ts:1133-1134`, `1312`). Le snapshot est une tautologie : il prouve l'acceptation d'un document inexistant. Voir C3-F1. | **Oui** |
| Conditions Pro (contrat loueur) | `BLOCKED` | `BLOCKED` | Juridique + Porteur produit | Aucun mécanisme d'acceptation des conditions Pro, aucun texte. Aucune occurrence détectée. | **Oui** |
| Annulation — politiques | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Juridique | Implémentation conforme aux tableaux Lot 4 : `FLEXIBLE` / `MODERATE` / `FIRM` dans `packages/core/src/cancellations/preview-booking-cancellation.ts:139-178`, fenêtre de grâce `GRACE_WINDOW_24H` (≥ 7 j d'avance, ≤ 24 h après confirmation) lignes 134-138, fuseau IANA du lieu de retrait. Document de validation `docs/product/lot4-legal-validation.md` — statut « en attente de validation juridique ». | **Oui** |
| Remboursement — base de calcul | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Juridique + Finance | Le legacy conserve l'option A historique (total TTC) dans `preview-booking-cancellation.ts`. Pour le split 13/7, le parcours est fail-closed ; la proposition de delta entre états effectifs, composant par composant, est formalisée dans `ADR-030` et reste soumise au sign-off. Voir C3-F2. | **Oui** |
| Annulation — fenêtre horaire 30 min | `BLOCKED` | `HUMAN_SIGNOFF_REQUIRED` | Juridique + Produit | Non implémentée. Question ouverte G7B-R3 : « Règles juridiques exactes des annulations horaires (30 min) — Ouvert — bloque activation production ». `docs/implementation/open-questions.md`. | **Oui** (location horaire) |
| Dommages / dégâts matériels | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Juridique | Table `damageReports` et `maintenanceCases` exposées dans le back-office (ADR-028 §3). Aucune règle contractuelle de responsabilité ni barème documenté. | **Oui** |
| Pickup / return (retrait / restitution) | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Juridique + Produit | Machine à états de fulfillment (ADR-011, ADR-012) : `READY_FOR_PICKUP` → retrait → restitution/clôture. Aucune clause contractuelle sur les retards, l'état des lieux ou la contestation. | **Oui** |
| Responsabilité | `NOT_APPLICABLE` | `HUMAN_SIGNOFF_REQUIRED` | Juridique | Aucun mécanisme technique de limitation ou de transfert de responsabilité. Relevant intégralement du contrat à produire. | **Oui** |
| Caution / dépôt de garantie | `NOT_APPLICABLE` | `HUMAN_SIGNOFF_REQUIRED` | Finance + Juridique | Modèle de données prêt (`CARD_AUTHORIZATION`, `EXTENDED_AUTHORIZATION`, `CARD_ON_FILE`, `INSURANCE`, `EXTERNAL_DEPOSIT`, `NO_DEPOSIT`). Aucune stratégie choisie : Lot 5 décision F en attente. | **Oui** |

## C2.B — Finance

| Sujet | État technique | État documentaire | Owner du sign-off | Preuve / lien | Bloque pilote |
| --- | --- | --- | --- | --- | --- |
| Merchant / settlement model | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Finance + Juridique | `settlementMerchantMode: 'PLATFORM'` par défaut (`packages/core/src/connected-accounts/create-connected-account.ts:146`) ; `onBehalfOfAccountId` systématiquement `null` (`apps/web/src/app/actions/payments.ts:105`). Lot 5 décision A (questions 1-6) non rendue. | **Oui** |
| Commission — règle commerciale | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Finance + Porteur produit | `ADR-029` et le registre serveur implémentent `split-13-7-v1` : base `subtotal + mandatory fees`, 13 % frais loueur + 7 % service client, `HALF_UP_PER_COMPONENT`, sans fixe, snapshots immuables et deltas par composant. Le choix produit ne vaut pas sign-off Finance/Juridique ; base fiscale, TVA, frais Stripe, refunds et date d'effet restent à rendre (`FIN-002`). | **Oui** |
| TVA / fiscalité — statut de taxe | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Expert-comptable + Juridique | **`status: 'NOT_APPLICABLE'` codé en dur** avec `amountMinor: null` et `rateBps: null` (`apps/web/src/lib/payment-config.ts`). Or Lot 5 décision C demande explicitement au validateur de trancher « si la taxe est `APPLIED` ou `NOT_APPLICABLE` ». Le code pré-décide. Voir C3-F3. | **Oui** |
| Invoice issuer (émetteur de facture) | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Expert-comptable + Juridique | **`invoiceIssuer: 'Uttily'` codé en dur** (`apps/web/src/lib/payment-config.ts`) et propagé dans `TaxRuleSnapshot`. Lot 5 décision C-2 demande « qui émet la facture ou le reçu de location ». Voir C3-F3. | **Oui** |
| Reçus / factures (documents) | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Expert-comptable + Juridique | Pipeline de documents transactionnels livré (ADR-013, ADR-015) : génération PDF, snapshot immuable, `tax_status` / `tax_amount_minor` / `tax_rate_bps` transportés (`load-document-render-data.ts:232`, `534`). Mentions légales obligatoires non définies (Lot 5 §4 point 7). | **Oui** |
| Refunds (exécution) | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Finance + Juridique | Worker et cron d'exécution des remboursements (G7M B2B2 / B2B2B) ; compensation intégrale des paiements tardifs (`docs/implementation/g7m-b2b2a-refund-execution.md`, `g7m-c4b-supplement-compensation.md`). `ADR-030` propose le délai, les messages et la résolution manuelle ; l'exécution split par composant reste à construire et valider. | **Oui** |
| Amendements financiers — mentions légales | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Juridique + Finance | ADR-023 acceptée, G7M C1–C5 implémentés et fusionnés. `ADR-030` propose la base split et les états d'échec ; restent à valider explicitement les mentions légales des documents amendés, la fiscalité des suppléments/remboursements et le délai/message client. | **Oui** |
| Stripe Connect terms | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Juridique + Finance | Destination charge (ADR-010), onboarding Express France (ADR-024) et embarqué (ADR-025). Acceptation par le partenaire des conditions Stripe Connect non tracée dans la matrice Uttily. | **Oui** |
| Fiscalité hors France | `NOT_APPLICABLE` | `NOT_APPLICABLE` | — | Périmètre pilote = France / Lyon, EUR uniquement (`docs/implementation/mvp-pilot-readiness.md`). Question ouverte G7B-R3 « Fiscalité par pays » reste fermée pour le pilote. | Non |

## C2.C — Privacy

| Sujet | État technique | État documentaire | Owner du sign-off | Preuve / lien | Bloque pilote |
| --- | --- | --- | --- | --- | --- |
| Politique de confidentialité | `BLOCKED` | `BLOCKED` | DPO + Juridique | **Aucune politique de confidentialité publiable n'existe dans l'application** : aucune page ni aucun fichier de politique sous `apps/`, `packages/` ou `public/`. La présente matrice ne constitue pas une politique. | **Oui** |
| Finalités | `NOT_APPLICABLE` | `BLOCKED` | DPO | Aucun registre des finalités. Non déductible du code : le code dit *ce qui est fait*, jamais *pour quelle finalité déclarée*. | **Oui** |
| Rétention — annonce aux personnes | `TECHNICALLY_VERIFIED` | `BLOCKED` | DPO | Rétention analytics techniquement implémentée (90 j raw / 24 mois agrégats, ADR-022). **Non annoncée nulle part** faute de politique de confidentialité. | **Oui** |
| Suppression / effacement | `BLOCKED` | `BLOCKED` | DPO + Juridique + Engineering | **Aucun mécanisme n'existe.** Zéro occurrence de « anonymisation », « effacement », « suppression de compte », « erasure » ou « GDPR/RGPD » dans `packages/` et `apps/`. Voir C4-F1. | **Oui** |
| Export des données personnelles (portabilité) | `BLOCKED` | `BLOCKED` | DPO + Engineering | Seul export existant : CSV financier **du loueur** (`apps/web/src/app/api/dashboard/[orgId]/finances/export-csv/route.ts`). Aucun export des données d'un utilisateur client. Voir C4-F2. | **Oui** |
| Droits utilisateurs (accès, rectification, opposition) | `BLOCKED` | `BLOCKED` | DPO | Aucun mécanisme, aucun point d'entrée, aucune procédure documentée. | **Oui** |
| Sous-traitants (registre) | `NOT_APPLICABLE` | `BLOCKED` | DPO + Juridique | Sous-traitants techniquement identifiables (Stripe, Clerk, Neon, Vercel, Cloudflare R2, Resend) mais **aucun registre, aucune qualification, aucune vérification de localisation des données**. Aucun DPA référencé. | **Oui** |
| Géocodage — conformité fournisseur | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Juridique + Technique | ADR-027 retient PostgreSQL/PostGIS pour le runtime canonique ; Photon reste candidat d'enrichissement avec hébergement, droits de réutilisation et cache à valider avant ingestion (`docs/implementation/open-questions.md`). | Non |

## C2.D — Analytics

| Sujet | État technique | État documentaire | Owner du sign-off | Preuve / lien | Bloque pilote |
| --- | --- | --- | --- | --- | --- |
| Analytics PRODUCTION verrouillé | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | DPO | Triple verrou, non contournable par configuration : (1) `resolveAnalyticsEnvironment` retourne `DISABLED` pour `PRODUCTION` en dur (`packages/core/src/product-analytics/runtime.ts`) ; (2) `MaintenanceAnalyticsEnvironment = Exclude<AnalyticsEnvironment, 'PRODUCTION'>` — un oubli ne compile pas (`apps/web/src/lib/product-analytics-maintenance.ts`) ; (3) `productionCollectionEnabled: false` constant (ADR-022 §2.6 amendée, Chantier 18-A). | Non (reste OFF) |
| Analytics first-party agrégés | `TECHNICALLY_VERIFIED` | `NOT_APPLICABLE` | — | Aucun provider externe (ADR-022 §2.1). Quatre compteurs entiers (`searches`, `searchesWithResults`, `bookingAttempts`, `bookingsConfirmed`), aucune dimension démographique, géographique ou identifiante. | Non |
| Purge / rétention analytics exécutable | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | DPO | `purgeExpiredProductAnalytics` traite raw (90 j) **et** agrégats (24 mois) avec compaction additive, advisory locks et ordre de verrouillage déterministe (`packages/core/src/product-analytics/purge.ts`). Exécuté par le cron Vercel quotidien `17 3 * * *` sur `/api/cron/process-product-analytics`, authentifié fail-closed par `CRON_SECRET`, réponse bornée à des compteurs et codes allow-listés. | Non |
| Activation analytics PRODUCTION | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | DPO | Verrouillée par construction (voir ci-dessus). La collecte PRODUCTION **reste OFF** : elle ne bloque donc pas le pilote. Son lever éventuel requiert la validation privacy et ne peut pas être obtenu par une variable d'environnement. | Non |
| Analytics — sous-traitant externe | `NOT_APPLICABLE` | `NOT_APPLICABLE` | — | Aucun SDK client, aucun cookie analytics, aucun provider externe (ADR-022 §2.1, §3). | Non |

## C2.E — Partenaire Pro

| Sujet | État technique | État documentaire | Owner du sign-off | Preuve / lien | Bloque pilote |
| --- | --- | --- | --- | --- | --- |
| Informations légales entreprise | `BLOCKED` | `HUMAN_SIGNOFF_REQUIRED` | Porteur produit + Juridique | `organizations` ne porte que `legalName` et `slug` (`packages/database/src/schema.ts:100-108`). **Aucun** SIRET/SIREN, numéro de TVA intracommunautaire, forme juridique, siège social, ni représentant légal. Le jalon `ORGANIZATION` ne vérifie que `length(legalName) >= 2` (`packages/core/src/dashboard/onboarding-readiness.ts:56`). | **Oui** |
| Établissements | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Porteur produit | Jalon `LOCATION` : adresse complète, coordonnées géographiques, `pickupEnabled` et au moins une plage horaire (`onboarding-readiness.ts:60-90`). Aucune pièce justificative d'établissement requise. | Non |
| Facturation partenaire | `BLOCKED` | `HUMAN_SIGNOFF_REQUIRED` | Finance + Expert-comptable | Aucune table ni champ de facturation partenaire : pas de coordonnées bancaires propres au-delà du compte Stripe, pas de règle de facturation de la commission, pas de périodicité de règlement. | **Oui** |
| Connected Account LIVE readiness | `TECHNICALLY_VERIFIED` | `HUMAN_SIGNOFF_REQUIRED` | Finance + Porteur produit | Jalon `PAYMENTS` : `chargesEnabled \|\| onboardingStatus === 'ENABLED'` (`onboarding-readiness.ts:244`). Garde-fou LIVE en place : `STRIPE_ENVIRONMENT=LIVE` exige `PAYMENTS_LIVE_ENABLED=true` (`apps/web/src/lib/payment-config.ts`, `resolveStripeEnvironment`). ADR-024 §5 : `PAYMENTS_LIVE_ENABLED=false` tant que les verrous ADR-010 ne sont pas fermés. Aucun compte LIVE rattaché à ce jour. | **Oui** |
| Stripe LIVE credentials | `TECHNICALLY_VERIFIED` | `BLOCKED` | Porteur produit + Engineering | Non configurés. `docs/implementation/environments.md` : `STRIPE_ENVIRONMENT=TEST`, `PAYMENTS_LIVE_ENABLED=false`. | **Oui** |
| Stripe LIVE webhooks | `TECHNICALLY_VERIFIED` | `BLOCKED` | Engineering + Porteur produit | Non configurés. Secrets `STRIPE_PLATFORM_WEBHOOK_SECRET` et `STRIPE_CONNECT_WEBHOOK_SECRET` transmis vides en local (`docs/implementation/environments.md`). | **Oui** |

---

## C3 — Cohérence code ↔ documents

Sept contradictions importantes ont été identifiées. Aucune n'a été « corrigée »
lorsqu'elle exigeait une décision juridique, comptable ou DPO : elles sont
laissées en `HUMAN_SIGNOFF_REQUIRED`.

### C3-F1 — Version de terms persistée mais document absent (gravité : haute)

Le pipeline persiste et valide une version de terms qui ne correspond à aucun
document.

- `apps/web/src/lib/payment-config.ts` : `legalTermsVersion: 'v1'`.
- `apps/web/src/features/checkout/checkout-client.tsx:219` : `termsVersion: 'v1'`
  envoyé par le client.
- `packages/core/src/financial-terms/resolve-financial-terms.ts:215` : la règle 15
  valide que `acceptance.termsVersion === config.legalTermsVersion`.

Les deux valeurs étant codées en dur à `'v1'`, la validation réussit toujours.
Le snapshot `terms_acceptance_snapshot`, persisté sur `payments` puis sur
`bookings`, enregistre donc `{ termsVersion: 'v1', userId, acceptedAt }` — une
preuve d'acceptation portant sur **un document qui n'existe pas**.

**Conséquence :** la preuve de consentement du client est matériellement vide.
Lot 5 décision D exige « les éléments de preuve à conserver » et Lot 4 question 6
exige un « mécanisme de preuve de consentement ».

**Décision requise :** juridique. Ne pas modifier le code : le choix du
mécanisme de consentement (case à cocher, journalisation, versionnement) est une
décision juridique.

### C3-F2 — Règle de remboursement à distinguer legacy/split (gravité : haute)

Le comportement de remboursement n'est pas identique pour les deux générations
de réservation :

- **legacy** : `packages/core/src/cancellations/preview-booking-cancellation.ts`
  utilise `booking.totalAmountMinor` comme montant payé et applique le
  pourcentage de remboursement historique ;
- **split 13/7** : le parcours est bloqué avant toute création ou soumission de
  refund avec `SPLIT_REFUND_UNRESOLVED`. La politique proposée (delta entre
  états effectifs, calcul par composant, frais Stripe séparés et escalade
  manuelle) est formalisée dans `ADR-030`, mais n'est pas encore approuvée ni
  exécutable par le provider.

La base legacy reste donc techniquement assimilable à l'option A « total TTC »,
mais cette observation ne vaut pas validation juridique ou financière. Pour le
split, le traitement des composants est proposé par ADR-030 ; les frais Stripe,
le reverse transfer, le règlement hors plateforme et le message client restent
à valider.

**Décision requise :** juridique + finance. Ne pas modifier le code avant cette
décision ; toute évolution split devra conserver un snapshot versionné et des
tests d'invariance.

### C3-F3 — Émetteur de facture et statut fiscal incohérents avec Lot 5 (gravité : haute)

`apps/web/src/lib/payment-config.ts` (`loadFinancialTermsConfig`) durcit :

```ts
tax: {
  version: 'v1',
  status: 'NOT_APPLICABLE',
  amountMinor: null,
  rateBps: null,
  invoiceIssuer: 'Uttily',
},
```

Or `docs/product/lot5-finance-legal-validation.md` §4 « Décision attendue C —
termes fiscaux » demande au validateur de préciser « si la taxe est `APPLIED` ou
`NOT_APPLICABLE` » et « qui émet la facture ou le reçu de location ». Le code
répond donc à une question ouverte par une valeur figée, non validée, et cette
valeur est ensuite propagée dans le snapshot fiscal immuable de chaque paiement
(`TaxRuleSnapshot`) puis dans les documents transactionnels.

Le mécanisme lui-même est sain : aucune substitution silencieuse par zéro, le
résolveur échoue en `FINANCIAL_TERMS_UNRESOLVED` si la configuration est
absente. Seules les **valeurs** posent problème.

**Décision requise :** expert-comptable + juridique. Ne pas modifier le code.

### C3-F4 — Rétention annoncée ≠ rétention documentée (gravité : moyenne — corrigée)

ADR-022 §2.6 affirmait : « G7H-A fournit une primitive de purge, mais aucun
worker/cron n'est encore branché ». Cette affirmation est devenue fausse : le
cron existe (`apps/web/vercel.json`, `17 3 * * *`) et la route
`/api/cron/process-product-analytics` l'expose avec authentification fail-closed.

**Correction appliquée :** ADR-022 §2.6 amendée pour décrire le câblage réel
(Chantier 18-A), en conservant l'invariant de verrouillage PRODUCTION.

### C3-F5 — Inventaire des endpoints cron incomplet (gravité : faible — corrigée)

`docs/implementation/environments.md` listait trois endpoints cron et omettait
`process-product-analytics`.

**Correction appliquée :** endpoint ajouté à la description de `CRON_SECRET`.

### C3-F6 — Aucune mention légale publique (gravité : haute)

Aucune page CGU, CGV, mentions légales ou politique de confidentialité n'existe
dans l'application, alors que le parcours de paiement enregistre une acceptation
de terms. Non corrigé : production de contenu juridique.

### C3-F7 — Aucun secret exposé (gravité : nulle — constat positif)

Vérifié et conforme : ADR-028 §4 garantit l'absence d'exposition de
`INVITATION_SECRET`, tokens bruts et clés secrètes dans les vues de support ;
le back-office est fail-closed sur `is_platform_admin` ; la route cron analytics
n'expose qu'un code d'erreur allow-listé. Aucune correction nécessaire.

---

## C4 — Privacy engineering

État des capacités, prouvé uniquement sur ce qui est techniquement vérifiable.

| Capacité | État | Preuve |
| --- | --- | --- |
| Analytics first-party agrégés | `TECHNICALLY_VERIFIED` | ADR-022 §2.1-2.3 ; PostgreSQL uniquement, quatre compteurs, aucune dimension identifiante. |
| Analytics PRODUCTION verrouillé | `TECHNICALLY_VERIFIED` | Triple verrou (runtime, type, constante). Aucune variable d'environnement ne peut l'activer. |
| Purge / rétention analytics exécutable | `TECHNICALLY_VERIFIED` | `purgeExpiredProductAnalytics` (raw 90 j + agrégats 24 mois, compaction additive, advisory locks) ; cron quotidien authentifié. |
| Exports tenant-safe | `TECHNICALLY_VERIFIED` | `/api/dashboard/[orgId]/finances/export-csv` : `requireFinancialViewerOf(orgId)` retourne l'`organizationId` **résolu côté serveur**, transmis au Core — jamais le paramètre d'URL. |
| Support data limitée | `TECHNICALLY_VERIFIED` | ADR-028 : `/internal` fail-closed sur `is_platform_admin`, aucune fuite de secrets, `audit_log` append-only, liste fermée de quatre actions support. |
| Mécanismes de suppression / anonymisation | `BLOCKED` | **Aucun mécanisme n'existe.** Voir C4-F1. |
| Absence de secret dans les données exposées | `TECHNICALLY_VERIFIED` | ADR-028 §4 ; codes d'erreur allow-listés sur la route cron analytics. |

### C4-F1 — Suppression / anonymisation : capacité absente

**Constat :** recherche exhaustive sur `packages/` et `apps/` (hors
`node_modules`) : zéro occurrence de « anonymisation », « effacement »,
« suppression de compte », « erasure », « right to be forgotten », « GDPR » ou
« RGPD ». Aucun mécanisme d'effacement ou d'anonymisation d'un utilisateur
n'existe.

**Pourquoi ce n'est pas un correctif V1 :** la suppression d'un utilisateur
entre en conflit direct avec des obligations de conservation — factures et
documents transactionnels, preuve d'acceptation des terms, journal d'audit
append-only (ADR-016), ledger de paiements. Déterminer ce qui doit être effacé,
anonymisé ou conservé est une décision DPO et juridique préalable. Implémenter
une suppression générique reviendrait à **prendre cette décision à la place du
DPO** et pourrait détruire des preuves légales.

**Marqué `BLOCKED`.** Chantier à ouvrir après arbitrage DPO, portant
a minima sur : périmètre effaçable, stratégie d'anonymisation des réservations
et paiements, conservation des factures, traitement du ledger analytics
(`source_id` pseudonyme, 90 jours), et journalisation de l'effacement.

### C4-F2 — Export des données personnelles : capacité absente

**Constat :** le seul export existant est le CSV financier du **loueur**
(`/api/dashboard/[orgId]/finances/export-csv`), tenant-safe et correctement
autorisé. Aucun export des données d'un utilisateur **client** n'existe : pas
d'accès, pas de rectification, pas de portabilité.

**Marqué `BLOCKED`.** Même raison : le périmètre exact d'un export de
portabilité (quelles tables, quels tiers, quelles exclusions liées aux secrets
et aux autres personnes) est une décision DPO, pas un choix technique.

---

## AVANT LE PREMIER PILOTE RÉEL

Aucune case n'est cochée : aucune preuve de validation humaine écrite n'existe
dans le dépôt à la base `eb08f2830abad5fd6643978aee6056e6e59e7171`.

- [ ] Validation juridique CGU/CGV
- [ ] Validation annulation/remboursement
- [ ] Validation privacy/rétention/analytics
- [ ] Validation finance/TVA/commission/invoice issuer
- [ ] Stripe LIVE credentials configurés
- [ ] Stripe LIVE webhooks configurés
- [ ] Connected Account LIVE partenaire pilote ready
- [ ] Backup/provider recovery et RPO/RTO validés
- [ ] Incident contacts définis
- [ ] Go explicite porteur produit

**Règle de cochage :** une case ne peut être cochée que si la preuve
correspondante est présente dans ce document ou dans un document référencé. Une
case non prouvée reste non cochée. Une case non cochée bloque le pilote.

### Séparation recovery — ne pas confondre les preuves

| Élément | Statut actuel | Preuve / limite | Owner, méthode et prochaine action |
| --- | --- | --- | --- |
| Restore mechanism local drill | `PASS` | [`chantier-20b-restore-drill-report.md`](../implementation/chantier-20b-restore-drill-report.md) : PostgreSQL/PostGIS local éphémère, `pg_dump` custom puis `pg_restore`, fixture vérifiée, résultat `PASS`. | Owner recovery ; rejouer localement avec `UTTILY_RECOVERY_DRILL=1 NODE_ENV=test` après changement de migration ; cela ne teste pas production. |
| Production/provider restore procedure | `TO_VERIFY` | [`chantier-20b-recovery.md`](../implementation/chantier-20b-recovery.md) décrit un runbook, mais la méthode Neon/provider, les droits et une restauration isolée réelle ne sont pas prouvés. | Owner recovery + opérateur Neon ; demander la procédure supportée et les droits, puis consigner une réponse provider et un exercice isolé autorisé. |
| Provider backup configuration | `TO_VERIFY` | Aucune preuve Neon/provider de fréquence, rétention ou configuration effective n'est présente dans la base. | Owner recovery + opérateur Neon ; vérifier dans le projet provider, conserver une preuve non secrète et documenter fréquence/rétention/propriétaire. |
| Production RPO/RTO | `TO_CONFIRM` | Le drill local mesure environ 10,8 s de bout en bout ; aucune mesure Neon/Vercel ni SLA production n'est déduite. | Owner recovery + engineering ; autoriser un exercice par environnement, mesurer point de récupération et temps de reprise, puis faire accepter les limites. |

Le statut `PASS` du drill local ne coche donc pas la case de recovery de
production et ne transforme pas les statuts provider en preuve de disponibilité.

### Analytics production

`PRODUCTION ANALYTICS = OFF`. Les verrous runtime/type/configuration restent
inchangés ; aucune activation ni modification privacy n'est réalisée dans ce
chantier.

---

## Blocage Pilot-Ready

Le pilote réel est **bloqué**. Les dépendances critiques, par ordre de
déblocage :

1. **Production des textes juridiques** (CGU/CGV, conditions Pro, politique de
   confidentialité) — préalable à toute autre validation.
2. **Décision C de Lot 5** (statut fiscal, émetteur de facture) — la valeur est
   actuellement figée dans le code, non validée, et se propage dans chaque
   snapshot de paiement.
3. **Décision A/B/D/E de Lot 5** (settlement merchant, règle de commission,
   contrat client, compensation des paiements tardifs).
4. **Validation Lot 4** (conformité des trois politiques, base de remboursement,
   preuve de consentement).
5. **Arbitrage DPO** puis chantier de suppression/anonymisation et d'export des
   données personnelles.
6. **Informations légales du partenaire Pro** (SIRET, TVA, forme juridique,
   siège) et facturation.
7. **Configuration LIVE** (credentials, webhooks, compte connecté) — technique,
   mais subordonnée aux points 1 à 6.
8. **Backup/restore drill, contacts d'incident, go produit.**

## Références

- [`decision-registry.md`](decision-registry.md) — registre canonique des décisions 21-P0
- [`pilot-unblock-plan.md`](pilot-unblock-plan.md) — plan des 31 blockers et des cases préparatoires
- [`signoff/legal-decision-pack.md`](signoff/legal-decision-pack.md) — pack juridique
- [`signoff/finance-decision-pack.md`](signoff/finance-decision-pack.md) — pack finance et matrice money flow
- [`signoff/privacy-decision-pack.md`](signoff/privacy-decision-pack.md) — pack DPO et data map
- [`signoff/subprocessors-inventory.md`](signoff/subprocessors-inventory.md) — inventaire à vérifier
- [`pilot-partner-readiness.md`](pilot-partner-readiness.md) — collecte partenaire sans données réelles
- [`live-operator-checklist.md`](live-operator-checklist.md) — séquence de configuration LIVE sans secrets
- `docs/product/lot4-legal-validation.md` — politiques d'annulation, base de remboursement
- `docs/product/lot5-finance-legal-validation.md` — décisions A à F, garde-fou d'environnement
- `docs/implementation/mvp-pilot-readiness.md` — baseline technique après Lot 7
- `docs/implementation/open-questions.md` — questions ouvertes G7B-R3
- `docs/implementation/environments.md` — inventaire des variables d'environnement
- `docs/decisions/ADR-010-*.md` — paiement Stripe Connect et verrous LIVE
- `docs/decisions/ADR-022-*.md` — analytics produit, privacy et rétention
- `docs/decisions/ADR-024-*.md`, `ADR-025-*.md` — onboarding Stripe Connect
- `docs/decisions/ADR-028-*.md` — back-office et support V1
