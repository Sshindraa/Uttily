CREATE TYPE "public"."notification_channel" AS ENUM('EMAIL');
--> statement-breakpoint
CREATE TYPE "public"."notification_template" AS ENUM(
  'BOOKING_CONFIRMED_CUSTOMER',
  'BOOKING_CONFIRMED_MERCHANT',
  'BOOKING_CANCELLED_CUSTOMER',
  'BOOKING_CANCELLED_MERCHANT',
  'REFUND_CONFIRMED_CUSTOMER',
  'PICKUP_REMINDER_CUSTOMER',
  'RETURN_REMINDER_CUSTOMER',
  'REFUND_ACTION_REQUIRED_MERCHANT'
);
--> statement-breakpoint
CREATE TYPE "public"."notification_status" AS ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action,
	"booking_id" uuid REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action,
	"refund_id" uuid REFERENCES "public"."refunds"("id") ON DELETE no action ON UPDATE no action,
	"channel" "notification_channel" DEFAULT 'EMAIL' NOT NULL,
	"template" "notification_template" NOT NULL,
	"recipient" text NOT NULL,
	"status" "notification_status" DEFAULT 'PENDING' NOT NULL,
	"provider_message_id" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"scheduled_for" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"failure_code" text,
	"idempotency_key" text NOT NULL UNIQUE,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_recipient_nonempty" CHECK (length(btrim("recipient")) > 0),
	CONSTRAINT "notifications_idempotency_key_nonempty" CHECK (length(btrim("idempotency_key")) > 0)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_due_idx" ON "notifications" ("status", "scheduled_for") WHERE "status" = 'PENDING';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_booking_id_idx" ON "notifications" ("booking_id", "status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_org_idx" ON "notifications" ("organization_id", "created_at");
