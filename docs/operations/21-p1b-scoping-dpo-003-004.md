# Dossier d'Instruction et de Cadrage pour Décisions `DPO-003` & `DPO-004` (Lot 21-P1B)

**Type :** Dossier d'aide à la décision (Decision Pack) DPO / Juridique  
**Statut :** `21-P1B — DECISION_PACK_READY_FOR_DPO_LEGAL_REVIEW` ✅  
**Décisions opérationnelles concernées :**  
- **`DPO-003`** : Périmètre des données effaçables, pseudonymisables ou conservées, et gestion des exceptions légales.  
- **`DPO-004`** : Périmètre, formats, délais et exclusions des exports d'accès (Art. 15) et de portabilité (Art. 20).  
**Autorités décisionnelles :** DPO & Pôle Juridique Uttily.  
**Règle d'or :** **Zéro code applicatif d'effacement ou d'export (`generatePrivacyExport`, `eraseUserData`, etc.) et aucun document technique d'exécution (`21-p1b-technical-plan.md`) tant que les cellules `[DPO_DECISION_REQUIRED]` de ce dossier n'ont pas fait l'objet d'un arbitrage formel et signé par le DPO et le pôle juridique. Le prochain acteur du cycle est le DPO / Juridique, pas Engineering.**

---

## Guide de Lecture & Taxonomie des Statuts

Afin de distinguer rigoureusement les faits techniques constatés, les textes légaux avérés, les hypothèses soumises à examen et les arbitrages souverains réservés au DPO, chaque qualification de ce document est indexée selon la taxonomie suivante :

- `[TECHNICAL_FACT_VERIFIED]` : Fait technique avéré dans le code, la base de données ou les capacités contractuelles/techniques d'un fournisseur tiers.
- `[LEGAL_SOURCE_VERIFIED]` : Disposition légale ou réglementaire vérifiée (Code de commerce, Livre des procédures fiscales, RGPD).
- `[LEGAL_HYPOTHESIS_TO_VALIDATE]` : Hypothèse d'analyse juridique soumise à validation du DPO / Juridique (ex. articulation des délais de prescription civile avec l'archivage intermédiaire).
- `[DPO_DECISION_REQUIRED]` : Choix ou arbitrage régalien formel à trancher par le DPO / Juridique.

---

## 1. Matrice d'Instruction Multi-Dimensions : Catégorie × Finalité × Base Légale

Conformément aux exigences méthodologiques de la CNIL, l'éligibilité d'une donnée à un droit RGPD (accès, portabilité, effacement) ne se détermine pas au niveau d'une table SQL ou d'un nom de colonne, mais par l'analyse du triplet **Catégorie de données $\times$ Finalité du traitement $\times$ Base juridique**. Une même donnée technique (ex. un identifiant de réservation) peut intervenir dans plusieurs finalités distinctes régies par des bases juridiques et des régimes de conservation différents.

| Catégorie de données | Finalité du traitement | Base légale (RGPD Art. 6) | Système(s) | Droits RGPD applicables | Action envisagée (Instruction) | Justification & Référence légale | Statut / Décision requise |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **Identifiants de compte & Coordonnées directes** (`users` : email, nom, téléphone, OIDC sub) | **Gestion du compte utilisateur, authentification & relation client** | Exécution du contrat (Art. 6.1.b) | PostgreSQL (`users`), Clerk | • Accès (Art. 15)<br>• Portabilité (Art. 20)<br>• Effacement (Art. 17) | Neutralisation des identifiants et suppression du compte d'accès. | En fin de relation contractuelle, la conservation active n'est plus justifiée. `[TECHNICAL_FACT_VERIFIED]` : Clerk supporte l'API `deleteUser()`. | `[DPO_DECISION_REQUIRED]` : Définir le niveau d'exigence (pseudonymisation avec rupture des tables de correspondance vs anonymisation stricte au sens CNIL/G29) et les conditions préalables (absence de réservation active/litige). |
| **Historique des réservations & Contrats de location** (`bookings`, `booking_lines`, `booking_allocations`) | **Exécution de la prestation de location & suivi opérationnel** | Exécution du contrat (Art. 6.1.b) | PostgreSQL (`bookings`, `booking_lines`) | • Accès (Art. 15)<br>• Portabilité (Art. 20 — données générées par l'activité) | Fourniture d'un relevé structuré des locations passées (dates, catégories). | `[LEGAL_SOURCE_VERIFIED]` : La doctrine CNIL inclut dans la portabilité les données générées par l'activité de la personne si le traitement est automatisé et fondé sur le contrat. | `[DPO_DECISION_REQUIRED]` : Valider la liste exacte des champs portables (exclusion stricte des données d'exploitation internes du loueur). |
| **Historique des réservations & Contrats de location** (`bookings`, `booking_lines`) | **Archivage probatoire en vue de la gestion d'éventuels contentieux** | Constatation, exercice ou défense de droits en justice (Art. 17.3.e) & Intérêt légitime (Art. 6.1.f) | PostgreSQL (base opérationnelle ou archive intermédiaire) | • Effacement (Art. 17) $\rightarrow$ Exclusion temporaire | Maintien des données contractuelles sous accès restreint (scellé logique), hors d'atteinte de l'exploitation courante. | `[LEGAL_HYPOTHESIS_TO_VALIDATE]` : L'article 2224 du Code civil fixe une prescription quinquennale (5 ans) pour les actions personnelles ou mobilières à compter de la connaissance des faits. Il soutient un archivage probatoire, mais ne constitue pas une règle automatique de conservation aveugle. | `[DPO_DECISION_REQUIRED]` : Valider le point de départ du délai probatoire, la liste des données strictement nécessaires et le périmètre d'accès interne. |
| **Écritures financières, paiements & remboursements** (`payments`, `payment_attempts`, `refunds`, `amendment_payments`) | **Justification comptable des flux financiers & obligations fiscales** | Obligation légale (Art. 6.1.c) | PostgreSQL (`payments`), Stripe | • Accès (Art. 15)<br>• Portabilité (Art. 20) $\rightarrow$ **Non applicable**<br>• Effacement (Art. 17) $\rightarrow$ **Exclu** (Art. 17.3.b) | Rétention obligatoire sous scellé comptable. Portabilité exclue car traitement sous obligation légale et écritures comptables propres à Uttily. | `[LEGAL_SOURCE_VERIFIED]` : Code de commerce Art. L. 123-22 (conservation obligatoire des pièces justificatives comptables pendant **10 ans**). | `[LEGAL_SOURCE_VERIFIED]` : Application stricte de la rétention comptable 10 ans. |
| **Documents contractuels & Factures officielles** (`documents`, snapshots PDF) | **Conservation des pièces justificatives fiscales & facturation TVA** | Obligation légale (Art. 6.1.c) | PostgreSQL (`documents`), Cloudflare R2 | • Accès (Art. 15)<br>• Portabilité (Art. 20) $\rightarrow$ **Non applicable**<br>• Effacement (Art. 17) $\rightarrow$ **Exclu** (Art. 17.3.b) | Conservation sécurisée en archive fiscale et commerciale. | `[LEGAL_SOURCE_VERIFIED]` : Code de commerce Art. L. 123-22 (10 ans pour les pièces comptables).<br>`[LEGAL_HYPOTHESIS_TO_VALIDATE]` : Livre des procédures fiscales Art. L. 102 B (délai de communication fiscal de 6 ans dans la rédaction historique en vigueur au 01/09/2026, avec transition législative vers 10 ans pour la facturation électronique). | `[DPO_DECISION_REQUIRED]` : Valider la version et la durée de rétention fiscale applicables au sign-off et le protocole de purge post-10 ans. |
| **Constats d'état des matériels & Déclarations de dommages** (`condition_reports`, `damage_reports`) | **Preuve de la conformité du matériel restitué & gestion des litiges de caution** | Exécution du contrat (Art. 6.1.b) & Défense de droits (Art. 17.3.e) | PostgreSQL, Cloudflare R2 (photos) | • Accès (Art. 15, avec protection des tiers)<br>• Effacement (Art. 17) $\rightarrow$ Exclusion temporaire | Conservation probatoire temporaire pendant le délai de réclamation. | `[LEGAL_HYPOTHESIS_TO_VALIDATE]` : La prescription quinquennale de droit commun (Art. 2224 Code civil) est une base d'archivage probatoire. En l'absence de dommage signalé à la restitution, une durée plus courte (ex. 6 mois à 1 an) pourrait être proportionnée. | `[DPO_DECISION_REQUIRED]` : Arbitrer entre durée unique (5 ans) ou durée différenciée (courte si sans incident, 5 ans si litige/dégradation). |
| **Communications & Notifications transactionnelles** (`notifications`, `notification_deliveries`) | **Acheminement des notifications contractuelles & information légale** | Exécution du contrat (Art. 6.1.b) | PostgreSQL (`notifications`), Resend | • Accès (Art. 15)<br>• Effacement (Art. 17) | Purge périodique des messages anciens. | `[LEGAL_HYPOTHESIS_TO_VALIDATE]` : Durée de conservation proposée à 12 mois glissants pour l'utilité administrative. Côté sous-traitant, `[TECHNICAL_FACT_VERIFIED]` : le DPA Resend prévoit la suppression des données client sous 90 jours après fin de contrat (sans politique publique de 30 jours par message). | `[DPO_DECISION_REQUIRED]` : Valider la politique de purge de l'historique des notifications. |
| **Journal d'audit système** (`audit_log`) | **Sécurité du système d'information, traçabilité des accès & détection d'intrusions** | Sécurité des traitements (Art. 32 RGPD) & Intérêt légitime (Art. 6.1.f) | PostgreSQL (`audit_log` append-only) | • Accès (Art. 15) $\rightarrow$ Restreint<br>• Effacement (Art. 17) $\rightarrow$ **Exclu** (Art. 17.3.b/e) | Conservation intacte du journal. **Attention :** le journal contient des identifiants (`actorUserId`, `targetId`) permettant de ré-identifier indirectement une personne ; il ne peut être qualifié de « sans PII ». | `[LEGAL_HYPOTHESIS_TO_VALIDATE]` : L'article 32 impose la sécurité mais ne fixe aucun délai légal de 5 ans. La doctrine CNIL recommande généralement une durée de 6 mois à 1 an pour les logs de sécurité technique, sauf besoin probatoire spécifique. | `[DPO_DECISION_REQUIRED]` : Valider la proportionnalité de la durée de rétention des logs d'audit (1 an standard vs 5 ans pour les audits de mutations financières/régaliennes). |

---

## 2. Distinction Précise entre Droit d'Accès (Art. 15) et Portabilité (Art. 20)

Conformément aux lignes directrices du Comité Européen de la Protection des Données (CEPD / G29) et de la CNIL, le droit d'accès et le droit à la portabilité poursuivent des finalités juridiques distinctes et obéissent à des critères d'éligibilité nettement séparés.

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                          DROIT D'ACCÈS (Article 15 RGPD)                               │
│        "Obtenir la confirmation du traitement et une copie fidèle des données"         │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ • Finalité : Transparence et contrôle de la licéité des traitements.                   │
│ • Champ d'application : TOUS les traitements concernant la personne, quelle que soit   │
│   leur base légale (contrat, obligation légale, intérêt légitime, etc.).               │
│ • Nature de l'objet délivré : Copie intelligible des données personnelles traitées.   │
│   Il ne s'agit pas d'un droit à obtenir la copie brute des documents originaux de      │
│   l'entreprise, sauf si la fourniture du document est indispensable à la lisibilité.   │
│ • Informations d'accompagnement obligatoires (Art. 15.1) :                             │
│   Finalités, catégories de données, destinataires, durées de conservation, droits de   │
│   rectification/effacement/réclamation, source des données non collectées directement. │
│ • Limite impérative (Art. 15.4) : Ne doit pas porter atteinte aux droits et libertés   │
│   de tiers (protection des données personnelles d'autrui, secrets d'affaires).        │
└────────────────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────────────────┐
│                       DROIT À LA PORTABILITÉ (Article 20 RGPD)                         │
│   "Recevoir les données fournies dans un format structuré, couramment utilisé machine" │
├────────────────────────────────────────────────────────────────────────────────────────┤
│ • Finalité : Faciliter la liberté de choix et le changement de prestataire de service. │
│ • Critères d'éligibilité CUMULATIFS (Art. 20.1) :                                      │
│   1. Traitement fondé EXCLUSIVEMENT sur le Consentement (6.1.a) ou le Contrat (6.1.b). │
│   2. Traitement effectué par des procédés automatisés.                                 │
│ • Périmètre des données éligibles (Doctrine CEPD / CNIL) :                            │
│   - Données FOURNIES ACTIVEMENT et consciemment par la personne (profil, coordonnées). │
│   - Données GÉNÉRÉES PAR L'ACTIVITÉ de la personne (historique des réservations).      │
│ • EXCLUSIONS FORMELLES de la portabilité :                                             │
│   - Traitements fondés sur une obligation légale (Art. 6.1.c) ou l'intérêt légitime.  │
│   - Données DÉRIVÉES, CALCULÉES ou INFÉRÉES par le responsable (profilage, scoring,   │
│     notes internes d'instruction).                                                     │
│   - Données de tiers (informations professionnelles/bancaires des loueurs partenaires).│
│ • Format exigé : Structuré, lisible par machine (`application/json` ou `CSV`).         │
│   Les formats non structurés (ex. PDF numérisé) sont déconseillés par la CNIL.        │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### Synthèse pour arbitrage DPO :

1. **Format de réponse Art. 15 (Accès)** : Un récapitulatif structuré (JSON d'archive) accompagné des informations contextuelles de transparence et, si validé par le Juridique, des copies de factures émises sous réserve d'occultation des données sensibles de tiers.
2. **Format de réponse Art. 20 (Portabilité)** : Un fichier `application/json` standardisé contenant strictement les données déclaratives du locataire et les données brutes générées par son activité de location, à l'exclusion de toute donnée comptable ou interne.

---

## 3. Analyse des Systèmes Tiers et Sous-Traitants

Conformément à l'Article 28 du RGPD, les sous-traitants doivent assister le responsable de traitement dans la prise en compte des droits des personnes. Cependant, les politiques et statuts juridiques des prestataires tiers d'Uttily présentent des spécificités substantielles :

### A. Clerk (Authentification & Identité)
- `[TECHNICAL_FACT_VERIFIED]` : Clerk documente et met à disposition une API de gestion programmatique permettant la suppression définitive d'un compte utilisateur (`users.deleteUser()`).
- `[LEGAL_HYPOTHESIS_TO_VALIDATE]` : La suppression sur Clerk doit être coordonnée avec l'action retenue côté Uttily pour révoquer immédiatement toute session active et empêcher toute ré-authentification future.
- `[DPO_DECISION_REQUIRED]` : Confirmer que la suppression Clerk intervient dès la prise d'effet de l'effacement.

### B. Stripe (Paiements & Flux Financiers)
- `[LEGAL_SOURCE_VERIFIED]` : Stripe agit comme responsable de traitement pour certaines finalités (notamment la prévention de la fraude, la conformité réglementaire financière et bancaire LCB-FT, ainsi que le respect des obligations prudentielles) et comme sous-traitant pour d'autres (traitement technique des ordres de paiement).
- `[TECHNICAL_FACT_VERIFIED]` : Stripe propose des outils dédiés de gestion des demandes DSR (Data Subject Rights / Redaction tools). Certains objets (notamment les charges bancaires et les traces comptables) ne peuvent pas être immédiatement supprimés ou masqués par Stripe. La politique de confidentialité de Stripe indique conserver certaines données de transaction pendant **cinq ans ou davantage** selon le contexte réglementaire applicable.
- `[DPO_DECISION_REQUIRED]` : Valider la procédure d'instruction : soumission d'une demande de rédaction via les mécanismes DSR de Stripe, tout en informant le demandeur que Stripe conserve certaines données sous ses propres obligations réglementaires de responsable autonome.

### C. Cloudflare R2 (Stockage Froid de Documents)
- `[TECHNICAL_FACT_VERIFIED]` : R2 fournit un stockage objet compatible S3 permettant l'organisation en buckets distincts et l'application de règles de cycle de vie (lifecycle rules).
- `[LEGAL_HYPOTHESIS_TO_VALIDATE]` : Les documents soumis à rétention légale (factures) doivent être isolés dans un espace à accès restreint (archive intermédiaire). Les fichiers éphémères (photos temporaires d'annonces ou brouillons) doivent faire l'objet d'une purge automatique.
- `[DPO_DECISION_REQUIRED]` : Valider la politique d'archivage documentaire et l'isolation des accès.

### D. Resend (Plateforme d'Emailing Transactionnel)
- `[TECHNICAL_FACT_VERIFIED]` : Le Data Processing Addendum (DPA) standard de Resend stipule que lorsque le client met fin au service, les données utilisateur/client sont supprimées dans les **90 jours**. Cela ne constitue ni une politique de rétention opérationnelle de 90 jours pour chaque email en cours de contrat, ni un SLA individuel d'effacement DSR par message.
- `[DPO_DECISION_REQUIRED]` : Définir la politique d'instruction relative aux traces de délivrabilité d'emails chez Resend (ex. suppression de l'adresse des listes de suppression et des journaux d'envoi lorsque techniquement disponible).

---

## 4. Cadre d'Instruction pour les Demandes Partiellement Exécutables (Art. 12.4 & 17.3 RGPD)

Dans une plateforme de location d'équipements, les demandes d'effacement (**Art. 17**) se heurtent fréquemment à des motifs légitimes de conservation partielle.

### A. Principe Juridique
L'article 17.3 du RGPD prévoit que le droit à l'effacement ne s'applique pas dans la mesure où le traitement est nécessaire :
- Au respect d'une **obligation légale** qui exige le traitement (Art. 17.3.b — ex. conservation des factures pendant 10 ans selon l'article L. 123-22 du Code de commerce).
- À la **constatation, à l'exercice ou à la défense de droits en justice** (Art. 17.3.e — ex. conservation probatoire pendant le délai de prescription civile en cas de litige contractuel potentiel).

La décision de satisfaire partiellement une demande doit résulter d'une **analyse concrète par catégorie de données**, et non d'une présomption automatique mécanique.

### B. Obligation d'Information Motivée & Procédure de Transparence (Art. 12.4 RGPD)
- `[LEGAL_SOURCE_VERIFIED]` : L'Article 12.4 du RGPD impose littéralement que lorsque le responsable du traitement « ne donne pas suite à la demande », il informe la personne sans tarder des motifs du refus et des voies de recours (réclamation CNIL et recours juridictionnel).
- `[LEGAL_HYPOTHESIS_TO_VALIDATE]` : En cas de satisfaction partielle (ex. suppression du compte d'accès mais conservation sous scellé des factures 10 ans), l'application stricte de l'Art. 12.4 à la fraction non exécutée est une **procédure de transparence et de prudence opérationnelle recommandée par Uttily**. Le Pôle Juridique confirmera si cette motivation détaillée et la mention des voies de recours doivent être obligatoirement notifiées pour toute clôture partielle.
- **Contenu recommandé de la notification** :
  1. Mesures concrètement exécutées (suppression du compte, révocation des accès).
  2. Motifs juridiques précis des données maintenues sous scellé (obligation légale L. 123-22 Code de commerce).
  3. Mention explicite des voies de recours : réclamation auprès de la **CNIL** (`www.cnil.fr`) et recours juridictionnel.

### C. Articulation avec le Cockpit Support (21-P1A)
- **Étape 1** : L'opérateur enregistre la décision motivée `resolution = 'PARTIALLY_FULFILLED'` (ou `REFUSED` en cas d'obstacle intégral, ex. litige en cours). La demande passe en `DECISION_READY` et reste active.
- **Étape 2** : L'opérateur adresse la notification légale motivée au demandeur comportant les motifs et les voies de recours.
- **Clôture** : L'opérateur atteste de l'envoi de la réponse $\rightarrow$ la demande passe en `COMPLETED`.

---

## 5. Démarcation Stricte : Cadrage DPO vs Plan d'Ingénierie Technique

Pour respecter l'autorité du DPO et les préconisations du G29 et de la CNIL, les choix d'architecture logicielle sont strictement disjoints du présent dossier de décision :

### A. Rappel doctrinal sur l'Anonymisation vs Pseudonymisation (G29 / CNIL)
- **Pseudonymisation (Art. 4.5 RGPD)** : Traitement de données personnelles de telle façon qu'elles ne puissent plus être attribuées à une personne concernée sans avoir recours à des informations supplémentaires. Remplacer un email par un pseudonyme ou un identifiant UUID tout en conservant des liens relationnels avec des réservations, dates et montants constitue une **pseudonymisation**. La donnée **demeure une donnée à caractère personnel** soumise au RGPD.
- **Anonymisation** : Processus d'altération irréversible rendant impossible l'identification directe ou indirecte de la personne. La CNIL et le G29 évaluent l'anonymisation à travers trois critères cumulatifs :
  1. **Individualisation** : Est-il toujours possible d'isoler un individu dans le jeu de données ?
  2. **Corrélation** : Est-il possible de relier entre eux des enregistrements distincts concernant un même individu ?
  3. **Inférence** : Peut-on déduire avec une quasi-certitude des informations sur un individu ?

### B. Périmètre du futur Plan d'Ingénierie P1B (post-validation DPO)
Une fois que le DPO aura statué sur `DPO-003` et `DPO-004`, l'équipe d'ingénierie soumettra un plan d'implémentation technique (`21-p1b-technical-plan.md`) décrivant :
- Les mécanismes de neutralisation retenus (suppression physique, anonymisation par rupture de clés, séparation logique/physique d'une base d'archivage intermédiaire à accès restreint).
- Les contrats de Server Actions et mutations de domaine autorisées.
- Les générateurs de flux d'export JSON (Art. 15 et Art. 20).
- Les tests d'intégration PostgreSQL garantissant l'atomicité et la non-régression.

---

## 6. Registre des Preuves Juridiques & Techniques (Evidence Register)

Le tableau ci-dessous recense et fige formellement chaque source juridique et technique citée dans le présent dossier, avec sa version exacte, sa date d'effet, son énoncé vérifié et ses limites d'interprétation.

| Source | Version / Date d'effet | Consulté le | Énoncé exactement supporté | Ce que cette source ne décide pas |
| :--- | :--- | :--- | :--- | :--- |
| **Code de commerce, Art. L. 123-22** | Version consolidée en vigueur (Loi n° 2008-776) | 03/09/2026 | « Les documents comptables et les pièces justificatives sont conservés pendant dix ans. » | Ne définit pas les modalités techniques d'archivage (scellé logique vs physique, chiffrement) ni le sort des données accessoires non comptables. |
| **Livre des procédures fiscales (LPF), Art. L. 102 B** | Version en vigueur jusqu'au 01/09/2026 (6 ans) / Version issue de la réforme de facturation électronique prévoyant 10 ans au premier alinéa (applicable 01/01/2027) | 03/09/2026 | Impose la conservation des livres, registres et documents fiscaux soumis au droit de communication de l'administration (historiquement 6 ans, en transition législative vers 10 ans pour la facturation électronique). | Ne tranche pas la date exacte de bascule fiscale applicable au pilote Uttily ; arbitrage formel requis du Pôle Juridique. |
| **Code civil, Art. 2224** | Version en vigueur (Loi n° 2008-561) | 03/09/2026 | « Les actions personnelles ou mobilières se prescrivent par cinq ans à compter du jour où le titulaire d'un droit a connu ou aurait dû connaître les faits lui permettant de l'exercer. » | Ne constitue pas une obligation générale de conservation de 5 ans de l'intégralité d'un dossier de location ; fournit une base pour justifier un archivage probatoire intermédiaire, dont le point de départ et la nécessité doivent être validés par le Juridique. |
| **RGPD (Règlement UE 2016/679), Art. 12, 15, 17, 20** | Version officielle JOUE L 119 du 04/05/2016 | 03/09/2026 | • Art. 12 : Délais de réponse (1 mois) et obligations d'information sur les motifs de refus et voies de recours (Art. 12.4).<br>• Art. 15 : Droit d'obtenir confirmation et copie des données traitées, sans porter atteinte aux tiers.<br>• Art. 17 : Droit à l'effacement et exceptions légales (Art. 17.3).<br>• Art. 20 : Portabilité des données fournies, automatisées, sur base consentement/contrat, en format structuré lisible machine. | Ne spécifie pas les formats techniques précis (JSON, CSV) ni la cartographie applicative propre au modèle de données d'Uttily. |
| **Clerk Backend API Documentation** | Version API v1 (`@clerk/backend`) | 03/09/2026 | `DELETE https://api.clerk.com/v1/users/{user_id}` supprime définitivement l'utilisateur de l'annuaire d'authentification Clerk. | Ne décide ni si ni quand Uttily doit appeler cette suppression dans le cycle de vie d'une demande d'effacement. |
| **Stripe Privacy Center & DSR Tools Documentation** | Version en vigueur (stripe.com/legal/privacy-center) | 03/09/2026 | Stripe agit comme responsable de traitement pour la conformité LCB-FT et la prévention de la fraude, et conserve certaines données pendant 5 ans ou plus. Fournit des outils de rédaction DSR pour masquer certaines données sous-traitées. | Ne dispense pas Uttily de recueillir et transmettre les demandes de droits, ni de qualifier les responsabilités partagées. |
| **Resend Data Processing Addendum (DPA)** | Version standard en vigueur (resend.com/legal/dpa) | 03/09/2026 | Section relative à la fin de service : Resend supprime les données client dans un délai de 90 jours suivant la résiliation du contrat. | Ne constitue pas une politique générale de purge à 30 ou 90 jours pour les logs de messages transactionnels en cours d'exécution du contrat. |
