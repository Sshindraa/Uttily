-- Token de lease UUID pour fencing atomique des événements outbox (Phase 8).
-- Permet au worker de compensation de revendiquer des événements avec
-- FOR UPDATE SKIP LOCKED et un fencing token, comme la réconciliation.
ALTER TABLE "outbox_events" ADD COLUMN "lease_token" uuid;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
-- Index pour le claim : status + lease_until.
-- Optimise la requête SELECT ... WHERE status IN ('PENDING', 'PROCESSING')
-- AND available_at <= now() AND (lease_until IS NULL OR lease_until <= now())
-- FOR UPDATE SKIP LOCKED. Inclut PROCESSING pour la récupération des stale leases.
CREATE INDEX IF NOT EXISTS "outbox_events_lease_until_index" ON "outbox_events" USING btree ("lease_until") WHERE "outbox_events"."status" IN ('PENDING', 'PROCESSING');--> statement-breakpoint
-- Contrainte CHECK : lease_token et lease_until simultanément nuls ou non nuls.
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_lease_token_lease_until_consistent" CHECK (("outbox_events"."lease_token" IS NULL AND "outbox_events"."lease_until" IS NULL) OR ("outbox_events"."lease_token" IS NOT NULL AND "outbox_events"."lease_until" IS NOT NULL));
