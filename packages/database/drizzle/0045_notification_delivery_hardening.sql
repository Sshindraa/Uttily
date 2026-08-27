ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "lease_token" text;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "lease_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "provider_first_attempt_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN IF NOT EXISTS "requires_manual_review" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "notifications_due_idx";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_due_idx" ON "notifications" ("status", "scheduled_for", "next_attempt_at", "lease_until") WHERE "status" IN ('PENDING', 'SENDING');
