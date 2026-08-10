-- Migration 0035 : G7H-A — Fondations analytics first-party privacy-first.
--
-- Crée les fondations du ledger analytics first-party pour les quatre mesures
-- produit (recherches, résultats disponibles, tentatives de réservation,
-- réservations confirmées). Deux enums distincts (analytics_event_type,
-- analytics_environment), une table raw append-only bornée (90 jours) avec
-- déduplication idempotente, une table d'agrégats UTC quotidiens (24 mois),
-- des triggers d'immutabilité (UPDATE toujours interdit, DELETE interdit pour
-- les événements de moins de 90 jours), et un index borné pour la lecture et
-- l'agrégation.
--
-- Aucune collecte active dans les parcours applicatifs à ce stade.
-- Production désactivée jusqu'à validation privacy/juridique.
-- Aucun identifiant utilisateur, IP, email, adresse, GPS brut, fingerprint,
-- cookie, identifiant de paiement, SKU, numéro de série, texte libre ou
-- payload JSON n'est stocké.

-- ========================================================================
-- 1. Enum analytics_event_type
-- ========================================================================

CREATE TYPE analytics_event_type AS ENUM (
  'PUBLIC_SEARCH_PERFORMED',
  'BOOKING_ATTEMPTED',
  'BOOKING_CONFIRMED'
);

-- ========================================================================
-- 2. Enum analytics_environment (distinct de payment_environment)
-- ========================================================================

CREATE TYPE analytics_environment AS ENUM (
  'DEVELOPMENT',
  'TEST',
  'PRODUCTION'
);

-- ========================================================================
-- 3. Table product_analytics_events (ledger raw append-only)
-- ========================================================================

CREATE TABLE product_analytics_events (
  id           uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type   analytics_event_type  NOT NULL,
  environment  analytics_environment NOT NULL,
  source_id    uuid                  NOT NULL,
  has_results  boolean,
  occurred_at  timestamptz           NOT NULL,
  created_at   timestamptz           NOT NULL DEFAULT now(),

  -- Déduplication idempotente : (event_type, environment, source_id) unique.
  CONSTRAINT product_analytics_events_dedup_unique
    UNIQUE (event_type, environment, source_id),

  -- PUBLIC_SEARCH_PERFORMED requiert has_results NOT NULL ;
  -- BOOKING_ATTEMPTED et BOOKING_CONFIRMED requièrent has_results NULL.
  CONSTRAINT product_analytics_events_has_results_invariants CHECK (
    CASE
      WHEN event_type = 'PUBLIC_SEARCH_PERFORMED' THEN has_results IS NOT NULL
      WHEN event_type IN ('BOOKING_ATTEMPTED', 'BOOKING_CONFIRMED') THEN has_results IS NULL
      ELSE FALSE
    END
  )
);

-- Index borné pour la lecture et l'agrégation par (environment, occurred_at, event_type).
CREATE INDEX product_analytics_events_env_occurred_type_idx
  ON product_analytics_events (environment, occurred_at, event_type);

-- ========================================================================
-- 4. Trigger guard_product_analytics_event_immutability (BEFORE UPDATE)
--    UPDATE toujours interdit — le ledger est append-only.
-- ========================================================================

CREATE OR REPLACE FUNCTION guard_product_analytics_event_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- Le ledger raw est append-only : toute modification est interdite.
  RAISE EXCEPTION 'product_analytics_events : UPDATE interdit (ledger append-only).';
END;
$$;

CREATE TRIGGER guard_product_analytics_event_immutability
  BEFORE UPDATE ON product_analytics_events
  FOR EACH ROW
  EXECUTE FUNCTION guard_product_analytics_event_immutability();

-- ========================================================================
-- 5. Trigger guard_product_analytics_event_deletion (BEFORE DELETE)
--    DELETE interdit pour les événements de moins de 90 jours.
--    La borne exacte (occurred_at = now() - 90 days) est conservée.
-- ========================================================================

CREATE OR REPLACE FUNCTION guard_product_analytics_event_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  -- DELETE autorisé uniquement pour les événements strictement plus anciens que 90 jours.
  -- La borne exacte (occurred_at = now() - 90 days) est conservée (non supprimable).
  IF OLD.occurred_at >= (now() - interval '90 days') THEN
    RAISE EXCEPTION 'product_analytics_events : DELETE interdit pour les événements de moins de 90 jours (occurred_at >= now() - 90 days).';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER guard_product_analytics_event_deletion
  BEFORE DELETE ON product_analytics_events
  FOR EACH ROW
  EXECUTE FUNCTION guard_product_analytics_event_deletion();

-- ========================================================================
-- 5b. Trigger guard_product_analytics_event_deletion_requires_aggregate
--     (BEFORE DELETE) — DELETE interdit si aucun agrégat n'existe pour le
--     jour UTC et l'environnement de l'événement.
-- ========================================================================

CREATE OR REPLACE FUNCTION guard_product_analytics_event_deletion_requires_aggregate()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  event_day date;
BEGIN
  -- Calculer le jour UTC de l'événement.
  event_day := (OLD.occurred_at AT TIME ZONE 'UTC')::date;

  -- Vérifier qu'un agrégat existe pour ce jour et cet environnement.
  IF NOT EXISTS (
    SELECT 1 FROM product_analytics_daily
    WHERE day = event_day AND environment = OLD.environment
  ) THEN
    RAISE EXCEPTION 'product_analytics_events : DELETE interdit car aucun agrégat n''existe pour le jour % et l''environnement %.', event_day, OLD.environment;
  END IF;

  RETURN OLD;
END;
$$;

CREATE TRIGGER guard_product_analytics_event_deletion_requires_aggregate
  BEFORE DELETE ON product_analytics_events
  FOR EACH ROW
  EXECUTE FUNCTION guard_product_analytics_event_deletion_requires_aggregate();

-- ========================================================================
-- 6. Table product_analytics_daily (agrégats UTC quotidiens)
-- ========================================================================

CREATE TABLE product_analytics_daily (
  day                              date                 NOT NULL,
  environment                      analytics_environment NOT NULL,
  searches                         bigint               NOT NULL,
  searches_with_results            bigint               NOT NULL,
  booking_attempts                 bigint               NOT NULL,
  bookings_confirmed               bigint               NOT NULL,
  compacted_searches               bigint               NOT NULL DEFAULT 0,
  compacted_searches_with_results  bigint               NOT NULL DEFAULT 0,
  compacted_booking_attempts       bigint               NOT NULL DEFAULT 0,
  compacted_bookings_confirmed     bigint               NOT NULL DEFAULT 0,
  updated_at                       timestamptz          NOT NULL DEFAULT now(),

  CONSTRAINT product_analytics_daily_pkey PRIMARY KEY (day, environment),

  -- Tous les compteurs >= 0.
  CONSTRAINT product_analytics_daily_searches_non_negative CHECK (searches >= 0),
  CONSTRAINT product_analytics_daily_searches_with_results_non_negative CHECK (searches_with_results >= 0),
  CONSTRAINT product_analytics_daily_booking_attempts_non_negative CHECK (booking_attempts >= 0),
  CONSTRAINT product_analytics_daily_bookings_confirmed_non_negative CHECK (bookings_confirmed >= 0),

  -- searches_with_results <= searches (même jour, même environnement).
  CONSTRAINT product_analytics_daily_searches_with_results_le_searches
    CHECK (searches_with_results <= searches),

  -- Compteurs compactés >= 0.
  CONSTRAINT product_analytics_daily_compacted_s_nn CHECK (compacted_searches >= 0),
  CONSTRAINT product_analytics_daily_compacted_swr_nn CHECK (compacted_searches_with_results >= 0),
  CONSTRAINT product_analytics_daily_compacted_ba_nn CHECK (compacted_booking_attempts >= 0),
  CONSTRAINT product_analytics_daily_compacted_bc_nn CHECK (compacted_bookings_confirmed >= 0),

  -- Chaque compteur compacté <= son compteur total correspondant.
  CONSTRAINT product_analytics_daily_compacted_s_le_s CHECK (compacted_searches <= searches),
  CONSTRAINT product_analytics_daily_compacted_swr_le_swr CHECK (compacted_searches_with_results <= searches_with_results),
  CONSTRAINT product_analytics_daily_compacted_ba_le_ba CHECK (compacted_booking_attempts <= booking_attempts),
  CONSTRAINT product_analytics_daily_compacted_bc_le_bc CHECK (compacted_bookings_confirmed <= bookings_confirmed),

  -- compacted_searches_with_results <= compacted_searches.
  CONSTRAINT product_analytics_daily_compacted_swr_le_cs CHECK (compacted_searches_with_results <= compacted_searches)
);

-- ========================================================================
-- Rollback (DROP dans l'ordre inverse)
-- ========================================================================
-- DROP TABLE IF EXISTS product_analytics_daily;
-- DROP TRIGGER IF EXISTS guard_product_analytics_event_deletion_requires_aggregate ON product_analytics_events;
-- DROP FUNCTION IF EXISTS guard_product_analytics_event_deletion_requires_aggregate();
-- DROP TRIGGER IF EXISTS guard_product_analytics_event_deletion ON product_analytics_events;
-- DROP FUNCTION IF EXISTS guard_product_analytics_event_deletion();
-- DROP TRIGGER IF EXISTS guard_product_analytics_event_immutability ON product_analytics_events;
-- DROP FUNCTION IF EXISTS guard_product_analytics_event_immutability();
-- DROP INDEX IF EXISTS product_analytics_events_env_occurred_type_idx;
-- DROP TABLE IF EXISTS product_analytics_events;
-- DROP TYPE IF EXISTS analytics_environment;
-- DROP TYPE IF EXISTS analytics_event_type;
