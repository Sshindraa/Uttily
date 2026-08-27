-- Migration 0043 : Création des tables et enums d'annulation de réservation confirmée (Chantier 12)

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'cancellation_actor_reason') THEN
    CREATE TYPE "cancellation_actor_reason" AS ENUM (
      'CUSTOMER_CANCELLATION',
      'MERCHANT_CANCELLATION',
      'PLATFORM_CANCELLATION',
      'PAYMENT_COMPENSATION'
    );
  END IF;
END $$;

ALTER TYPE "refund_reason" ADD VALUE IF NOT EXISTS 'CUSTOMER_CANCELLATION';
ALTER TYPE "refund_reason" ADD VALUE IF NOT EXISTS 'MERCHANT_CANCELLATION';
ALTER TYPE "refund_reason" ADD VALUE IF NOT EXISTS 'PLATFORM_CANCELLATION';

CREATE TABLE IF NOT EXISTS "booking_cancellations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "booking_id" uuid NOT NULL UNIQUE REFERENCES "bookings"("id"),
  "cancelled_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "actor_reason" "cancellation_actor_reason" NOT NULL,
  "policy_code" text NOT NULL,
  "policy_snapshot" jsonb NOT NULL,
  "gross_paid_minor" bigint NOT NULL,
  "refund_amount_minor" bigint NOT NULL,
  "retained_amount_minor" bigint NOT NULL,
  "original_commission_minor" bigint NOT NULL,
  "commission_refunded_minor" bigint NOT NULL,
  "final_commission_minor" bigint NOT NULL,
  "final_merchant_revenue_minor" bigint NOT NULL,
  "currency" text NOT NULL DEFAULT 'EUR',
  "explanation_code" text NOT NULL,
  "inventory_released" boolean NOT NULL DEFAULT true,
  "refund_id" uuid REFERENCES "refunds"("id"),
  "occurred_at" timestamp with time zone NOT NULL DEFAULT now(),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "booking_cancellations_currency_eur" CHECK ("currency" = 'EUR'),
  CONSTRAINT "booking_cancellations_gross_paid_non_negative" CHECK ("gross_paid_minor" >= 0),
  CONSTRAINT "booking_cancellations_refund_non_negative" CHECK ("refund_amount_minor" >= 0),
  CONSTRAINT "booking_cancellations_retained_non_negative" CHECK ("retained_amount_minor" >= 0)
);

CREATE INDEX IF NOT EXISTS "booking_cancellations_org_idx" ON "booking_cancellations"("organization_id");
CREATE INDEX IF NOT EXISTS "booking_cancellations_booking_idx" ON "booking_cancellations"("booking_id");
CREATE INDEX IF NOT EXISTS "booking_cancellations_occurred_at_idx" ON "booking_cancellations"("occurred_at");
