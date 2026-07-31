-- Migration 0020 : Contrainte d'unicité d'une seule tentative non terminale par paiement
-- et provider_status nullable avant la projection fournisseur (ADR-010).
--
-- 1. Rendre provider_status nullable : aucun statut Stripe n'existe avant l'appel fournisseur.
-- 2. Ajouter une contrainte CHECK : si provider_payment_intent_id est renseigné,
--    provider_status doit être renseigné (un objet Stripe a toujours un statut).
-- 3. Ajouter un index unique partiel garantissant une seule tentative non terminale par paiement.

-- 1. Rendre provider_status nullable
ALTER TABLE "payment_attempts" ALTER COLUMN "provider_status" DROP NOT NULL;

-- 2. Contrainte de cohérence : provider_payment_intent_id implique provider_status
ALTER TABLE "payment_attempts"
  ADD CONSTRAINT "payment_attempts_provider_status_with_intent"
  CHECK ("provider_payment_intent_id" IS NULL OR "provider_status" IS NOT NULL);

-- 3. Index unique partiel : une seule tentative non terminale par paiement
CREATE UNIQUE INDEX "payment_attempts_single_non_terminal_attempt"
  ON "payment_attempts" ("payment_id")
  WHERE "status" IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING');
