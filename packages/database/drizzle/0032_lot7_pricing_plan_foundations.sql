-- Migration 0032 : G7P-A Round 2 — fondations PostgreSQL des plans tarifaires
-- flexibles avec versioning, héritage et immutabilité.
--
-- Implémente le modèle approuvé par ADR-018 (Option b : table dédiée
-- pricing_plans par variante) et les décisions produit du 2026-08-07 :
--
-- Clé métier (business key) — exclut la version :
--   (product_variant_id, scope default/local, currency, plan_type,
--    included_duration_minutes pour FIXED_DURATION)
-- Version = numéro de révision de la clé métier (entier > 0).
--
-- Cycle de vie (lifecycle_state) : DRAFT → ACTIVE → RETIRED (cycle fermé).
-- - DRAFT : plan modifiable librement (prix, durées, fenêtres, paliers,
--   traductions). Peut être supprimé (hard delete, cascade).
-- - ACTIVE : plan immuable (seuls lifecycle_state et updated_at peuvent
--   changer). Fenêtres, paliers et traductions gelés. Ne peut être supprimé.
-- - RETIRED : plan immuable, ne peut plus être activé ni supprimé.
--
-- Transitions autorisées : DRAFT→DRAFT, DRAFT→ACTIVE, ACTIVE→RETIRED.
-- Toutes les autres transitions sont interdites.
--
-- Immutabilité après activation : si lifecycle_state IN ('ACTIVE', 'RETIRED'),
-- toute modification des champs métier (organization_id, product_variant_id,
-- location_id, plan_type, currency, price_amount_minor, durées,
-- internal_label, priority, version) est rejetée.
--
-- Résolution default/local indépendante du numéro de version :
-- - location_id NULL = plan par défaut (s'applique à tous les magasins de même
--   devise).
-- - location_id non NULL = remplacement explicite pour ce magasin (doit utiliser
--   la devise opérationnelle du magasin).
-- - Un plan local remplace intégralement le plan par défaut portant la même clé
--   fonctionnelle (variant, type, durée si applicable, devise).
-- - La fonction resolve_effective_pricing_plans(location_id) retourne
--   les plans locaux actifs + les plans par défaut actifs non remplacés.
--   Elle dérive organization_id et currency depuis la location (fail-closed :
--   location inexistante ou supprimée → zéro ligne). Aucun paramètre tenant ou
--   devise fourni par l'appelant.
--
-- Traductions FR+EN requises pour l'activation :
-- - pricing_plan_translations stocke les libellés publics par locale.
-- - Un plan ne peut passer à ACTIVE que s'il possède au moins les traductions
--   'fr' et 'en'.
-- - Les traductions sont gelées (INSERT/UPDATE/DELETE interdits) quand le plan
--   est ACTIVE ou RETIRED.
--
-- Fenêtres et paliers gelés dans la version :
-- - pricing_plan_windows et multi_day_discount_tiers ne peuvent être
--   modifiés (INSERT/UPDATE/DELETE) que lorsque le plan est DRAFT.
--
-- weekday_mask : masque de bits pour les jours de la semaine.
--   bit 0 = Monday (valeur 1), bit 1 = Tuesday (2), ..., bit 6 = Sunday (64).
--   0 = aucun jour = invalide. 127 = tous les jours. Range valide : 1–127.
--
-- G7P-A Round 2 = schéma uniquement. G7P-B non démarré.
-- G7P-A ne modifie PAS les snapshots financiers existants ni
-- product_variants.daily_price_amount_minor (compatibilité Core existant).

-- 1. Enums
CREATE TYPE "pricing_plan_type" AS ENUM ('HOURLY', 'FIXED_DURATION', 'DAILY');
CREATE TYPE "pricing_lifecycle_state" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- 2. locations.operating_currency (devise opérationnelle par magasin)
ALTER TABLE "locations" ADD COLUMN "operating_currency" text;
UPDATE "locations" SET "operating_currency" = (
  SELECT o.default_currency FROM "organizations" o WHERE o.id = "locations".organization_id
)
WHERE "operating_currency" IS NULL;
ALTER TABLE "locations" ALTER COLUMN "operating_currency" SET NOT NULL;
ALTER TABLE "locations"
  ADD CONSTRAINT "locations_operating_currency_iso"
  CHECK ("operating_currency" ~ '^[A-Z]{3}$');

-- 2b. Assouplir la contrainte currency sur product_variants pour permettre
-- d'autres devises ISO (support multi-devises G7P-A).
ALTER TABLE "product_variants" DROP CONSTRAINT IF EXISTS "product_variants_currency_eur";
ALTER TABLE "product_variants"
  ADD CONSTRAINT "product_variants_currency_iso"
  CHECK ("currency" ~ '^[A-Z]{3}$');

-- 3. Table pricing_plans
CREATE TABLE "pricing_plans" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "product_variant_id" uuid NOT NULL,
  "location_id" uuid,
  "plan_type" "pricing_plan_type" NOT NULL,
  "currency" text NOT NULL,
  "price_amount_minor" bigint NOT NULL,
  "min_duration_minutes" integer,
  "max_duration_minutes" integer,
  "billing_increment_minutes" integer,
  "included_duration_minutes" integer,
  "internal_label" text,
  "priority" integer NOT NULL DEFAULT 0,
  "lifecycle_state" "pricing_lifecycle_state" NOT NULL DEFAULT 'DRAFT',
  "version" integer NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pricing_plans_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id"),
  CONSTRAINT "pricing_plans_product_variant_id_fk"
    FOREIGN KEY ("product_variant_id") REFERENCES "product_variants"("id"),
  CONSTRAINT "pricing_plans_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id"),
  CONSTRAINT "pricing_plans_price_positive"
    CHECK ("price_amount_minor" > 0),
  CONSTRAINT "pricing_plans_price_max_safe"
    CHECK ("price_amount_minor" <= 9007199254740991),
  CONSTRAINT "pricing_plans_currency_iso"
    CHECK ("currency" ~ '^[A-Z]{3}$'),
  CONSTRAINT "pricing_plans_version_positive"
    CHECK ("version" > 0),
  -- Union discriminée stricte : HOURLY
  CONSTRAINT "pricing_plans_hourly_fields"
    CHECK (
      ("plan_type" = 'HOURLY' AND
       "min_duration_minutes" IS NOT NULL AND
       "min_duration_minutes" > 0 AND
       "max_duration_minutes" IS NOT NULL AND
       "max_duration_minutes" >= "min_duration_minutes" AND
       "billing_increment_minutes" IS NOT NULL AND
       "billing_increment_minutes" > 0 AND
       "included_duration_minutes" IS NULL)
      OR
      ("plan_type" <> 'HOURLY' AND
       "min_duration_minutes" IS NULL AND
       "max_duration_minutes" IS NULL AND
       "billing_increment_minutes" IS NULL)
    ),
  -- Union discriminée stricte : FIXED_DURATION
  CONSTRAINT "pricing_plans_fixed_duration_fields"
    CHECK (
      ("plan_type" = 'FIXED_DURATION' AND
       "included_duration_minutes" IS NOT NULL AND
       "included_duration_minutes" > 0 AND
       "min_duration_minutes" IS NULL AND
       "max_duration_minutes" IS NULL AND
       "billing_increment_minutes" IS NULL)
      OR
      ("plan_type" <> 'FIXED_DURATION' AND "included_duration_minutes" IS NULL)
    ),
  -- Union discriminée stricte : DAILY
  CONSTRAINT "pricing_plans_daily_fields"
    CHECK (
      ("plan_type" = 'DAILY' AND
       "min_duration_minutes" IS NULL AND
       "max_duration_minutes" IS NULL AND
       "billing_increment_minutes" IS NULL AND
       "included_duration_minutes" IS NULL)
      OR
      ("plan_type" <> 'DAILY')
    )
);

-- 4. Index uniques — clé métier (exclut la version)
-- Au plus un plan ACTIVE par clé métier.
CREATE UNIQUE INDEX "pricing_plans_active_business_key_unique"
  ON "pricing_plans" (
    "product_variant_id",
    COALESCE("location_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "plan_type",
    "currency",
    COALESCE("included_duration_minutes", -1)
  )
  WHERE "lifecycle_state" = 'ACTIVE';

-- Unicité historique de (clé métier, version).
CREATE UNIQUE INDEX "pricing_plans_business_key_version_unique"
  ON "pricing_plans" (
    "product_variant_id",
    COALESCE("location_id", '00000000-0000-0000-0000-000000000000'::uuid),
    "plan_type",
    "currency",
    COALESCE("included_duration_minutes", -1),
    "version"
  );

-- 5. Index de performance
CREATE INDEX "pricing_plans_variant_active_index"
  ON "pricing_plans" ("product_variant_id")
  WHERE "lifecycle_state" = 'ACTIVE';

CREATE INDEX "pricing_plans_location_index"
  ON "pricing_plans" ("location_id")
  WHERE "location_id" IS NOT NULL;

-- 6. Table pricing_plan_windows
CREATE TABLE "pricing_plan_windows" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pricing_plan_id" uuid NOT NULL,
  "location_id" uuid NOT NULL,
  "weekday_mask" integer NOT NULL,
  "start_time" time NOT NULL,
  "end_time" time NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pricing_plan_windows_pricing_plan_id_fk"
    FOREIGN KEY ("pricing_plan_id") REFERENCES "pricing_plans"("id") ON DELETE CASCADE,
  CONSTRAINT "pricing_plan_windows_location_id_fk"
    FOREIGN KEY ("location_id") REFERENCES "locations"("id"),
  -- Décision conservatrice : PAS de wraparound minuit (end_time > start_time).
  CONSTRAINT "pricing_plan_windows_time_order"
    CHECK ("end_time" > "start_time"),
  -- weekday_mask : bits 0-6 = Monday-Sunday. 0 = invalide, 127 = tous les jours.
  CONSTRAINT "pricing_plan_windows_weekday_mask_range"
    CHECK ("weekday_mask" >= 1 AND "weekday_mask" <= 127)
);

CREATE INDEX "pricing_plan_windows_plan_index"
  ON "pricing_plan_windows" ("pricing_plan_id");

-- 7. Table multi_day_discount_tiers
CREATE TABLE "multi_day_discount_tiers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pricing_plan_id" uuid NOT NULL,
  "threshold_days" integer NOT NULL,
  "discount_percent" integer NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "multi_day_discount_tiers_pricing_plan_id_fk"
    FOREIGN KEY ("pricing_plan_id") REFERENCES "pricing_plans"("id") ON DELETE CASCADE,
  CONSTRAINT "multi_day_discount_tiers_threshold_min"
    CHECK ("threshold_days" >= 2),
  CONSTRAINT "multi_day_discount_tiers_discount_range"
    CHECK ("discount_percent" > 0 AND "discount_percent" < 100)
);

-- 8. Index partiels uniques — paliers de réduction
-- Un seul palier actif par (pricing_plan_id, threshold_days).
CREATE UNIQUE INDEX "multi_day_discount_tiers_plan_threshold_unique"
  ON "multi_day_discount_tiers" ("pricing_plan_id", "threshold_days")
  WHERE "active" = true;

CREATE INDEX "multi_day_discount_tiers_plan_active_index"
  ON "multi_day_discount_tiers" ("pricing_plan_id")
  WHERE "active" = true;

-- 9. Table pricing_plan_translations (libellés publics par locale)
CREATE TABLE "pricing_plan_translations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "pricing_plan_id" uuid NOT NULL,
  "locale" text NOT NULL,
  "public_label" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "pricing_plan_translations_pricing_plan_id_fk"
    FOREIGN KEY ("pricing_plan_id") REFERENCES "pricing_plans"("id") ON DELETE CASCADE,
  CONSTRAINT "pricing_plan_translations_plan_locale_unique"
    UNIQUE ("pricing_plan_id", "locale"),
  CONSTRAINT "pricing_plan_translations_locale_format"
    CHECK ("locale" ~ '^[a-z]{2}(-[A-Z]{2})?$'),
  CONSTRAINT "pricing_plan_translations_label_not_empty"
    CHECK (length(btrim("public_label")) > 0)
);

CREATE INDEX "pricing_plan_translations_plan_locale_index"
  ON "pricing_plan_translations" ("pricing_plan_id", "locale");

-- ========================================================================
-- Fonctions et triggers
-- ========================================================================

-- 10. Fonction : cohérence multi-tenant des plans tarifaires
-- Vérifie que plan.organization_id = organisation de la variante (via products).
-- Si location_id non NULL : location.organization_id = plan.organization_id ET
-- plan.currency = location.operating_currency.
CREATE OR REPLACE FUNCTION "check_pricing_plan_tenant_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  variant_org_id uuid;
  loc_org_id uuid;
  loc_currency text;
BEGIN
  SELECT p.organization_id INTO variant_org_id
  FROM "product_variants" pv
  JOIN "products" p ON pv.product_id = p.id
  WHERE pv.id = NEW.product_variant_id;

  IF variant_org_id IS NULL THEN
    RAISE EXCEPTION 'pricing_plans: product_variant_id % does not resolve to an organization', NEW.product_variant_id;
  END IF;

  IF variant_org_id <> NEW.organization_id THEN
    RAISE EXCEPTION 'pricing_plans: organization_id mismatch — plan has % but variant belongs to %', NEW.organization_id, variant_org_id;
  END IF;

  IF NEW.location_id IS NOT NULL THEN
    SELECT l.organization_id, l.operating_currency INTO loc_org_id, loc_currency
    FROM "locations" l
    WHERE l.id = NEW.location_id;

    IF loc_org_id IS NULL THEN
      RAISE EXCEPTION 'pricing_plans: location_id % does not exist', NEW.location_id;
    END IF;

    IF loc_org_id <> NEW.organization_id THEN
      RAISE EXCEPTION 'pricing_plans: location organization_id mismatch — plan has % but location belongs to %', NEW.organization_id, loc_org_id;
    END IF;

    IF loc_currency IS NULL OR loc_currency <> NEW.currency THEN
      RAISE EXCEPTION 'pricing_plans: local plan currency must match location operating_currency (plan: %, location: %)', NEW.currency, loc_currency;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- 11. Trigger : cohérence multi-tenant des plans tarifaires
CREATE TRIGGER "before_check_pricing_plan_tenant_consistency"
  BEFORE INSERT OR UPDATE OF "organization_id", "product_variant_id", "location_id", "currency" ON "pricing_plans"
  FOR EACH ROW
  EXECUTE FUNCTION "check_pricing_plan_tenant_consistency"();

-- 12. Fonction : transitions de cycle de vie autorisées
-- DRAFT → DRAFT : OK
-- DRAFT → ACTIVE : OK
-- ACTIVE → RETIRED : OK
-- Toutes les autres transitions : interdites.
CREATE OR REPLACE FUNCTION "enforce_pricing_plan_lifecycle_transitions"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."lifecycle_state" = NEW."lifecycle_state" THEN
    RETURN NEW;
  END IF;

  IF OLD."lifecycle_state" = 'DRAFT' AND NEW."lifecycle_state" = 'ACTIVE' THEN
    RETURN NEW;
  END IF;

  IF OLD."lifecycle_state" = 'ACTIVE' AND NEW."lifecycle_state" = 'RETIRED' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'pricing_plans: invalid lifecycle transition from % to %', OLD."lifecycle_state", NEW."lifecycle_state";
END;
$$;

-- 13. Trigger : transitions de cycle de vie
CREATE TRIGGER "before_enforce_pricing_plan_lifecycle_transitions"
  BEFORE UPDATE OF "lifecycle_state" ON "pricing_plans"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_pricing_plan_lifecycle_transitions"();

-- 14. Fonction : immutabilité des champs après activation
-- Si lifecycle_state IN ('ACTIVE', 'RETIRED'), seuls lifecycle_state et
-- updated_at peuvent changer.
CREATE OR REPLACE FUNCTION "enforce_pricing_plan_immutable_fields"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."lifecycle_state" IN ('ACTIVE', 'RETIRED') THEN
    IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id"
       OR NEW."product_variant_id" IS DISTINCT FROM OLD."product_variant_id"
       OR NEW."location_id" IS DISTINCT FROM OLD."location_id"
       OR NEW."plan_type" IS DISTINCT FROM OLD."plan_type"
       OR NEW."currency" IS DISTINCT FROM OLD."currency"
       OR NEW."price_amount_minor" IS DISTINCT FROM OLD."price_amount_minor"
       OR NEW."min_duration_minutes" IS DISTINCT FROM OLD."min_duration_minutes"
       OR NEW."max_duration_minutes" IS DISTINCT FROM OLD."max_duration_minutes"
       OR NEW."billing_increment_minutes" IS DISTINCT FROM OLD."billing_increment_minutes"
       OR NEW."included_duration_minutes" IS DISTINCT FROM OLD."included_duration_minutes"
       OR NEW."internal_label" IS DISTINCT FROM OLD."internal_label"
       OR NEW."priority" IS DISTINCT FROM OLD."priority"
       OR NEW."version" IS DISTINCT FROM OLD."version"
    THEN
      RAISE EXCEPTION 'pricing_plans: immutable fields cannot change when lifecycle_state is %', OLD."lifecycle_state";
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 15. Trigger : immutabilité des champs après activation
CREATE TRIGGER "before_enforce_pricing_plan_immutable_fields"
  BEFORE UPDATE ON "pricing_plans"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_pricing_plan_immutable_fields"();

-- 16. Fonction : suppression interdite si non-DRAFT
CREATE OR REPLACE FUNCTION "prevent_pricing_plan_delete_if_not_draft"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."lifecycle_state" IN ('ACTIVE', 'RETIRED') THEN
    RAISE EXCEPTION 'pricing_plans: cannot delete plan with lifecycle_state % (only DRAFT can be deleted)', OLD."lifecycle_state";
  END IF;
  RETURN OLD;
END;
$$;

-- 17. Trigger : suppression interdite si non-DRAFT
CREATE TRIGGER "before_prevent_pricing_plan_delete_if_not_draft"
  BEFORE DELETE ON "pricing_plans"
  FOR EACH ROW
  EXECUTE FUNCTION "prevent_pricing_plan_delete_if_not_draft"();

-- 18. Fonction : revalidation complète à l'activation (DRAFT → ACTIVE)
-- Vérifie au moment de l'activation :
-- - Cohérence organisation variante = organisation plan
-- - Pour les plans locaux : cohérence organisation/currency de la location,
--   location non supprimée
-- - Traductions FR+EN présentes
-- - Toutes les fenêtres : cohérence tenant, location, currency, mask/hours valides
-- - Tous les paliers : plan DAILY uniquement, threshold >= 2, discount 1-99,
--   pas de doublons, monotonie des réductions
-- Le verrou de ligne est détenu par l'UPDATE qui déclenche ce trigger
-- (BEFORE UPDATE FOR EACH ROW), donc pas besoin de SELECT FOR UPDATE explicite.
CREATE OR REPLACE FUNCTION "revalidate_pricing_plan_on_activation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  variant_org_id uuid;
  loc_org_id uuid;
  loc_currency text;
  loc_deleted_at timestamp with time zone;
  has_fr boolean;
  has_en boolean;
  bad_window_count integer;
  tier_count integer;
  prev_threshold integer;
  prev_discount integer;
  cur_threshold integer;
  cur_discount integer;
  dup_threshold integer;
  tier_rec RECORD;
BEGIN
  -- Ne s'applique qu'à la transition DRAFT → ACTIVE.
  IF NOT (OLD."lifecycle_state" = 'DRAFT' AND NEW."lifecycle_state" = 'ACTIVE') THEN
    RETURN NEW;
  END IF;

  -- 1. Revalider la cohérence organisation variante.
  SELECT p.organization_id INTO variant_org_id
  FROM "product_variants" pv
  JOIN "products" p ON pv.product_id = p.id
  WHERE pv.id = NEW."product_variant_id";

  IF variant_org_id IS NULL THEN
    RAISE EXCEPTION 'pricing_plans: cannot activate — product_variant_id % does not resolve to an organization', NEW."product_variant_id";
  END IF;

  IF variant_org_id <> NEW."organization_id" THEN
    RAISE EXCEPTION 'pricing_plans: cannot activate — organization_id mismatch (plan: %, variant org: %)', NEW."organization_id", variant_org_id;
  END IF;

  -- 2. Pour les plans locaux, revalider la cohérence location.
  IF NEW."location_id" IS NOT NULL THEN
    SELECT l.organization_id, l.operating_currency, l.deleted_at
      INTO loc_org_id, loc_currency, loc_deleted_at
    FROM "locations" l
    WHERE l.id = NEW."location_id";

    IF loc_org_id IS NULL THEN
      RAISE EXCEPTION 'pricing_plans: cannot activate — location_id % does not exist', NEW."location_id";
    END IF;

    IF loc_deleted_at IS NOT NULL THEN
      RAISE EXCEPTION 'pricing_plans: cannot activate — location_id % is soft-deleted', NEW."location_id";
    END IF;

    IF loc_org_id <> NEW."organization_id" THEN
      RAISE EXCEPTION 'pricing_plans: cannot activate — location organization_id mismatch (plan: %, location: %)', NEW."organization_id", loc_org_id;
    END IF;

    IF loc_currency IS NULL OR loc_currency <> NEW."currency" THEN
      RAISE EXCEPTION 'pricing_plans: cannot activate — local plan currency must match location operating_currency (plan: %, location: %)', NEW."currency", loc_currency;
    END IF;
  END IF;

  -- 3. Traductions FR+EN requises.
  SELECT EXISTS(
    SELECT 1 FROM "pricing_plan_translations" t
    WHERE t."pricing_plan_id" = NEW."id" AND t."locale" = 'fr'
  ) INTO has_fr;
  IF has_fr = false THEN
    RAISE EXCEPTION 'pricing_plans: cannot activate plan without FR translation';
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM "pricing_plan_translations" t
    WHERE t."pricing_plan_id" = NEW."id" AND t."locale" = 'en'
  ) INTO has_en;
  IF has_en = false THEN
    RAISE EXCEPTION 'pricing_plans: cannot activate plan without EN translation';
  END IF;

  -- 4. Revalider toutes les fenêtres du plan.
  SELECT count(*) INTO bad_window_count
  FROM "pricing_plan_windows" w
  JOIN "locations" l ON w."location_id" = l.id
  WHERE w."pricing_plan_id" = NEW."id"
    AND (
      l.organization_id <> NEW."organization_id"
      OR l.operating_currency <> NEW."currency"
      OR (NEW."location_id" IS NOT NULL AND w."location_id" <> NEW."location_id")
      OR w."weekday_mask" < 1 OR w."weekday_mask" > 127
      OR w."end_time" <= w."start_time"
    );

  IF bad_window_count > 0 THEN
    RAISE EXCEPTION 'pricing_plans: cannot activate — % window(s) fail revalidation (tenant/currency/location/mask/hours)', bad_window_count;
  END IF;

  -- 5. Revalider tous les paliers du plan.
  -- 5a. Le plan doit être DAILY si des paliers existent.
  SELECT count(*) INTO tier_count
  FROM "multi_day_discount_tiers"
  WHERE "pricing_plan_id" = NEW."id" AND "active" = true;

  IF tier_count > 0 AND NEW."plan_type" <> 'DAILY' THEN
    RAISE EXCEPTION 'pricing_plans: cannot activate — discount tiers exist but plan type is % (only DAILY allowed)', NEW."plan_type";
  END IF;

  -- 5b. Chaque palier : threshold >= 2, discount 1-99.
  SELECT count(*) INTO bad_window_count
  FROM "multi_day_discount_tiers"
  WHERE "pricing_plan_id" = NEW."id"
    AND "active" = true
    AND ("threshold_days" < 2 OR "discount_percent" < 1 OR "discount_percent" > 99);

  IF bad_window_count > 0 THEN
    RAISE EXCEPTION 'pricing_plans: cannot activate — % tier(s) have invalid threshold (< 2) or discount (outside 1-99)', bad_window_count;
  END IF;

  -- 5c. Pas de doublons de seuils actifs.
  SELECT count(*) INTO dup_threshold
  FROM (
    SELECT "threshold_days", count(*) AS cnt
    FROM "multi_day_discount_tiers"
    WHERE "pricing_plan_id" = NEW."id" AND "active" = true
    GROUP BY "threshold_days"
    HAVING count(*) > 1
  ) dup;

  IF dup_threshold > 0 THEN
    RAISE EXCEPTION 'pricing_plans: cannot activate — duplicate active tier thresholds detected';
  END IF;

  -- 5d. Monotonie : ordonné par threshold_days, discount_percent non-décroissant.
  prev_threshold := NULL;
  prev_discount := NULL;
  FOR tier_rec IN
    SELECT "threshold_days", "discount_percent"
    FROM "multi_day_discount_tiers"
    WHERE "pricing_plan_id" = NEW."id" AND "active" = true
    ORDER BY "threshold_days" ASC
  LOOP
    IF prev_threshold IS NOT NULL AND tier_rec."discount_percent" < prev_discount THEN
      RAISE EXCEPTION 'pricing_plans: cannot activate — tier monotonicity violated (threshold % @ %, then threshold % @ %)', prev_threshold, prev_discount, tier_rec."threshold_days", tier_rec."discount_percent";
    END IF;
    prev_threshold := tier_rec."threshold_days";
    prev_discount := tier_rec."discount_percent";
  END LOOP;

  RETURN NEW;
END;
$$;

-- 19. Trigger : revalidation complète à l'activation
CREATE TRIGGER "before_revalidate_pricing_plan_on_activation"
  BEFORE UPDATE OF "lifecycle_state" ON "pricing_plans"
  FOR EACH ROW
  EXECUTE FUNCTION "revalidate_pricing_plan_on_activation"();

-- 20. Fonction : cohérence multi-tenant des fenêtres tarifaires
-- Vérifie que window.location_id appartient à la même organisation que le plan.
-- Si le plan a un location_id (plan local), window.location_id doit = plan.location_id.
-- Vérifie aussi que window.location.operating_currency = plan.currency.
CREATE OR REPLACE FUNCTION "check_pricing_plan_window_tenant_consistency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  plan_org_id uuid;
  plan_location_id uuid;
  plan_currency text;
  loc_org_id uuid;
  loc_currency text;
BEGIN
  SELECT pp."organization_id", pp."location_id", pp."currency"
  INTO plan_org_id, plan_location_id, plan_currency
  FROM "pricing_plans" pp
  WHERE pp."id" = NEW."pricing_plan_id";

  IF plan_org_id IS NULL THEN
    RAISE EXCEPTION 'pricing_plan_windows: pricing_plan_id % does not exist', NEW."pricing_plan_id";
  END IF;

  SELECT l."organization_id", l."operating_currency" INTO loc_org_id, loc_currency
  FROM "locations" l
  WHERE l."id" = NEW."location_id";

  IF loc_org_id IS NULL THEN
    RAISE EXCEPTION 'pricing_plan_windows: location_id % does not exist', NEW."location_id";
  END IF;

  IF loc_org_id <> plan_org_id THEN
    RAISE EXCEPTION 'pricing_plan_windows: location organization_id mismatch — plan org % but location org %', plan_org_id, loc_org_id;
  END IF;

  IF plan_location_id IS NOT NULL AND plan_location_id <> NEW."location_id" THEN
    RAISE EXCEPTION 'pricing_plan_windows: local plan requires window.location_id to match plan.location_id (plan: %, window: %)', plan_location_id, NEW."location_id";
  END IF;

  -- Cohérence devise : la devise du magasin de la fenêtre doit = devise du plan.
  IF loc_currency IS NULL OR loc_currency <> plan_currency THEN
    RAISE EXCEPTION 'pricing_plan_windows: location operating_currency must match plan currency (plan: %, location: %)', plan_currency, loc_currency;
  END IF;

  RETURN NEW;
END;
$$;

-- 21. Trigger : cohérence multi-tenant des fenêtres tarifaires
CREATE TRIGGER "before_check_pricing_plan_window_tenant_consistency"
  BEFORE INSERT OR UPDATE OF "pricing_plan_id", "location_id" ON "pricing_plan_windows"
  FOR EACH ROW
  EXECUTE FUNCTION "check_pricing_plan_window_tenant_consistency"();

-- 22. Fonction : fenêtres gelées si plan non-DRAFT
CREATE OR REPLACE FUNCTION "enforce_window_draft_only_mutations"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  plan_state "pricing_lifecycle_state";
BEGIN
  -- CASCADE DELETE : le plan parent est déjà supprimé, et seuls les plans DRAFT
  -- peuvent être supprimés (prevent_pricing_plan_delete_if_not_draft). Les
  -- enregistrements enfants peuvent donc être supprimés sans vérification.
  -- Sur un DELETE direct (plan encore présent), on vérifie le cycle de vie.
  IF TG_OP = 'DELETE' THEN
    SELECT pp."lifecycle_state" INTO plan_state
    FROM "pricing_plans" pp
    WHERE pp."id" = OLD."pricing_plan_id"
    FOR UPDATE;
    -- plan_state IS NULL → le plan parent n'existe plus (CASCADE DELETE).
    IF plan_state IS NULL THEN
      RETURN OLD;
    END IF;
    IF plan_state IN ('ACTIVE', 'RETIRED') THEN
      RAISE EXCEPTION 'pricing_plan_windows: cannot DELETE window when plan lifecycle_state is %', plan_state;
    END IF;
    RETURN OLD;
  END IF;

  -- Verrouiller le plan parent pour sérialiser avec l'activation concurrente.
  SELECT pp."lifecycle_state" INTO plan_state
  FROM "pricing_plans" pp
  WHERE pp."id" = NEW."pricing_plan_id"
  FOR UPDATE;

  IF plan_state IS NULL THEN
    RAISE EXCEPTION 'pricing_plan_windows: pricing_plan_id does not exist';
  END IF;

  IF plan_state IN ('ACTIVE', 'RETIRED') THEN
    RAISE EXCEPTION 'pricing_plan_windows: cannot % window when plan lifecycle_state is %', TG_OP, plan_state;
  END IF;

  RETURN NEW;
END;
$$;

-- 23. Trigger : fenêtres gelées si plan non-DRAFT
CREATE TRIGGER "before_enforce_window_draft_only_mutations"
  BEFORE INSERT OR UPDATE OR DELETE ON "pricing_plan_windows"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_window_draft_only_mutations"();

-- 24. Fonction : les paliers de réduction ne s'attachent qu'à un plan DAILY
CREATE OR REPLACE FUNCTION "check_multi_day_tier_plan_type"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  plan_type_val "pricing_plan_type";
BEGIN
  SELECT pp."plan_type" INTO plan_type_val
  FROM "pricing_plans" pp
  WHERE pp."id" = NEW."pricing_plan_id"
  FOR UPDATE;

  IF plan_type_val IS NULL THEN
    RAISE EXCEPTION 'multi_day_discount_tiers: pricing_plan_id % does not exist', NEW."pricing_plan_id";
  END IF;

  IF plan_type_val <> 'DAILY' THEN
    RAISE EXCEPTION 'multi_day_discount_tiers: pricing_plan_id % is of type %, only DAILY plans support discount tiers', NEW."pricing_plan_id", plan_type_val;
  END IF;

  RETURN NEW;
END;
$$;

-- 25. Trigger : les paliers de réduction ne s'attachent qu'à un plan DAILY
CREATE TRIGGER "before_check_multi_day_tier_plan_type"
  BEFORE INSERT OR UPDATE OF "pricing_plan_id" ON "multi_day_discount_tiers"
  FOR EACH ROW
  EXECUTE FUNCTION "check_multi_day_tier_plan_type"();

-- 26. Fonction : paliers gelés si plan non-DRAFT
CREATE OR REPLACE FUNCTION "enforce_tier_draft_only_mutations"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  plan_state "pricing_lifecycle_state";
BEGIN
  -- CASCADE DELETE : le plan parent est déjà supprimé, et seuls les plans DRAFT
  -- peuvent être supprimés (prevent_pricing_plan_delete_if_not_draft). Les
  -- enregistrements enfants peuvent donc être supprimés sans vérification.
  -- Sur un DELETE direct (plan encore présent), on vérifie le cycle de vie.
  IF TG_OP = 'DELETE' THEN
    SELECT pp."lifecycle_state" INTO plan_state
    FROM "pricing_plans" pp
    WHERE pp."id" = OLD."pricing_plan_id"
    FOR UPDATE;
    -- plan_state IS NULL → le plan parent n'existe plus (CASCADE DELETE).
    IF plan_state IS NULL THEN
      RETURN OLD;
    END IF;
    IF plan_state IN ('ACTIVE', 'RETIRED') THEN
      RAISE EXCEPTION 'multi_day_discount_tiers: cannot DELETE tier when plan lifecycle_state is %', plan_state;
    END IF;
    RETURN OLD;
  END IF;

  -- Verrouiller le plan parent pour sérialiser avec l'activation concurrente.
  SELECT pp."lifecycle_state" INTO plan_state
  FROM "pricing_plans" pp
  WHERE pp."id" = NEW."pricing_plan_id"
  FOR UPDATE;

  IF plan_state IS NULL THEN
    RAISE EXCEPTION 'multi_day_discount_tiers: pricing_plan_id does not exist';
  END IF;

  IF plan_state IN ('ACTIVE', 'RETIRED') THEN
    RAISE EXCEPTION 'multi_day_discount_tiers: cannot % tier when plan lifecycle_state is %', TG_OP, plan_state;
  END IF;

  RETURN NEW;
END;
$$;

-- 27. Trigger : paliers gelés si plan non-DRAFT
CREATE TRIGGER "before_enforce_tier_draft_only_mutations"
  BEFORE INSERT OR UPDATE OR DELETE ON "multi_day_discount_tiers"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_tier_draft_only_mutations"();

-- 28. Fonction : monotonie des paliers de réduction
-- Quand le seuil augmente, la réduction ne doit pas diminuer.
-- Verrouille le plan parent (SELECT FOR UPDATE) pour sérialiser les
-- insertions/modifications concurrentes de paliers sur le même plan.
CREATE OR REPLACE FUNCTION "enforce_tier_monotonic_discount"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  existing_threshold integer;
  existing_discount integer;
BEGIN
  -- Verrouiller le plan parent pour sérialiser les mutations concurrentes.
  PERFORM 1 FROM "pricing_plans" pp WHERE pp."id" = NEW."pricing_plan_id" FOR UPDATE;

  FOR existing_threshold, existing_discount IN
    SELECT "threshold_days", "discount_percent"
    FROM "multi_day_discount_tiers"
    WHERE "pricing_plan_id" = NEW."pricing_plan_id"
      AND "active" = true
      AND "id" <> NEW."id"
  LOOP
    IF existing_threshold < NEW."threshold_days" AND existing_discount > NEW."discount_percent" THEN
      RAISE EXCEPTION 'multi_day_discount_tiers: discount must not decrease when threshold increases (existing threshold % @ %, new threshold % @ %)', existing_threshold, existing_discount, NEW."threshold_days", NEW."discount_percent";
    END IF;
    IF existing_threshold > NEW."threshold_days" AND existing_discount < NEW."discount_percent" THEN
      RAISE EXCEPTION 'multi_day_discount_tiers: discount must not be higher for a lower threshold (existing threshold % @ %, new threshold % @ %)', existing_threshold, existing_discount, NEW."threshold_days", NEW."discount_percent";
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

-- 29. Trigger : monotonie des paliers de réduction
CREATE TRIGGER "before_enforce_tier_monotonic_discount"
  BEFORE INSERT OR UPDATE OF "threshold_days", "discount_percent" ON "multi_day_discount_tiers"
  FOR EACH ROW
  EXECUTE FUNCTION "enforce_tier_monotonic_discount"();

-- 30. Fonction : traductions gelées si plan non-DRAFT
CREATE OR REPLACE FUNCTION "freeze_pricing_plan_translations"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  plan_state "pricing_lifecycle_state";
BEGIN
  -- CASCADE DELETE : le plan parent est déjà supprimé, et seuls les plans DRAFT
  -- peuvent être supprimés (prevent_pricing_plan_delete_if_not_draft). Les
  -- enregistrements enfants peuvent donc être supprimés sans vérification.
  -- Sur un DELETE direct (plan encore présent), on vérifie le cycle de vie.
  IF TG_OP = 'DELETE' THEN
    SELECT pp."lifecycle_state" INTO plan_state
    FROM "pricing_plans" pp
    WHERE pp."id" = OLD."pricing_plan_id"
    FOR UPDATE;
    -- plan_state IS NULL → le plan parent n'existe plus (CASCADE DELETE).
    IF plan_state IS NULL THEN
      RETURN OLD;
    END IF;
    IF plan_state IN ('ACTIVE', 'RETIRED') THEN
      RAISE EXCEPTION 'pricing_plan_translations: cannot DELETE translation when plan lifecycle_state is %', plan_state;
    END IF;
    RETURN OLD;
  END IF;

  -- Verrouiller le plan parent pour sérialiser avec l'activation concurrente.
  SELECT pp."lifecycle_state" INTO plan_state
  FROM "pricing_plans" pp
  WHERE pp."id" = NEW."pricing_plan_id"
  FOR UPDATE;

  IF plan_state IS NULL THEN
    RAISE EXCEPTION 'pricing_plan_translations: pricing_plan_id does not exist';
  END IF;

  IF plan_state IN ('ACTIVE', 'RETIRED') THEN
    RAISE EXCEPTION 'pricing_plan_translations: cannot % translation when plan lifecycle_state is %', TG_OP, plan_state;
  END IF;

  RETURN NEW;
END;
$$;

-- 31. Trigger : traductions gelées si plan non-DRAFT
CREATE TRIGGER "before_freeze_pricing_plan_translations"
  BEFORE INSERT OR UPDATE OR DELETE ON "pricing_plan_translations"
  FOR EACH ROW
  EXECUTE FUNCTION "freeze_pricing_plan_translations"();

-- 32. Fonction : protection de la devise opérationnelle des magasins
-- Empêche le changement de operating_currency si des plans ou fenêtres DRAFT ou
-- ACTIVE deviendraient incohérents. Les plans RETIRED (historiques, immuables,
-- plus effectifs) ne bloquent PAS le changement de devise.
CREATE OR REPLACE FUNCTION "protect_location_operating_currency"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  conflicting_plans integer;
  conflicting_windows integer;
BEGIN
  IF OLD."operating_currency" IS DISTINCT FROM NEW."operating_currency" THEN
    -- Vérifier qu'aucun plan DRAFT ou ACTIVE local n'a une devise différente.
    -- Les plans RETIRED ne bloquent pas (historiques, immuables).
    SELECT count(*) INTO conflicting_plans
    FROM "pricing_plans" pp
    WHERE pp."location_id" = NEW."id"
      AND pp."lifecycle_state" IN ('DRAFT', 'ACTIVE')
      AND pp."currency" <> NEW."operating_currency";

    IF conflicting_plans > 0 THEN
      RAISE EXCEPTION 'locations: cannot change operating_currency from % to % — % DRAFT/ACTIVE local plan(s) would become inconsistent', OLD."operating_currency", NEW."operating_currency", conflicting_plans;
    END IF;

    -- Vérifier qu'aucune fenêtre sur un plan DRAFT ou ACTIVE n'a une devise
    -- différente (via le plan parent). Les fenêtres sur plans RETIRED ne
    -- bloquent pas.
    SELECT count(*) INTO conflicting_windows
    FROM "pricing_plan_windows" w
    JOIN "pricing_plans" pp ON w."pricing_plan_id" = pp."id"
    WHERE w."location_id" = NEW."id"
      AND pp."lifecycle_state" IN ('DRAFT', 'ACTIVE')
      AND pp."currency" <> NEW."operating_currency";

    IF conflicting_windows > 0 THEN
      RAISE EXCEPTION 'locations: cannot change operating_currency from % to % — % DRAFT/ACTIVE window(s) would become inconsistent', OLD."operating_currency", NEW."operating_currency", conflicting_windows;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- 33. Trigger : protection de la devise opérationnelle des magasins
CREATE TRIGGER "before_protect_location_operating_currency"
  BEFORE UPDATE OF "operating_currency" ON "locations"
  FOR EACH ROW
  EXECUTE FUNCTION "protect_location_operating_currency"();

-- ========================================================================
-- Fonction de résolution
-- ========================================================================

-- 34. Fonction : résolution des plans tarifaires effectifs
-- Retourne les plans locaux ACTIVES + les plans par défaut ACTIVES non
-- remplacés par un plan local, pour un magasin donné. L'organization_id et la
-- currency sont dérivés de la location (fail-closed : location inexistante ou
-- supprimée logiquement → zéro ligne). Aucun paramètre tenant ou devise fourni
-- par l'appelant — la location est l'autorité pour la devise.
CREATE OR REPLACE FUNCTION "resolve_effective_pricing_plans"(
  p_location_id uuid
) RETURNS TABLE (
  id uuid,
  organization_id uuid,
  product_variant_id uuid,
  location_id uuid,
  plan_type pricing_plan_type,
  currency text,
  price_amount_minor bigint,
  min_duration_minutes integer,
  max_duration_minutes integer,
  billing_increment_minutes integer,
  included_duration_minutes integer,
  internal_label text,
  priority integer,
  lifecycle_state pricing_lifecycle_state,
  version integer,
  created_at timestamp with time zone,
  updated_at timestamp with time zone
) LANGUAGE sql STABLE SECURITY INVOKER AS $$
  WITH loc AS (
    SELECT "organization_id", "operating_currency", "deleted_at"
    FROM "locations"
    WHERE "id" = p_location_id
  ),
  local_plans AS (
    SELECT pp.* FROM "pricing_plans" pp, loc
    WHERE loc."deleted_at" IS NULL
      AND pp."location_id" = p_location_id
      AND pp."lifecycle_state" = 'ACTIVE'
      AND pp."currency" = loc."operating_currency"
  ),
  effective_defaults AS (
    SELECT d.* FROM "pricing_plans" d, loc
    WHERE loc."deleted_at" IS NULL
      AND d."location_id" IS NULL
      AND d."lifecycle_state" = 'ACTIVE'
      AND d."currency" = loc."operating_currency"
      AND d."organization_id" = loc."organization_id"
      AND NOT EXISTS (
        SELECT 1 FROM local_plans l
        WHERE l."product_variant_id" = d."product_variant_id"
          AND l."plan_type" = d."plan_type"
          AND l."currency" = d."currency"
          AND COALESCE(l."included_duration_minutes", -1) = COALESCE(d."included_duration_minutes", -1)
      )
  )
  SELECT
    lp."id", lp."organization_id", lp."product_variant_id", lp."location_id",
    lp."plan_type", lp."currency", lp."price_amount_minor",
    lp."min_duration_minutes", lp."max_duration_minutes",
    lp."billing_increment_minutes", lp."included_duration_minutes",
    lp."internal_label", lp."priority", lp."lifecycle_state", lp."version",
    lp."created_at", lp."updated_at"
  FROM local_plans lp
  UNION ALL
  SELECT
    ed."id", ed."organization_id", ed."product_variant_id", ed."location_id",
    ed."plan_type", ed."currency", ed."price_amount_minor",
    ed."min_duration_minutes", ed."max_duration_minutes",
    ed."billing_increment_minutes", ed."included_duration_minutes",
    ed."internal_label", ed."priority", ed."lifecycle_state", ed."version",
    ed."created_at", ed."updated_at"
  FROM effective_defaults ed;
$$;

-- ========================================================================
-- Backfill
-- ========================================================================

-- 35. Backfill DAILY des variantes existantes avec traductions FR+EN
-- Crée un plan DAILY par défaut (location_id NULL) ACTIVE v1 pour chaque
-- variante ayant un daily_price_amount_minor positif et non supprimée
-- logiquement, avec les traductions FR et EN.
-- Ne supprime PAS product_variants.daily_price_amount_minor (compatibilité Core).
-- Étape 1 : insérer les plans en DRAFT (le trigger d'activation exige les
-- traductions FR+EN avant de passer à ACTIVE).
WITH backfilled_plans AS (
  INSERT INTO "pricing_plans" (
    "organization_id", "product_variant_id", "location_id", "plan_type",
    "currency", "price_amount_minor", "priority", "lifecycle_state", "version"
  )
  SELECT
    p.organization_id, pv.id, NULL, 'DAILY'::pricing_plan_type,
    pv.currency, pv.daily_price_amount_minor, 0, 'DRAFT'::pricing_lifecycle_state, 1
  FROM "product_variants" pv
  JOIN "products" p ON pv.product_id = p.id
  WHERE pv.daily_price_amount_minor IS NOT NULL
    AND pv.daily_price_amount_minor > 0
    AND pv.deleted_at IS NULL
    AND NOT EXISTS (
      SELECT 1 FROM "pricing_plans" existing
      WHERE existing.product_variant_id = pv.id
        AND existing.plan_type = 'DAILY'
        AND existing.location_id IS NULL
        AND existing.version = 1
    )
  RETURNING "id"
)
INSERT INTO "pricing_plan_translations" ("pricing_plan_id", "locale", "public_label")
SELECT "id", 'fr', 'Tarif journalier' FROM backfilled_plans
UNION ALL
SELECT "id", 'en', 'Daily rate' FROM backfilled_plans;
-- Étape 2 : activer les plans backfillés (les traductions existent maintenant).
-- L'UPDATE ne cible que les plans DRAFT qui possèdent déjà les traductions FR et
-- EN, ce qui garantit l'idempotence : les plans déjà ACTIVE ne sont pas touchés.
UPDATE "pricing_plans" SET "lifecycle_state" = 'ACTIVE'
WHERE "plan_type" = 'DAILY'
  AND "location_id" IS NULL
  AND "lifecycle_state" = 'DRAFT'
  AND "version" = 1
  AND EXISTS (
    SELECT 1 FROM "pricing_plan_translations" t
    WHERE t.pricing_plan_id = "pricing_plans".id
      AND t.locale = 'fr'
  )
  AND EXISTS (
    SELECT 1 FROM "pricing_plan_translations" t
    WHERE t.pricing_plan_id = "pricing_plans".id
      AND t.locale = 'en'
  );
