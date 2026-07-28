-- Migration 0011 : table products (catalogue par organisation).
-- publication_status : DRAFT (défaut), PUBLISHED, ARCHIVED.
-- ARCHIVED est un état métier réversible ; deleted_at est une suppression
-- logique technique. Les deux sont distincts.

DO $$ BEGIN
  CREATE TYPE "product_publication_status" AS ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE "products" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "category_id" uuid NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text NOT NULL DEFAULT '',
  "publication_status" "product_publication_status" NOT NULL DEFAULT 'DRAFT',
  "deleted_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Slug unique par organisation (où non supprimé logiquement).
CREATE UNIQUE INDEX "products_organization_slug_active_unique"
  ON "products" ("organization_id", "slug")
  WHERE "deleted_at" IS NULL;

ALTER TABLE "products"
  ADD CONSTRAINT "products_slug_format"
  CHECK ("slug" ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$');

ALTER TABLE "products"
  ADD CONSTRAINT "products_organization_id_organizations_id_fk"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;

ALTER TABLE "products"
  ADD CONSTRAINT "products_category_id_categories_id_fk"
  FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE restrict;

CREATE INDEX "products_organization_id_index" ON "products" ("organization_id");
CREATE INDEX "products_category_id_index" ON "products" ("category_id");
