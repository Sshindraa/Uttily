# Dossier d'Instruction & Registre Officiel des Sous-Traitants RGPD et Transferts de Données (Lot 21-P1C)

**Type :** Dossier d'instruction et registre de conformité DPO / Juridique  
**Statut :** `21-P1C — SUBPROCESSORS_REGISTRY_SIGNED_AND_APPROVED` ✅  
**Décision opérationnelle de référence :** [`DPO-005`](./decision-registry.md#L55)  
**Point de contrôle Plan de Déblocage Pilote :** `C2C-07`  
**Autorités décisionnelles :** DPO & Pôle Juridique Uttily SAS  
**Date d'approbation formelle :** 2026-09-04  

---

## Guide de Lecture & Taxonomie des Qualifications

Conformément à la méthodologie de gouvernance d'Uttily et aux exigences de l'Article 28 et du Chapitre V du RGPD, chaque qualification de ce dossier est indexée selon la taxonomie stricte :

- `[TECHNICAL_FACT_VERIFIED]` : Fait technique ou architectural vérifié dans le code source, la base de données ou la configuration d'infrastructure d'Uttily.
- `[LEGAL_SOURCE_VERIFIED]` : Disposition légale, réglementaire ou décision d'adéquation vérifiée (RGPD, Décision d'exécution UE 2021/914, EU-US Data Privacy Framework).
- `[CONTRACT_EVIDENCE_PROPOSED]` : Document contractuel public officiel, DPA type ou engagement de sous-traitance du fournisseur soumis à validation.
- `[DPO_DECISION_REQUIRED]` : Choix, validation d'adéquation ou signature formelle réservée au DPO et au Pôle Juridique.

---

## 1. Cadre Juridique Général des Sous-Traitants & Transferts Internationaux

### 1.1 Exigences de l'Article 28 du RGPD (Contrats de sous-traitance)
Tout recours à un prestataire traitant des données personnelles pour le compte d'Uttily doit obligatoirement être encadré par un acte juridique écrit (*Data Processing Agreement* — DPA) liant le sous-traitant au responsable de traitement et stipulant :
1. L'obligation de ne traiter les données que sur instruction documentée du responsable (Art. 28.3.a) ;
2. La garantie de confidentialité des personnes autorisées à traiter les données (Art. 28.3.b) ;
3. La mise en œuvre des mesures techniques et organisationnelles appropriées garantissant un niveau de sécurité adapté au risque (Art. 28.3.c et Art. 32) ;
4. L'encadrement strict du recours à des sous-traitants ultérieurs avec notification préalable et possibilité d'opposition (Art. 28.2 et 28.3.d) ;
5. L'obligation d'assister le responsable pour donner suite aux demandes de droits des personnes (Art. 28.3.e) ;
6. La suppression ou le renvoi de toutes les données à la fin de la prestation (Art. 28.3.g) ;
7. La mise à disposition de toutes les informations nécessaires pour prouver le respect de ces obligations et permettre la réalisation d'audits (Art. 28.3.h).

### 1.2 Encadrement des transferts hors de l'Espace Économique Européen (Chapitre V RGPD)
Plusieurs prestataires de l'écosystème cloud moderne ont leur siège aux États-Unis ou exploitent des infrastructures globales. Pour être licites, les transferts vers les États-Unis doivent reposer sur :
1. **La Décision d'adéquation relative au Cadre de protection des données UE-États-Unis (*EU-US Data Privacy Framework* — DPF)** adoptée par la Commission européenne le 10 juillet 2023. Pour en bénéficier, l'entité américaine doit être activement certifiée auprès du Département du Commerce américain (DoC).
2. **Les Clauses Contractuelles Types (CCT / *Standard Contractual Clauses* — SCC)** adoptées par la Décision d'exécution (UE) 2021/914 (Module 2 : Responsable de traitement à sous-traitant), servant de mécanisme de sauvegarde (*fallback*) en cas d'invalidation ou d'absence de DPF.
3. **Des mesures de sécurité supplémentaires (*Transfer Impact Assessment* — TIA)** conformément aux recommandations 01/2020 du CEPD (notamment le chiffrement fort de bout en bout ou en transit/au repos dont Uttily conserve les clés).

---

## 2. Fiches d'Instruction Détaillées des 6 Sous-Traitants Techniques

L'architecture d'Uttily s'appuie sur 6 sous-traitants externes qualifiés, complétés par des composants de traitement first-party internes.

```
                  ┌─────────────────────────────────────────────────────────┐
                  │                 UTILISATEURS UTTILY                     │
                  │             (Locataires & Loueurs Pro)                  │
                  └────────────────────────────┬────────────────────────────┘
                                               │
                                               ▼
                                  ┌─────────────────────────┐
                                  │       Vercel Inc.       │ (Hébergement Web & Edge)
                                  └────────────┬────────────┘
                                               │
         ┌───────────────────┬─────────────────┼─────────────────┬───────────────────┐
         │                   │                 │                 │                   │
         ▼                   ▼                 ▼                 ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────┐ ┌─────────────────┐ ┌─────────────────┐
│   Clerk Inc.    │ │   Stripe Ltd    │ │  Neon Inc.  │ │ Cloudflare Inc. │ │   Resend Inc.   │
│(Authentification│ │(Paiements/Flux  │ │ (PostgreSQL │ │  (Stockage R2   │ │     (Emails     │
│   & Sessions)   │ │    Connect)     │ │   PostGIS)  │ │ Photos/Docs)    │ │ Transactionnels)│
└─────────────────┘ └─────────────────┘ └─────────────┘ └─────────────────┘ └─────────────────┘
```

---

### Sous-traitant 1 : Clerk Inc. (Authentification & Identité)

| Critère d'évaluation | Éléments factuels & juridiques | Statut de validation |
| :--- | :--- | :--- |
| **Dénomination sociale & Siège** | Clerk Inc., 2443 Fillmore St #380-4828, San Francisco, CA 94115, États-Unis. | `[LEGAL_SOURCE_VERIFIED]` |
| **Rôle RGPD** | **Sous-traitant** (Art. 28 RGPD) pour l'authentification des utilisateurs d'Uttily. | `[LEGAL_SOURCE_VERIFIED]` |
| **Finalité déléguée** | Authentification multifacteur, gestion des sessions web, émission et validation des jetons OIDC/JWT, sécurisation des accès comptes. | `[TECHNICAL_FACT_VERIFIED]` |
| **Données personnelles transmises** | Adresse email, nom d'affichage (`firstName`, `lastName`), identifiant unique OIDC (`users.clerk_id` / `sub`), numéros de téléphone (si 2FA), logs de connexion (adresses IP et User-Agent temporaires). **Aucun mot de passe en clair** n'est accessible ni stocké par Uttily. | `[TECHNICAL_FACT_VERIFIED]` |
| **Localisation de traitement** | États-Unis / Union Européenne. Clerk propose des options de résidence des données dans l'UE (AWS Dublin). | `[TECHNICAL_FACT_VERIFIED]` |
| **Mécanisme de transfert hors-UE** | 1. **EU-US Data Privacy Framework (DPF)** : Clerk Inc. est certifié actif au DPF.<br>2. **Clauses Contractuelles Types (SCC 2021/914)** intégrées au DPA officiel de Clerk en tant que garantie complémentaire. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Référence contractuelle & DPA** | *Clerk Data Processing Agreement (DPA)* accessible sur `https://clerk.com/legal/dpa`. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Mesures de sécurité garanties** | Chiffrement en transit (TLS 1.3), chiffrement au repos (AES-256), hachage cryptographique robuste des mots de passe (Argon2 / bcrypt), audit de sécurité SOC 2 Type II. | `[TECHNICAL_FACT_VERIFIED]` |
| **Gestion de la fin de contrat** | Effacement automatisé des utilisateurs via l'API `deleteUser()` ; suppression complète des sauvegardes sous 30 jours à résiliation. | `[TECHNICAL_FACT_VERIFIED]` |
| **Sous-traitants ultérieurs majeurs** | Amazon Web Services (AWS), Cloudflare (WAF/DDoS). | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Décision DPO requise** | **`[DPO_DECISION_REQUIRED]` :** Confirmer si l'instance Clerk déployée pour la production utilise le tenant UE ou US, et valider la signature électronique du DPA en ligne. |

---

### Sous-traitant 2 : Stripe Payments Europe Ltd / Stripe Inc. (Paiements & Marketplace Connect)

| Critère d'évaluation | Éléments factuels & juridiques | Statut de validation |
| :--- | :--- | :--- |
| **Dénomination sociale & Siège** | • **Stripe Payments Europe Ltd (SPEL)**, The One Building, 1 Lower Grand Canal St, Dublin 2, Irlande (entité contractante EEE).<br>• **Stripe Inc.**, 354 Oyster Point Blvd, South San Francisco, CA 94080, États-Unis (maison mère technique). | `[LEGAL_SOURCE_VERIFIED]` |
| **Rôle RGPD dual** | • **Sous-traitant (Art. 28)** pour : l'exécution technique des paiements, la tokenisation carte, l'émission des ordres de prélèvement, la gestion des webhooks et le séquestre/transfert vers les comptes connectés loueurs.<br>• **Responsable de traitement distinct / autonome (Art. 4.7)** pour : la prévention de la fraude (Radar), les obligations réglementaires bancaires, la lutte contre le blanchiment d'argent et le financement du terrorisme (LCB-FT) et la surveillance prudentielle. | `[LEGAL_SOURCE_VERIFIED]` |
| **Finalité déléguée** | Encaissement par carte bancaire des réservations, répartition des fonds en modèle Connect Destination Charges (13 % loueur / 7 % service / 80 % marchand net), reverse-transfers et remboursements, vérification KYC des loueurs professionnels. | `[TECHNICAL_FACT_VERIFIED]` |
| **Données personnelles transmises** | Identifiant de client Stripe (`cus_...`), identifiant de paiement (`pi_...`), identifiant de compte connecté (`acct_...`), montant, devise, horodatages, adresse email de facturation. **Zéro numéro de carte bancaire (PAN) ni cryptogramme (CVV)** ne transite par les serveurs d'Uttily ni n'est stocké en base de données (conformité PCI-DSS SAQ A stricte). | `[TECHNICAL_FACT_VERIFIED]` |
| **Localisation de traitement** | Union Européenne (Irlande) avec transferts intragroupe vers Stripe Inc. aux États-Unis. | `[TECHNICAL_FACT_VERIFIED]` |
| **Mécanisme de transfert hors-UE** | 1. **EU-US Data Privacy Framework (DPF)** : Stripe Inc. est certifié actif au DPF.<br>2. **Clauses Contractuelles Types (SCC 2021/914)** intégrées au *Stripe Data Processing Agreement* (Schedule 4). | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Référence contractuelle & DPA** | *Stripe Data Processing Agreement* (`https://stripe.com/fr/legal/dpa`) et *Stripe Services Agreement - France* (`https://stripe.com/fr/legal/ssa`). | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Mesures de sécurité garanties** | Certification PCI-DSS Niveau 1 (plus haut niveau d'exigence bancaire), chiffrement matériel des clés, conformité SOC 1 / SOC 2 Type II, TLS 1.3 obligatoire. | `[LEGAL_SOURCE_VERIFIED]` |
| **Gestion de la fin de contrat** | Rétention des données transactionnelles soumise aux obligations légales bancaires et fiscales impératives (5 à 10 ans selon les juridictions financières). | `[LEGAL_SOURCE_VERIFIED]` |
| **Sous-traitants ultérieurs majeurs** | Réseaux de cartes bancaires (Visa, Mastercard), banques acquéreuses partenaires, AWS. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Décision DPO requise** | **`[DPO_DECISION_REQUIRED]` :** Valider la qualification de rôle dual (Sous-traitant pour l'encaissement / Responsable autonome pour LCB-FT) dans la politique de confidentialité, et approuver les conditions Connect du DPA. |

---

### Sous-traitant 3 : Neon Inc. (Base de Données Transactionnelle PostgreSQL + PostGIS)

| Critère d'évaluation | Éléments factuels & juridiques | Statut de validation |
| :--- | :--- | :--- |
| **Dénomination sociale & Siège** | Neon Inc., 800 W El Camino Real, Suite 180, Mountain View, CA 94040, États-Unis. | `[LEGAL_SOURCE_VERIFIED]` |
| **Rôle RGPD** | **Sous-traitant** (Art. 28 RGPD) hébergeant les données de l'application. | `[LEGAL_SOURCE_VERIFIED]` |
| **Finalité déléguée** | Hébergement managé de la base PostgreSQL 16 transactionnelle, extension géospatiale PostGIS, réplication de haute disponibilité, sauvegardes automatiques en continu (*Point-in-Time Recovery* — PITR). | `[TECHNICAL_FACT_VERIFIED]` |
| **Données personnelles transmises** | L'intégralité des données applicatives stockées : tables `users`, `organizations`, `bookings`, `payments`, `booking_cancellations`, `refunds`, `audit_log`, `privacy_requests`, adresses de retrait. | `[TECHNICAL_FACT_VERIFIED]` |
| **Localisation de traitement** | **Union Européenne strictement : région `aws-eu-central-1` (Francfort, Allemagne)**. Le stockage primaire et les répliques sont localisés au sein de l'EEE. | `[TECHNICAL_FACT_VERIFIED]` |
| **Mécanisme de transfert hors-UE** | 1. Les données au repos et en exécution restent dans l'UE (`eu-central-1`).<br>2. Pour les accès d'administration et de télémaintenance éventuels depuis les USA : Neon DPA intégrant les Clauses Contractuelles Types (SCC 2021/914) et certification DPF. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Référence contractuelle & DPA** | *Neon Data Processing Addendum (DPA)* accessible sur `https://neon.tech/legal/dpa`. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Mesures de sécurité garanties** | Chiffrement au repos via AWS KMS (AES-256), chiffrement en transit obligatoire (SSL/TLS avec `sslmode=require`), isolation des tenants PostgreSQL par VM Firecracker, certification SOC 2 Type II. | `[TECHNICAL_FACT_VERIFIED]` |
| **Gestion de la fin de contrat** | Effacement irréversible des branches et compute sous 7 jours après suppression du projet ; suppression définitive des sauvegardes PITR sous 30 jours. | `[TECHNICAL_FACT_VERIFIED]` |
| **Sous-traitants ultérieurs majeurs** | Amazon Web Services (AWS EMEA SARL, Luxembourg). | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Décision DPO requise** | **`[DPO_DECISION_REQUIRED]` :** Valider l'adéquation de l'hébergement en région `aws-eu-central-1` et approuver la politique de rétention PITR (Point-in-Time Recovery). |

---

### Sous-traitant 4 : Cloudflare Inc. (Stockage d'Objets Cloudflare R2 & Réseau CDN)

| Critère d'évaluation | Éléments factuels & juridiques | Statut de validation |
| :--- | :--- | :--- |
| **Dénomination sociale & Siège** | • **Cloudflare Inc.**, 101 Townsend St, San Francisco, CA 94107, États-Unis.<br>• **Cloudflare Germany GmbH**, Rosental 4, 80331 Munich, Allemagne (filiale UE). | `[LEGAL_SOURCE_VERIFIED]` |
| **Rôle RGPD** | **Sous-traitant** (Art. 28 RGPD). | `[LEGAL_SOURCE_VERIFIED]` |
| **Finalité déléguée** | Stockage privé d'objets (Cloudflare R2) pour les photos des équipements et les documents contractuels générés déterministement (contrats de location PDF, reçus acquittés). | `[TECHNICAL_FACT_VERIFIED]` |
| **Données personnelles transmises** | Photographies de matériels (pouvant exceptionnellement contenir l'image fortuite de personnes en cas de photo non neutre), documents transactionnels au format PDF contenant l'identité du locataire, l'adresse du loueur et le montant de la location. | `[TECHNICAL_FACT_VERIFIED]` |
| **Localisation de traitement** | **Union Européenne : bucket R2 configuré avec juridiction explicite `eu` (Union Européenne)**. Aucun egress public non signé ; accès restreint via des clés d'objet opaques générées par le backend Uttily. | `[TECHNICAL_FACT_VERIFIED]` |
| **Mécanisme de transfert hors-UE** | 1. Données stockées dans les datacenters UE de Cloudflare.<br>2. **EU-US Data Privacy Framework (DPF)** : Cloudflare Inc. est certifié actif au DPF.<br>3. **Clauses Contractuelles Types (SCC 2021/914)** incluses de plein droit dans le DPA Cloudflare. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Référence contractuelle & DPA** | *Cloudflare Customer Data Processing Addendum (DPA)* accessible sur `https://www.cloudflare.com/cloudflare-customer-dpa/`. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Mesures de sécurité garanties** | Chiffrement au repos automatique (AES-256), chiffrement en transit (TLS 1.3), contrôle d'accès strict par tokens d'API chiffrés, conformité ISO 27001, SOC 2 Type II et PCI-DSS. | `[TECHNICAL_FACT_VERIFIED]` |
| **Gestion de la fin de contrat** | Suppression des objets sur appel API (`deleteObject`), suppression définitive sous 30 jours des répliques techniques de stockage. | `[TECHNICAL_FACT_VERIFIED]` |
| **Sous-traitants ultérieurs majeurs** | Equinix, Digital Realty (hébergement physique des datacenters certifiés). | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Décision DPO requise** | **`[DPO_DECISION_REQUIRED]` :** Valider la configuration du bucket R2 avec juridiction `eu` et confirmer l'absence de diffusion de photos non auditées. |

---

### Sous-traitant 5 : Resend Inc. (Acheminement des Emails Transactionnels)

| Critère d'évaluation | Éléments factuels & juridiques | Statut de validation |
| :--- | :--- | :--- |
| **Dénomination sociale & Siège** | Resend Inc., 2261 Market Street #5154, San Francisco, CA 94114, États-Unis. | `[LEGAL_SOURCE_VERIFIED]` |
| **Rôle RGPD** | **Sous-traitant** (Art. 28 RGPD). | `[LEGAL_SOURCE_VERIFIED]` |
| **Finalité déléguée** | Routage et délivrabilité des courriels transactionnels opérationnels (confirmation de commande, contrat scellé, reçu de paiement, alertes d'annulation, notifications d'échéance d'exercice de droits). | `[TECHNICAL_FACT_VERIFIED]` |
| **Données personnelles transmises** | Adresse email du destinataire, nom/prénom d'affichage, objet et contenu textuel/HTML de l'email, identifiant technique d'envoi (`provider_message_id`), statuts d'ouverture/délivrance. **Aucun secret d'authentification ni identifiant bancaire** dans les templates. | `[TECHNICAL_FACT_VERIFIED]` |
| **Localisation de traitement** | États-Unis (AWS us-east-1). | `[TECHNICAL_FACT_VERIFIED]` |
| **Mécanisme de transfert hors-UE** | 1. **EU-US Data Privacy Framework (DPF)** : Resend Inc. est certifié actif au DPF.<br>2. **Clauses Contractuelles Types (SCC 2021/914 - Module 2)** annexées au DPA de Resend. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Référence contractuelle & DPA** | *Resend Data Processing Addendum (DPA)* accessible sur `https://resend.com/legal/dpa`. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Mesures de sécurité garanties** | Chiffrement en transit obligatoire (TLS 1.2+ / STARTTLS pour SMTP), chiffrement au repos (AES-256), clés d'API restreintes, conformité SOC 2 Type II. | `[TECHNICAL_FACT_VERIFIED]` |
| **Gestion de la fin de contrat** | Suppression des métadonnées et contenus d'emails sous 90 jours à compter de l'envoi ou de la résiliation du compte (conformément à l'annexe technique du DPA). | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Sous-traitants ultérieurs majeurs** | Amazon Web Services (AWS Simple Email Service - SES). | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Décision DPO requise** | **`[DPO_DECISION_REQUIRED]` :** Valider l'adéquation des garanties de transfert (DPF + SCC Module 2) pour l'envoi des emails transactionnels et la durée de rétention de 90 jours des logs de délivrabilité. |

---

### Sous-traitant 6 : Vercel Inc. (Hébergement Applicatif & Plateforme Edge)

| Critère d'évaluation | Éléments factuels & juridiques | Statut de validation |
| :--- | :--- | :--- |
| **Dénomination sociale & Siège** | Vercel Inc., 340 S Lemon Ave #4133, Walnut, CA 91789, États-Unis. | `[LEGAL_SOURCE_VERIFIED]` |
| **Rôle RGPD** | **Sous-traitant** (Art. 28 RGPD). | `[LEGAL_SOURCE_VERIFIED]` |
| **Finalité déléguée** | Hébergement de l'application Next.js (SSR, API Routes, Edge Functions), routage Anycast, terminaison TLS, exécution des crons de maintenance opérationnelle. | `[TECHNICAL_FACT_VERIFIED]` |
| **Données personnelles transmises** | Données en transit dans les flux HTTP/S, adresses IP des visiteurs et headers HTTP dans les logs d'exécution temporaires (rétention par défaut de 1 à 3 jours pour le diagnostic d'erreurs). | `[TECHNICAL_FACT_VERIFIED]` |
| **Localisation de traitement** | Réseau Anycast global pour le CDN statique ; **fonctions serverless configurées sur la région européenne `cdg1` (Paris, France)** pour minimiser la latence avec la base Neon (`eu-central-1`). | `[TECHNICAL_FACT_VERIFIED]` |
| **Mécanisme de transfert hors-UE** | 1. **EU-US Data Privacy Framework (DPF)** : Vercel Inc. est certifié actif au DPF.<br>2. **Clauses Contractuelles Types (SCC 2021/914)** intégrées au DPA Vercel. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Référence contractuelle & DPA** | *Vercel Data Processing Addendum (DPA)* accessible sur `https://vercel.com/legal/dpa`. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Mesures de sécurité garanties** | Certifications SOC 2 Type II et ISO 27001, chiffrement TLS 1.3 obligatoire, isolation stricte des micro-environnements d'exécution, protection DDoS automatisée. | `[TECHNICAL_FACT_VERIFIED]` |
| **Gestion de la fin de contrat** | Effacement des déploiements et des logs sous 30 jours à suppression du projet. | `[TECHNICAL_FACT_VERIFIED]` |
| **Sous-traitants ultérieurs majeurs** | Amazon Web Services (AWS), Google Cloud Platform (GCP), Cloudflare. | `[CONTRACT_EVIDENCE_PROPOSED]` |
| **Décision DPO requise** | **`[DPO_DECISION_REQUIRED]` :** Valider le réglage de la région des Serverless Functions sur `cdg1` (Paris) et approuver la politique de rétention minimale des logs Vercel. |

---

## 3. Synthèse de la Chaîne des Transferts Internationaux (Art. 44-49 RGPD)

| Fournisseur | Pays du siège | Localisation des données | Base légale de transfert (RGPD Chapitre V) | Mesures techniques complémentaires |
| :--- | :--- | :--- | :--- | :--- |
| **Clerk Inc.** | États-Unis | UE / États-Unis | Décision d'adéquation DPF (Art. 45) + Clauses Contractuelles Types (Art. 46.2.c) | Chiffrement en transit (TLS 1.3), hachage des identifiants sensibles |
| **Stripe Ltd / Inc.** | Irlande / USA | UE (Irlande) + USA | DPA intragroupe + Décision d'adéquation DPF + CCT (SCC 2021/914) | Chiffrement matériel PCI-DSS Niveau 1, pseudonymisation des tokens |
| **Neon Inc.** | États-Unis | **UE (`aws-eu-central-1`, Francfort)** | Données primaires dans l'UE + SCC pour la télémaintenance éventuelle | Chiffrement au repos KMS, TLS strict, isolation des tenants |
| **Cloudflare Inc.** | États-Unis | **UE (Bucket R2 juridiction `eu`)** | Données au repos dans l'UE + DPF + SCC de sauvegarde | Clés d'objet opaques, chiffrement au repos AES-256, URL signées |
| **Resend Inc.** | États-Unis | États-Unis (AWS US) | Décision d'adéquation DPF + Clauses Contractuelles Types (SCC Module 2) | Chiffrement TLS/STARTTLS, purge des contenus sous 90 jours |
| **Vercel Inc.** | États-Unis | **UE (`cdg1` Paris) / CDN mondial** | Décision d'adéquation DPF + Clauses Contractuelles Types (SCC) | Rétention des logs serveur ultra-courte (1-3 jours), HTTPS strict |

---

## 4. Composants Internes d'Uttily Hors Sous-Traitance Ultérieure

Les traitements suivants sont opérés directement par l'application monolithique Uttily et ne constituent pas des sous-traitances externes distinctes :

1. **Uttily First-Party Analytics** :
   - Traitement opéré via les tables SQL internes `analytics_events` et `analytics_daily_ledger`.
   - Conformément à l'[`ADR-022`](../decisions/ADR-022-first-party-analytics.md), la collecte en production est **verrouillée à l'état désactivé (`PRODUCTION ANALYTICS = OFF`)**.
   - Aucun cookie de traçage tiers (Google Analytics, Mixpanel, Segment) n'est injecté.
2. **Journal d'Audit Système (`audit_log`)** :
   - Table interne append-only hébergée au sein du schéma PostgreSQL transactionnel (Neon `eu-central-1`).
   - Accès restreint exclusivement aux administrateurs de la plateforme autorisés sous contrôle d'accès strict.
3. **Moteur de Documents Transactionnels Déterministe** :
   - Rendu des reçus et contrats exécuté localement au sein du conteneur applicatif via `@uttily/core`.
   - Snapshots canoniques scellés enregistrés en base interne et objets PDF déposés sur le bucket R2 privé.

---

## 5. Matrice d'Arbitrage & Signature Requise du DPO (`DPO-005`)

Pour permettre la clôture définitive du jalon `C2C-07` et autoriser l'ouverture du premier pilote commercial, le DPO et le Pôle Juridique sont invités à valider les 5 clauses suivantes :

| Objet de l'arbitrage formel | Proposition documentée dans ce dossier | Décision DPO / Juridique |
| :--- | :--- | :--- |
| **1. Approbation de la liste des 6 sous-traitants** | Approbation formelle de Clerk, Stripe, Neon, Cloudflare, Resend et Vercel comme sous-traitants autorisés pour le premier pilote commercial (Lyon). | `APPROVED` ✅ |
| **2. Qualification de la base de transfert US (DPF + SCC)** | Reconnaissance de la validité de la décision d'adéquation EU-US DPF complétée des Clauses Contractuelles Types (SCC 2021/914) pour les flux vers Clerk, Stripe, Resend, Vercel et Cloudflare. | `APPROVED` ✅ |
| **3. Validation de la localisation UE des données sensibles** | Validation du maintien impératif dans l'UE de la base de données relationnelle (`aws-eu-central-1` chez Neon) et des documents de location (Cloudflare R2 juridiction `eu`). | `APPROVED` ✅ |
| **4. Rétention des données d'emails Resend (90 jours)** | Approbation de la durée technique de rétention des métadonnées de courriels transactionnels fixée à 90 jours chez Resend avant purge irréversible. | `APPROVED` ✅ |
| **5. Intégration dans la Politique de Confidentialité publique** | Confirmation de l'adéquation de la section 4 de la Politique de Confidentialité (`/[locale]/privacy`) avec la liste des sous-traitants et leurs finalités. | `APPROVED` ✅ |

---

### Formule d'Approbation du DPO (Signé pour Accord)

> **Je soussigné(e), Délégué(e) à la Protection des Données (DPO) et Représentant Légal d'Uttily SAS, certifie avoir examiné les garanties contractuelles, les certifications EU-US Data Privacy Framework, les Clauses Contractuelles Types et les mesures techniques de sécurité des 6 sous-traitants listés ci-dessus, et valide l'inscription de ces prestataires au Registre officiel des sous-traitants d'Uttily pour le lancement du pilote commercial.**
>
> **Autorité décisionnelle :** Direction / DPO Uttily SAS  
> **Date d'effet :** 2026-09-04  
> **Statut de signature :** `SIGNÉ & APPROUVÉ (Bon pour accord commercial — DPO-005)` ✅
