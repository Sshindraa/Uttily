# Rapport de Simulation E2E — Drill "Samedi Type" d'Exploitation (Lot 21-S1)

**Date d'exécution :** 2026-09-03  
**Environnement de validation :** PostgreSQL 17 + PostGIS 3 + btree_gist (`postgresql://uttily:uttily@127.0.0.1:5432/uttily`)  
**Statut du test d'intégration :** `PASS` (100% vert, exécution en ~1.1s)  
**Commande de reproduction :** `DATABASE_URL=postgresql://uttily:uttily@127.0.0.1:5432/uttily pnpm drill:saturday`  
**Fichiers de preuve :**
- Test d'intégration automatisé : [`packages/core/src/integration/saturday-drill.integration.test.ts`](file:///Users/hamza/Projects/Uttily/packages/core/src/integration/saturday-drill.integration.test.ts)
- Script runner autonome : [`scripts/saturday-drill.mjs`](file:///Users/hamza/Projects/Uttily/scripts/saturday-drill.mjs)

---

## 1. Objectif du Drill & Périmètre Opérationnel

Le drill **Lot 21-S1** a pour mission de valider de bout en bout sur une base PostgreSQL locale réelle le cycle de vie opérationnel complet d’un samedi d’exploitation typique (08h00 - 20h30) dans une boutique de location partenaire Uttily.

Il combine et éprouve l'interopérabilité des composants livrés au cours des chantiers récents :
- **Lot 21-O1** : Identité légale et fiscale du loueur partenaire (SIRET, TVA, RCS, Siège social).
- **Lot 21-F1** : Mentions légales obligatoires sur les documents financiers et génération du décompte de commissions loueur officiel.
- **Lot 21-U2-AD** : Réservation comptoir walk-in avec règlement par carte sur TPE physique.
- **Lot 21-U2-AA** : Détection d'incident matériel avant départ et substitution atomique d'exemplaire sans violation d'exclusion GiST.
- **Lot 21-U2-AB** : Déclaration de dommage au retour et mise en indisponibilité maintenance automatique.
- **Lot 21-P1** : Fondation RGPD (Droits d'accès Art. 15, Portabilité Art. 20, conformité audit log zéro PII).

---

## 2. Déroulé Chronologique des Phases (08h00 - 20h30)

```
08h00 ────── Setup Organisation Loueur (Mentions légales SAS, SIRET, TVA, Siège)
  │
08h30 ────── Réservation Web préalable Client A (Item 1 & Item 2, CONFIRMED)
  │
09h00 ────── Réservation Walk-in Comptoir Client B (Item 3, TPE ON_SITE_CARD)
  │
09h30 ────── Départ Client A : Pneu crevé sur Item 1 ──► Substitution atomique par Item 4
  │          Constats de départ contradictoires (PICKUP / GOOD) ──► ACTIVE
  │
10h00 ────── Départ Client B : Constat de départ (PICKUP / GOOD) ──► ACTIVE
  │
13h00 ────── Retour Nominal Client B : Constat retour (RETURN / GOOD) ──► CLOSED
  │
14h00 ────── Prolongation Client A : Extension de créneau sous contrainte GiST
  │
19h30 ────── Retour Client A : Dérailleur tordu sur Item 2 (BROKEN)
  │          Déclaration formelle dommage ──► Blocage automatique MAINTENANCE 24h
  │          Clôture Client A ──► CLOSED
  │
20h00 ────── Clôture Financière & Décompte de Commissions Loueur CSV officiel
  │
20h30 ────── Vérification d'Intégrité Audit Log (zéro PII) & Export RGPD Art. 15 / 20
```

---

## 3. Détail des Validations par Phase

### Phase 1 : 08h00 - Setup Organisation & 08h30 - Réservation Web Client A
- **Organisation :** *Alpes Cycles Pro*, SAS, SIRET `84920485900012`, TVA `FR12849204859`, RCS Annecy, 12 avenue du Lac 74000 Annecy.
- **Flotte :** 5 gravels électriques créés avec SKU traçables.
- **Réservation Web Client A :** 2 vélos (`BIKE-001` et `BIKE-002`) réservés pour la journée avec buffer de 15 minutes. Blocs `inventory_blocks` GiST verrouillés à l'état `ACTIVE`.

### Phase 2 : 09h00 - Réservation Comptoir Walk-in Client B (Lot 21-U2-AD)
- **Action :** Appel de `createCounterBooking(db, ...)`.
- **Paramètres :** Canal `WALK_IN`, règlement `ON_SITE_CARD` (TPE comptoir), allocation directe de `BIKE-003`.
- **Résultat vérifié :** Statut `CONFIRMED`, référence `#UT-XXXXXX`, écriture de l'action `BOOKING_CREATED_AT_COUNTER`.

### Phase 3 : 09h30 - Départ Client A, Détection crevaison & Substitution (Lot 21-U2-AA)
- **Préparation :** Passage à `READY_FOR_PICKUP` via `prepareBooking`.
- **Incident :** Pneu crevé détecté sur `BIKE-001`.
- **Substitution atomique :** Appel de `substituteBookingItem` pour remplacer `BIKE-001` par `BIKE-004` (disponible).
- **Vérification GiST :** La réattribution du bloc GiST et le swap de l'exemplaire s'exécutent sans conflit `no_overlapping_blocks`.
- **Constats contradictoires :** Établissement de 2 constats de départ `PICKUP` (`GOOD`).
- **Remise des clés :** Appel de `pickupBooking`, passage à `ACTIVE`.

### Phase 4 : 10h00 - Départ Client B (Walk-in)
- Préparation de la commande, constat `PICKUP` et remise des clés via `pickupBooking` -> `ACTIVE`.

### Phase 5 : 13h00 - Retour Nominal Client B
- Restitution de `BIKE-003`, constat `RETURN` (`GOOD`), retour via `returnBooking` (`RETURNED`), clôture via `closeBooking` (`CLOSED`).

### Phase 6 : 14h00 - Prolongation Client A
- Client A prolonge son excursion. Extension des dates de fin client et de blocage physique dans `inventory_blocks`.
- Vérification de la non-régression de l'immutabilité financière du snapshot de commande (ADR-023).
- Traçabilité enregistrée dans le journal d'audit.

### Phase 7 : 19h30 - Retour Client A avec Dommage sur Vélo 2 & Maintenance (Lot 21-U2-AB)
- Restitution des 2 vélos : `BIKE-004` en bon état, `BIKE-002` avec dérailleur tordu suite à une chute.
- Constat de retour contradictoire sur `BIKE-002` avec état `BROKEN`.
- Appel de `createDamageReport(db, { blocksInventory: true, severity: 'MAJOR', ... })`.
- **Conséquences vérifiées en base :**
  - Exemplaire `BIKE-002` marqué immédiatement `condition = 'BROKEN'`.
  - Bloc d'indisponibilité `type = 'MAINTENANCE'` créé dans `inventory_blocks` (`[now(), 9999-12-31]`).
  - Dossier atelier ouvert dans `maintenance_cases` (`status = 'OPEN'`).
  - Clôture du dossier de location Client A via `closeBooking` (`CLOSED`).

### Phase 8 : 20h00 - Clôture Financière & Décompte de Commissions Loueur (Lot 21-F1)
- Calcul du read-model financier du loueur via `getMerchantFinanceOverview(db, orgId)`.
- Génération du décompte officiel via `generateCommissionStatementCsv`.
- **Vérifications contractuelles et légales :**
  - Entête légal Uttily SAS (Capital 10 000 €, SIREN 987 654 321).
  - Identité complète du loueur partenaire (Raison sociale, Forme juridique SAS, SIRET, TVA, RCS Annecy, Adresse du siège).
  - Ventilation des ventes brutes, commissions et montants nets reversés.

### Phase 9 : 20h30 - Contrôle d'Intégrité Audit Log & Export RGPD (Lot 21-P1)
- **Audit Log :**
  - Présence de la chaîne complète des actions : `BOOKING_CREATED_AT_COUNTER`, `SUBSTITUTED`, `BOOKING_PREPARED`, `BOOKING_PICKED_UP`, `BOOKING_RETURNED`, `BOOKING_CLOSED`.
  - Vérification stricte : **zéro PII** du client web dans les métadonnées de l'audit log.
- **Droits RGPD Client A :**
  - `buildPersonalDataCopy(db, clientAId)` retourne la vue d'accès Art. 15 complète (profil, réservations `CLOSED`, boutique Annecy) sans secrets techniques (zéro ID Stripe, zéro clé de stockage R2).
  - `buildPortableData(db, clientAId)` produit le dataset structuré contractuel Art. 20 conforme.

---

## 4. Invariants Système Validés par le Drill

| Invariant | Mécanisme PostgreSQL / Core | Résultat au Drill |
| --- | --- | --- |
| **Exclusion GiST multi-créneaux** | Contrainte `no_overlapping_blocks` sur `inventory_blocks` | **RESPECTÉ** (Réservations, substitutions et maintenance coexistent sans violation) |
| **Immutabilité des snapshots financiers** | Triggers `bookings_financial_snapshot_immutable` et `payments_marketplace_fee_snapshot_immutable` | **RESPECTÉ** (Préservation absolue des snapshots initiaux) |
| **Transitions d'états d'exploitation** | Machine à états `CONFIRMED -> READY_FOR_PICKUP -> ACTIVE -> RETURNED -> CLOSED` | **RESPECTÉ** (Exécution sur 2 dossiers distincts) |
| **Audit Log append-only et Privacy** | Immutabilité table `audit_log`, exclusion stricte de PII | **RESPECTÉ** (0 fuite PII observée) |
| **Transparence légale et fiscale B2B** | Conformité Code de commerce / CGI sur reçus, contrats et décomptes CSV | **RESPECTÉ** (Mentions obligatoires vérifiées) |

---

## 5. Conclusion & Sign-Off

Le cycle opérationnel complet d’un samedi d’exploitation est **intégralement démontré et validé sur le moteur PostgreSQL réel**.
Le **Lot 21-S1** valide formellement la cohérence opérationnelle des chantiers 21-O1, 21-F1, 21-U2-AA, 21-U2-AB, 21-U2-AD et 21-P1 avant tout pilote terrain.
