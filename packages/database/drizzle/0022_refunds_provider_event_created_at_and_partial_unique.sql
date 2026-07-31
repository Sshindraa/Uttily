-- Migration 0022 : Garde monotone des refunds + contrainte unique partielle
--
-- A. Ajout de la colonne `provider_event_created_at` (bigint, nullable) à `refunds`
--    pour supporter la garde monotone : un événement Stripe ancien ne peut pas
--    faire régresser le statut d'un refund déjà projeté par un événement plus
--    récent (ADR-010 amendement Phase 6 §C).
--
-- B. Remplacement de la contrainte unique `(payment_id, reason)` par un index
--    unique partiel limité à `LATE_PAYMENT_NO_BOOKING` (ADR-010 amendement
--    Phase 6 §B). La contrainte précédente (`refunds_payment_reason_unique`)
--    interdisait plus d'un refund `EXTERNAL_REFUND` par paiement, ce qui est
--    incompatible avec les refunds Stripe partiels multiples.

ALTER TABLE "refunds" ADD COLUMN "provider_event_created_at" bigint;

ALTER TABLE "refunds" DROP CONSTRAINT "refunds_payment_reason_unique";

CREATE UNIQUE INDEX "refunds_late_payment_unique"
  ON "refunds" ("payment_id", "reason")
  WHERE "refunds"."reason" = 'LATE_PAYMENT_NO_BOOKING';
