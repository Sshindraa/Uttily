-- Migration 0042 : création de la table connected_account_payouts (Chantier 11 - Projection des versements Stripe/prestataire).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'connected_account_payout_status') THEN
    CREATE TYPE "connected_account_payout_status" AS ENUM ('PENDING', 'IN_TRANSIT', 'PAID', 'FAILED', 'CANCELLED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS "connected_account_payouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "provider" "payment_provider" NOT NULL DEFAULT 'STRIPE',
  "environment" "payment_environment" NOT NULL,
  "provider_payout_id" text NOT NULL,
  "provider_account_id" text NOT NULL,
  "amount_minor" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "status" "connected_account_payout_status" NOT NULL,
  "arrival_date" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "failed_at" timestamp with time zone,
  "failure_code" text,
  "failure_message" text,
  "provider_created_at" bigint,
  "last_provider_event_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  "deleted_at" timestamp with time zone
);

CREATE UNIQUE INDEX IF NOT EXISTS "connected_account_payouts_provider_payout_unique" ON "connected_account_payouts" ("provider", "environment", "provider_payout_id");
CREATE INDEX IF NOT EXISTS "connected_account_payouts_org_status_index" ON "connected_account_payouts" ("organization_id", "status");
CREATE INDEX IF NOT EXISTS "connected_account_payouts_org_arrival_index" ON "connected_account_payouts" ("organization_id", "arrival_date");
