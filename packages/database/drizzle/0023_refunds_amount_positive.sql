-- Migration 0023 : Contrainte refunds_amount_positive stricte (> 0)
--
-- Un refund de montant 0 n'a aucun sens métier. La contrainte précédente
-- autorisait >= 0, ce qui était incohérent avec la validation applicative
-- (amount > 0 pour les nouveaux refunds). Alignement de la contrainte DB.
-- Le nom `refunds_amount_positive` décrit désormais correctement `> 0`.
--
-- Stratégie upgrade : si des refunds à montant 0 existent en production,
-- la migration échouera intentionnellement (fail-closed). Ces lignes
-- doivent être auditées manuellement avant migration :
--   SELECT * FROM refunds WHERE amount_minor = 0;
-- Aucune suppression ou modification automatique de données financières
-- sans décision explicite (AGENTS.md).

ALTER TABLE "refunds" DROP CONSTRAINT "refunds_amount_nonneg";
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_amount_positive" CHECK ("refunds"."amount_minor" > 0);
