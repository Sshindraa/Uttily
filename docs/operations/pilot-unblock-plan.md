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
| `C2A-01` | CGU / CGV client absentes | `LEGAL-001` | Juridique + porteur produit | `READY_FOR_HUMAN_DECISION` | Aucun texte publié ; les snapshots et la version `v1` existent techniquement. | Fournir le texte client versionné, sa date d'effet et la preuve d'approbation. | Oui |
| `C2A-02` | Version des terms | `LEGAL-001` | Juridique | `READY_FOR_HUMAN_DECISION` | `legalTermsVersion: 'v1'` côté serveur et `v1` envoyé par le checkout. | Confirmer la version active et son document source ; ne pas valider `v1` par défaut. | Oui |
| `C2A-03` | Snapshot d'acceptation | `LEGAL-001` | Juridique + porteur produit | `READY_FOR_HUMAN_DECISION` | `terms_acceptance_snapshot` persiste actuellement version, acteur et date, mais référence un document absent. | Décrire et approuver la chaîne UI/document/action/horodatage/acteur/snapshot/référence. | Oui |
| `C2A-04` | Conditions Pro / contrat loueur absents | `LEGAL-002` | Juridique + porteur produit | `READY_FOR_HUMAN_DECISION` | Aucun texte ni mécanisme d'acceptation Pro trouvé. | Rédiger le contrat Pro, sa version et son mode de collecte auprès du partenaire pilote. | Oui |
| `C2A-05` | Politiques d'annulation | `LEGAL-004`, `LEGAL-005` | Juridique + finance + produit | `READY_FOR_HUMAN_DECISION` | Le code applique `FLEXIBLE`/`MODERATE`/`FIRM` et la grâce `GRACE_WINDOW_24H`; Lot 4 reste en attente. | Valider seuils, grâce, exceptions et base remboursable par écrit. | Oui |
| `C2A-06` | Base de calcul des refunds | `LEGAL-005`, `FIN-002` | Juridique + finance | `READY_FOR_HUMAN_DECISION` | Le code calcule sur `booking.totalAmountMinor` (option A / total TTC) ; le choix Lot 4 est ouvert. | Choisir et versionner la base, puis comparer explicitement au comportement actuel. | Oui |
| `C2A-07` | Annulation horaire 30 minutes | `LEGAL-004` | Juridique + produit | `READY_FOR_HUMAN_DECISION` | Aucun calcul horaire de 30 minutes n'est implémenté ; question G7B-R3 ouverte. | Confirmer une règle horaire ou exclure les offres horaires du pilote ; déclencher le chantier code seulement après. | Oui |
| `C2A-08` | Dommages / dégâts matériels | `LEGAL-002`, `LEGAL-003` | Juridique + produit | `READY_FOR_HUMAN_DECISION` | `damage_reports`, `condition_reports`, `maintenance_cases` existent ; aucun barème ni clause n'est fixé. | Valider responsabilité, preuve d'état, barème, délais et contestation. | Oui |
| `C2A-09` | Retrait / restitution | `LEGAL-003` | Juridique + produit | `READY_FOR_HUMAN_DECISION` | Les états fulfillment existent ; les clauses de retard, état des lieux et litige manquent. | Documenter les clauses correspondant au parcours réellement opéré. | Oui |
| `C2A-10` | Responsabilité | `LEGAL-002`, `LEGAL-003` | Juridique | `READY_FOR_HUMAN_DECISION` | Aucun mécanisme technique ne tranche responsabilité, limitation ou transfert. | Attribuer contractuellement les responsabilités et exclusions du pilote. | Oui |
| `C2A-11` | Caution / dépôt de garantie | `FIN-007`, `LEGAL-002` | Finance + juridique + produit | `READY_FOR_HUMAN_DECISION` | Le modèle liste six stratégies ; ADR-010 exclut la caution du PaymentIntent ; aucune stratégie n'est choisie. | Choisir une stratégie ou confirmer `NO_DEPOSIT`/exclusion pilote, avec montant, durée et responsabilité. | Oui |
| `C2B-01` | Merchant / settlement | `FIN-001`, `LEGAL-007` | Finance + juridique | `READY_FOR_HUMAN_DECISION` | Destination charge ; code `PLATFORM`, `onBehalfOfAccountId: null`; Lot 5-A non rendu. | Répondre aux six questions de responsabilité et confirmer le modèle contractuel. | Oui |
| `C2B-02` | Frais marketplace | `FIN-002` | Finance + porteur produit | `READY_FOR_HUMAN_DECISION` | Décision produit enregistrée dans `ADR-029` : `split-13-7-v1`, base `subtotal + mandatory fees`, frais loueur 13 % + frais service client 7 %, `HALF_UP_PER_COMPONENT`, sans fixe. Non approuvé LIVE. | Valider base fiscale, date d'effet, TVA, frais Stripe, refunds, chargebacks, litiges, soldes négatifs et responsabilités. | Oui |
| `C2B-03` | Statut fiscal / TVA | `FIN-003` | Expert-comptable + juridique | `READY_FOR_HUMAN_DECISION` | **CURRENT CODE BEHAVIOR :** `NOT_APPLICABLE`, montant et taux null ; la valeur est hard-codée. | Répondre `APPLIED` ou `NOT_APPLICABLE`, avec règle, taux, entité et date d'effet. | Oui |
| `C2B-04` | Émetteur de facture | `FIN-004` | Expert-comptable + juridique | `READY_FOR_HUMAN_DECISION` | **CURRENT CODE BEHAVIOR :** `invoiceIssuer: 'Uttily'` est propagé aux snapshots. | Confirmer l'émetteur juridiquement habilité et les mentions associées. | Oui |
| `C2B-05` | Reçus / factures / documents financiers | `FIN-004`, `FIN-005` | Finance + juridique | `READY_FOR_HUMAN_DECISION` | Pipeline de documents, snapshots et outbox présents ; contenu et mentions obligatoires non validés. | Valider le catalogue par événement, destinataire, version et conservation. | Oui |
| `C2B-06` | Exécution et communication des refunds | `FIN-006`, `LEGAL-005` | Finance + juridique | `READY_FOR_HUMAN_DECISION` | Worker/cron et compensation tardive existent ; délai et message client restent ouverts. | Approuver délai, texte, frais non récupérables, notification loueur et escalade. | Oui |
| `C2B-07` | Amendements financiers / mentions | `LEGAL-006`, `FIN-005`, `FIN-006` | Juridique + finance | `READY_FOR_HUMAN_DECISION` | G7M/ADR-023 livrés ; mentions, fiscalité des suppléments et message d'échec restent à valider. | Valider les mentions et le traitement de chaque scénario amendement/refund/supplément. | Oui |
| `C2B-08` | Conditions Stripe Connect / responsabilités partenaire | `LEGAL-007`, `FIN-001` | Juridique + finance | `READY_FOR_HUMAN_DECISION` | ADR-010/024/025 et projection serveur existent ; acceptation partenaire non tracée dans Uttily. | Obtenir la preuve d'acceptation et confirmer la répartition frais/pertes/litiges. | Oui |
| `C2C-01` | Politique de confidentialité absente | `DPO-001`, `DPO-002` | DPO + juridique | `READY_FOR_HUMAN_DECISION` | Aucune politique publiable sous `apps/`, `packages/` ou `public/`. | Produire, relire et versionner la politique applicable au pilote. | Oui |
| `C2C-02` | Finalités | `DPO-001` | DPO | `READY_FOR_HUMAN_DECISION` | Aucun registre des finalités ; le code ne permet pas d'inférer une base juridique. | Remplir le registre des traitements avec finalité, personne, responsable et base choisie. | Oui |
| `C2C-03` | Rétention annoncée | `DPO-002` | DPO + juridique | `READY_FOR_HUMAN_DECISION` | Analytics raw 90 jours / agrégats 24 mois techniquement décrits, mais aucune annonce publique. | Fixer les durées par catégorie et les publier avec la politique versionnée. | Oui |
| `C2C-04` | Effacement / anonymisation | `DPO-003` | DPO + juridique + engineering | `READY_FOR_HUMAN_DECISION` | Aucun mécanisme client ; documents, snapshots, ledger et audit ont des contraintes de conservation. | Définir périmètre, exceptions et journalisation ; ouvrir `PRIVACY-ERASURE` seulement après décision. | Oui |
| `C2C-05` | Export / portabilité client | `DPO-004` | DPO + engineering | `READY_FOR_HUMAN_DECISION` | Seul export observé : CSV financier du loueur ; aucun export client. | Définir données, format, exclusions et délai ; ouvrir `PRIVACY-EXPORT` ensuite si requis. | Oui |
| `C2C-06` | Accès / rectification / opposition | `DPO-003` | DPO + juridique | `READY_FOR_HUMAN_DECISION` | Aucun point d'entrée ni procédure documentée pour ces droits. | Définir la procédure et le périmètre technique futur ; ne pas coder dans 21-P0. | Oui |
| `C2C-07` | Sous-traitants / DPA / transferts | `DPO-005` | DPO + juridique | `READY_FOR_HUMAN_DECISION` | Fournisseurs identifiés ; DPA, localisation et transfert non vérifiés dans la base. | Vérifier chaque fournisseur avec propriétaire, méthode, document et résultat. | Oui |
| `C2E-01` | Informations légales du partenaire Pro | `PARTNER-001` | Porteur produit + juridique | `READY_FOR_HUMAN_DECISION` | `organizations` ne porte que `legalName`/`slug`; SIRET, TVA, forme, siège et représentant absents. | Faire remplir le dossier partenaire, collecter les pièces hors dépôt sensible et vérifier chaque champ. | Oui |
| `C2E-02` | Facturation partenaire | `FIN-008` | Finance + expert-comptable | `READY_FOR_HUMAN_DECISION` | Aucun modèle de facturation partenaire ni cadence n'est présent. | Décrire le processus de commission, facture/avoir, règlement et rapprochement. | Oui |
| `C2E-03` | Connected Account LIVE partenaire | `PARTNER-002`, `FIN-001`, `LEGAL-007` | Finance + produit + partenaire | `READY_FOR_HUMAN_DECISION` | Readiness vérifie projection serveur, `chargesEnabled`/onboarding ; aucun compte LIVE pilote rattaché. | Terminer onboarding autorisé, vérifier compte/capacités par webhook et conserver une preuve non secrète. | Oui |
| `C2E-04` | Credentials Stripe LIVE | `OPS-004`, `PARTNER-002` | Engineering + porteur produit | `READY_FOR_HUMAN_DECISION` | Environnement documenté TEST, `PAYMENTS_LIVE_ENABLED=false`; aucun secret LIVE dans le dépôt. | Configurer hors dépôt après clôture des décisions, puis exécuter la readiness LIVE réelle. | Oui |
| `C2E-05` | Webhooks Stripe LIVE | `OPS-004` | Engineering + porteur produit | `READY_FOR_HUMAN_DECISION` | Les deux secrets webhook sont vides en local ; routes et garde-fous existent. | Créer/configurer les endpoints Platform et Connect, fournir les secrets au runtime hors dépôt et vérifier les signatures. | Oui |

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

Le drill local est toutefois déjà prouvé séparément :
`LOCAL RESTORE DRILL = PASS`. Il ne coche pas les vérifications provider de
backup, restore production ou RPO/RTO.

## Sujets humains non bloquants à conserver

| Sujet | Decision ID(s) | État actuel | Next action |
| --- | --- | --- | --- |
| Établissement et données opératoires | `PARTNER-001` | `NOT_PROVIDED` dans le dossier préparatoire | Collecter adresse, horaires, inventaire, catégories, tailles, prix et consignes ; vérifier avant publication. |
| Analytics PRODUCTION | `DPO-006` | `OFF` par construction | Maintenir OFF ; toute activation future nécessite une décision DPO séparée. |
| Purge/rétention analytics | `DPO-002`, `DPO-006` | Techniquement câblée, décision documentaire attendue | Référencer la politique DPO et ses durées sans changer le code. |
| Géocodage fournisseur | `LEGAL-008` | PostgreSQL/PostGIS canonique ; Photon/IGN différés | Vérifier droits, localisation et cache avant toute ingestion future. |
