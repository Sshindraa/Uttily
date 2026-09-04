# Inventaire des sous-traitants — Registre d'instruction DPO

**Référence de version :** document vivant ; vérifier le commit courant du dépôt avant utilisation.  
**Dernière revue de cohérence :** 2026-09-04  
**Statut :** `DECISION_PACK_READY_FOR_DPO_SIGNOFF` ✅ (Dossier complet dans [`21-p1c-subprocessors-dpo-005.md`](../21-p1c-subprocessors-dpo-005.md))  
**Décision de référence :** [`DPO-005`](../decision-registry.md#L55)  
**Jalon déblocage pilote :** `C2C-07`  

Les fournisseurs ci-dessous sont ceux identifiables dans l'architecture et le code du premier pilote. Chaque ligne externe est couverte par un DPA vérifié, des garanties de transfert (DPF et/ou SCC 2021/914) et est soumise à la signature formelle du DPO dans le dossier d'instruction dédié.

| Provider | Fonction | Data categories potentielles | DPA & Preuve contractuelle | Data location / Transfert (Chap. V RGPD) | Owner | Statut & Réf. dossier |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Clerk Inc.** | Identité/OIDC, authentification et sessions | Email, nom affiché, identifiant OIDC (`clerk_id`), téléphone 2FA | DPA officiel (`clerk.com/legal/dpa`), SOC 2 Type II | UE (AWS Dublin) / US ; certifié **EU-US DPF** + **SCC 2021/914** | DPO + Juridique | `READY_FOR_DPO_SIGNOFF`<br>([Fiche 1](../21-p1c-subprocessors-dpo-005.md#sous-traitant-1--clerk-inc-authentification--identit)) |
| **Stripe Payments Europe Ltd / Stripe Inc.** | Paiements, Connect destination charges, refunds | Identifiants client/paiement/compte, montant/devise ; zéro PAN/CVV (SAQ A) | Stripe DPA (`stripe.com/fr/legal/dpa`), SSA, PCI-DSS Niveau 1 | UE (Irlande) + USA ; certifié **EU-US DPF** + **SCC 2021/914** | DPO + Finance + Juridique | `READY_FOR_DPO_SIGNOFF`<br>([Fiche 2](../21-p1c-subprocessors-dpo-005.md#sous-traitant-2--stripe-payments-europe-ltd--stripe-inc-paiements--marketplace-connect)) |
| **Neon Inc.** | Base transactionnelle PostgreSQL 16 + PostGIS | Comptes, organisations, réservations, paiements, documents, audit | Neon DPA (`neon.tech/legal/dpa`), SOC 2 Type II | **UE strictement (`aws-eu-central-1`, Francfort)** ; SCC télémaintenance | DPO + Owner Recovery | `READY_FOR_DPO_SIGNOFF`<br>([Fiche 3](../21-p1c-subprocessors-dpo-005.md#sous-traitant-3--neon-inc-base-de-donnes-transactionnelle-postgresql--postgis)) |
| **Cloudflare Inc.** | Stockage d'objets privé R2 (photos, documents PDF) | Photos matériels, contrats et reçus scellés PDF sous clés opaques | Cloudflare Customer DPA (`cloudflare.com/cloudflare-customer-dpa/`) | **UE strictement (Bucket juridiction `eu`)** ; certifié **EU-US DPF** + **SCC** | DPO + Engineering | `READY_FOR_DPO_SIGNOFF`<br>([Fiche 4](../21-p1c-subprocessors-dpo-005.md#sous-traitant-4--cloudflare-inc-stockage-dobjets-cloudflare-r2--rseau-cdn)) |
| **Resend Inc.** | Emails transactionnels et notifications | Adresse destinataire, nom, contenu notification, identifiant message | Resend DPA (`resend.com/legal/dpa`), SOC 2 Type II | États-Unis (AWS US) ; certifié **EU-US DPF** + **SCC 2021/914 (Module 2)** | DPO + Engineering | `READY_FOR_DPO_SIGNOFF`<br>([Fiche 5](../21-p1c-subprocessors-dpo-005.md#sous-traitant-5--resend-inc-acheminement-des-emails-transactionnels)) |
| **Vercel Inc.** | Hébergement Web Next.js, Edge et Crons | Flux HTTP transit, logs d'exécution temporaires (1-3 jours) | Vercel DPA (`vercel.com/legal/dpa`), ISO 27001, SOC 2 | **UE (`cdg1` Paris)** / CDN Anycast global ; certifié **EU-US DPF** + **SCC** | DPO + Engineering | `READY_FOR_DPO_SIGNOFF`<br>([Fiche 6](../21-p1c-subprocessors-dpo-005.md#sous-traitant-6--vercel-inc-hbergement-applicatif--plateforme-edge)) |
| **Uttily first-party analytics** | Ledger et agrégats dans PostgreSQL | `source_id` pseudonyme, compteurs agrégés | `NOT_APPLICABLE` (composant first-party interne) | Interne base Neon ; **`PRODUCTION ANALYTICS = OFF`** (ADR-022) | DPO + Engineering | `VERIFIED_OFF` (verrouillé désactivé en production) |
| **Uttily Support / internal** | Vues `/internal`, actions support et audit | Identifiants fonctionnels, états paiement/refund, motif d'action | `NOT_APPLICABLE` (composant first-party interne) | Interne app Vercel / Neon ; contrôle strict `is_platform_admin` (ADR-028) | Owner Support + DPO | `INTERNAL_AUTHORIZED` |
| **Uttily transactional documents** | Snapshots de rendu, documents et outbox | Données de réservation, identité client/loueur, montants | `NOT_APPLICABLE` (moteur interne `@uttily/core`) | Stockage scellé Neon + Cloudflare R2 `eu` + Resend | Finance + DPO | `INTERNAL_SECURED` |
| **Uttily audit logs** | Journal append-only des actions support | Acteur, action, cible, métadonnées de raison | `NOT_APPLICABLE` (table interne `audit_log`) | Interne base Neon (`eu-central-1`) ; accès admin uniquement | DPO + Owner Support | `INTERNAL_SECURED` |

## Méthode de clôture et signature

L'instruction technique et contractuelle complète des 6 sous-traitants est finalisée dans le dossier [`21-p1c-subprocessors-dpo-005.md`](../21-p1c-subprocessors-dpo-005.md). La validation formelle par le DPO et le pôle juridique nécessite la signature des 5 clauses d'arbitrage de ce dossier avant l'ouverture du pilote commercial.
