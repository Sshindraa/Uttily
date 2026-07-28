-- Migration 0003 : table organizations.
-- Loueurs professionnels uniquement (ADR-002).

DO $$ BEGIN
  CREATE TYPE "organization_status" AS ENUM('ACTIVE', 'SUSPENDED', 'CLOSED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "organizations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "legal_name" text NOT NULL,
  "slug" text NOT NULL,
  "status" "organization_status" NOT NULL DEFAULT 'ACTIVE',
  "is_professional" boolean NOT NULL DEFAULT true,
  "default_currency" text NOT NULL DEFAULT 'EUR',
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "organizations_slug_unique" UNIQUE ("slug"),
  CONSTRAINT "organizations_slug_format" CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  CONSTRAINT "organizations_currency_iso" CHECK (length("default_currency") = 3)
);

CREATE INDEX "organizations_slug_index" ON "organizations" ("slug");
