# Runbook 21-P1 — Traitement des demandes d'exercice de droits RGPD

**Référence légale :** RGPD Articles 12 à 23, Article 15 (Accès), Article 16 (Rectification), Article 17 (Effacement), Article 18 (Limitation), Article 20 (Portabilité), Article 21 (Opposition).  
**Décisions associées :** `DPO-003`, `DPO-004`.  
**Délai d'instruction légal :** 1 mois calendaire (Art. 12.3). Prolongation possible de 2 mois en cas de complexité, avec notification obligatoire dans le 1er mois.

---

## 1. Réception et qualification de la demande

1. **Recherche de la demande :**  
   Dans la table `privacy_requests`, identifier la demande par son `id` UUID ou `user_id`.
   Vérifier le statut initial `RECEIVED` et la date d'échéance calculée `response_due_at` (+1 mois calendaire).

2. **Vérification d'identité (Garde-fous CNIL) :**  
   - Si la demande émane d'un compte utilisateur authentifié et actif, **l'identité est présumée établie**.
   - Ne **PAS** exiger systématiquement une copie de pièce d'identité.
   - Ne passer en `IDENTITY_CHECK_REQUIRED` qu'en cas de **doute raisonnable** (incohérence d'email, activité suspecte, signalement de compromission).

---

## 2. Procédure par nature de demande

### A. Droit d'accès (Art. 15) — `ACCESS`
- **Capacité technique en libre-service :** Le client peut télécharger son export JSON via `GET /api/account/privacy/export` (namespace `article15_personal_data_copy`).
- **Instruction DPO :** La réponse juridique complète comporte également les informations sur les finalités, catégories, destinataires et durées de conservation (couvertes par la Politique de Confidentialité `/privacy`).
- **Clôture :** Si la demande était formulée via ticket/formulaire, confirmer la mise à disposition de l'export, puis passer le statut à `FULFILLED` avec horodatage `resolved_at = now()`.

### B. Droit à la portabilité (Art. 20) — `PORTABILITY`
- **Capacité technique en libre-service :** Le client peut télécharger son export JSON via `GET /api/account/privacy/export?scope=portability` (namespace `article20_portable_data`).
- **Vérification DPO :** Vérifier que les données transmises ne portent pas atteinte aux droits et libertés de tiers (les coordonnées du loueur ou d'autres locataires ne doivent pas y figurer).
- **Clôture :** Passer le statut à `FULFILLED` avec `resolved_at = now()`.

### C. Droit de rectification (Art. 16) — `RECTIFICATION`
- Vérifier l'exactitude des pièces fournies par le locataire.
- Mettre à jour les informations factuelles erronées dans la table `users` (nom d'affichage, coordonnées).
- **Interdiction formelle :** Ne jamais modifier les snapshots contractuels, factures ou écritures comptables déjà émises (obligations légales de conservation et intégrité de preuve).
- Passer le statut à `FULFILLED`.

### D. Droit à l'effacement / oubli (Art. 17) — `ERASURE`
- **Attention (Dette connue P2 — `PRIVACY-ERASURE`) :** Le mécanisme automatisé d'effacement/pseudonymisation n'est pas encore déployé dans 21-P1 (`REQUEST_INTAKE_ONLY`).
- **Règles de conservation applicables :**
  - **Obligation légale (Art. 17.3.b RGPD & Code de commerce L. 123-22) :** Les factures, reçus et pièces comptables doivent être conservées **10 ans**. Elles ne peuvent pas être supprimées.
  - **Audit append-only :** Les traces d'audit `audit_log` ne peuvent pas subir de `DELETE`.
- **Action opérateur :** Passer la demande en `IN_REVIEW`. Si un refus partiel ou total s'impose au titre de la conservation probatoire, notifier le demandeur avec le motif `LEGAL_RETENTION_OBLIGATION` ou `LITIGATION_HOLD`.

### E. Droit d'opposition (Art. 21) & Limitation (Art. 18) — `OPPOSITION` / `RESTRICTION`
- Vérifier si le traitement contesté repose sur l'intérêt légitime d'Uttily.
- Les communications marketing non sollicitées doivent être interrompues immédiatement.
- En cas de refus légitime, passer en `REFUSED` avec `decision_reason_code` approprié.

---

## 3. Prolongation de délai (+2 mois)

Si la demande présente une complexité particulière :
1. Informer impérativement le demandeur **avant l'expiration du premier mois**.
2. Mettre à jour `privacy_requests.extended_until` à la date calculée (+2 mois calendaires).
3. Consigner la justification dans `resolution_notes`.

---

## 4. Clôture et traçabilité d'audit

- Pour toute clôture (`FULFILLED`, `PARTIALLY_FULFILLED`, `REFUSED`, `CANCELLED`) :
  - Renseigner `resolved_at = now()`.
  - En cas de refus, renseigner impérativement `decision_reason_code` parmi les 7 valeurs fermées de l'enum PostgreSQL `privacy_decision_reason`.
  - Écrire une trace d'audit système via `writeAuditEntry` :
    ```ts
    await writeAuditEntry(db, {
      actorUserId: operatorUser.id,
      action: 'PRIVACY_REQUEST_STATUS_CHANGED',
      targetType: 'PRIVACY_REQUEST',
      targetId: request.id,
      metadata: { fromStatus, toStatus, decisionReasonCode },
    });
    ```
  - **Règle absolue (ADR-016) :** Aucun message libre, aucun email, aucun PII dans `metadata` de l'audit log.
