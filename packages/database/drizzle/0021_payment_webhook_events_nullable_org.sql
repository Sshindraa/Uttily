-- Migration 0021 : Rendre organization_id nullable sur payment_webhook_events
-- + ajouter la raison EXTERNAL_REFUND à l'enum refund_reason
--
-- Les événements non rattachables (aucune tentative, aucun compte connecté)
-- doivent pouvoir être persistés avec organization_id = NULL pour marquer
-- l'anomalie plateforme. L'UUID nil précédemment utilisé violait la FK vers
-- organizations (23503). La colonne devient nullable ; les handlers insèrent
-- NULL au lieu d'un UUID nil fictif.
--
-- La raison EXTERNAL_REFUND est ajoutée pour les refunds externes projetés
-- depuis les webhooks Stripe (charge.refunded / refund.created / refund.updated)
-- qui ne sont pas des compensations tardives (LATE_PAYMENT_NO_BOOKING).

ALTER TABLE "payment_webhook_events" ALTER COLUMN "organization_id" DROP NOT NULL;

ALTER TYPE "refund_reason" ADD VALUE IF NOT EXISTS 'EXTERNAL_REFUND';
