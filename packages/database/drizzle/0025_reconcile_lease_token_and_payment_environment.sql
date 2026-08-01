-- Token de lease UUID pour fencing atomique (P1-2, P1-4).
-- Permet à verifyAndHoldLease de faire un UPDATE conditionnel id+token
-- au lieu d'un SELECT non atomique.
ALTER TABLE "payment_attempts" ADD COLUMN "reconcile_lease_token" uuid;

-- Environnement Stripe du paiement (P1-3).
-- Permet au claim de réconciliation de filtrer par environnement
-- pour éviter de traiter un paiement LIVE avec un adapter TEST.
-- L'enum payment_environment existe déjà (créé au Lot 5 pour
-- organization_payment_accounts et payment_webhook_events).
-- La colonne est créée SANS NOT NULL d'abord pour permettre le backfill.
ALTER TABLE "payments" ADD COLUMN "environment" payment_environment;

-- Backfill : dériver l'environnement depuis organization_payment_accounts.
-- Échouer sur les correspondances absentes ou ambiguës (pas de défaut silencieux).
DO $$
DECLARE
  ambiguous_count integer;
  missing_count integer;
BEGIN
  -- Paiements avec correspondance ambiguë (TEST + LIVE pour le même compte + org).
  -- P2-5 : AND p."environment" IS NULL pour l'idempotence défensive (si la
  -- migration est rejouée sur une base déjà backfillée, ne rien re-vérifier).
  SELECT COUNT(*) INTO ambiguous_count
  FROM "payments" p
  WHERE p."environment" IS NULL
    AND EXISTS (
    SELECT 1 FROM "organization_payment_accounts" opa
    WHERE opa."provider_account_id" = p."connected_account_id"
      AND opa."organization_id" = p."organization_id"
      AND opa."environment" = 'LIVE'
  ) AND EXISTS (
    SELECT 1 FROM "organization_payment_accounts" opa
    WHERE opa."provider_account_id" = p."connected_account_id"
      AND opa."organization_id" = p."organization_id"
      AND opa."environment" = 'TEST'
  );
  IF ambiguous_count > 0 THEN
    RAISE EXCEPTION 'Backfill ambigu : % paiements ont un compte connecté présent en TEST et LIVE', ambiguous_count
      USING ERRCODE = 'check_violation';
  END IF;

  -- Paiements sans aucune correspondance.
  -- P2-5 : AND p."environment" IS NULL pour l'idempotence défensive.
  SELECT COUNT(*) INTO missing_count
  FROM "payments" p
  WHERE p."environment" IS NULL
    AND NOT EXISTS (
    SELECT 1 FROM "organization_payment_accounts" opa
    WHERE opa."provider_account_id" = p."connected_account_id"
      AND opa."organization_id" = p."organization_id"
  );
  IF missing_count > 0 THEN
    RAISE EXCEPTION 'Backfill incomplet : % paiements n''ont pas de compte connecté correspondant', missing_count
      USING ERRCODE = 'check_violation';
  END IF;
END $$;

-- Backfill déterministe : exactement une correspondance par paiement.
-- P2-5 : WHERE p."environment" IS NULL pour l'idempotence défensive (si la
-- migration est rejouée, ne pas réécrire les lignes déjà backfillées).
UPDATE "payments" p SET "environment" = (
  SELECT opa."environment" FROM "organization_payment_accounts" opa
  WHERE opa."provider_account_id" = p."connected_account_id"
    AND opa."organization_id" = p."organization_id"
  LIMIT 1
)
WHERE p."environment" IS NULL;

-- La colonne doit être explicitement fournie : pas de DEFAULT.
ALTER TABLE "payments" ALTER COLUMN "environment" SET NOT NULL;

-- Contrainte CHECK sur payments.environment.
ALTER TABLE "payments" ADD CONSTRAINT "payments_environment_check"
  CHECK ("environment" IN ('TEST', 'LIVE'));

-- Contrainte CHECK : reconcile_lease_token et reconcile_lease_until doivent
-- être simultanément nuls ou non nuls (P2-3).
ALTER TABLE "payment_attempts" ADD CONSTRAINT "payment_attempts_lease_token_lease_until_consistent"
  CHECK (("reconcile_lease_token" IS NULL AND "reconcile_lease_until" IS NULL)
         OR ("reconcile_lease_token" IS NOT NULL AND "reconcile_lease_until" IS NOT NULL));
