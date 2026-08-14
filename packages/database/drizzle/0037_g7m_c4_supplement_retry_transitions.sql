-- Migration 0037 : G7M-C4-S — transitions d'expiration et de retry contrôlé.
--
-- ADR-023 : prérequis PostgreSQL pour le cycle de vie C4-A. Cette migration
-- ne crée aucune table, colonne ou enum : elle resserre/complète uniquement
-- les transitions déjà représentées par le schéma G7M-A.
-- Aucun worker, cron, webhook, route ou orchestration métier n'est introduit.

-- ===========================================================================
-- Étape 1 — READY_TO_APPLY → EXPIRED
-- ===========================================================================
CREATE OR REPLACE FUNCTION before_check_booking_amendment_transition()
RETURNS TRIGGER AS $$
BEGIN
  -- Colonnes immuables après création.
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.booking_id <> OLD.booking_id
     OR NEW.amendment_number <> OLD.amendment_number
     OR NEW.type <> OLD.type
     OR NEW.financial_snapshot_before IS DISTINCT FROM OLD.financial_snapshot_before
     OR NEW.financial_snapshot_after IS DISTINCT FROM OLD.financial_snapshot_after
     OR NEW.new_customer_start_at <> OLD.new_customer_start_at
     OR NEW.new_customer_end_at <> OLD.new_customer_end_at
     OR NEW.new_blocked_start_at <> OLD.new_blocked_start_at
     OR NEW.new_blocked_end_at <> OLD.new_blocked_end_at
     OR NEW.hold_deadline IS DISTINCT FROM OLD.hold_deadline
     OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'booking_amendments: colonnes immuables modifiées';
  END IF;

  -- États terminaux : immuables (seul updated_at peut changer).
  IF OLD.status IN ('APPLIED', 'EXPIRED', 'CANCELLED', 'FAILED') THEN
    IF NEW.status <> OLD.status
       OR NEW.applied_at IS DISTINCT FROM OLD.applied_at
       OR NEW.expired_at IS DISTINCT FROM OLD.expired_at
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
       OR NEW.updated_at <> OLD.updated_at THEN
      RAISE EXCEPTION 'booking_amendments: état terminal immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- Transitions autorisées depuis HOLD_PENDING.
  IF OLD.status = 'HOLD_PENDING' THEN
    IF NEW.status NOT IN ('HOLD_PENDING', 'READY_TO_APPLY', 'EXPIRED', 'CANCELLED') THEN
      RAISE EXCEPTION 'booking_amendments: transition invalide depuis HOLD_PENDING vers %', NEW.status;
    END IF;
    IF NEW.status = 'EXPIRED' THEN
      IF NEW.applied_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers EXPIRED ne doit pas renseigner d''autres timestamps terminaux';
      END IF;
      IF NEW.expired_at IS NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers EXPIRED requiert expired_at';
      END IF;
    ELSIF NEW.status = 'CANCELLED' THEN
      IF NEW.applied_at IS NOT NULL OR NEW.expired_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers CANCELLED ne doit pas renseigner d''autres timestamps terminaux';
      END IF;
      IF NEW.cancelled_at IS NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers CANCELLED requiert cancelled_at';
      END IF;
    ELSE
      IF NEW.applied_at IS NOT NULL OR NEW.expired_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: aucun timestamp terminal ne peut être renseigné dans un état non-terminal';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- C4-S ajoute l'expiration depuis READY_TO_APPLY.
  IF OLD.status = 'READY_TO_APPLY' THEN
    IF NEW.status NOT IN ('READY_TO_APPLY', 'APPLIED', 'EXPIRED', 'FAILED') THEN
      RAISE EXCEPTION 'booking_amendments: transition invalide depuis READY_TO_APPLY vers %', NEW.status;
    END IF;
    IF NEW.status = 'APPLIED' THEN
      IF NEW.expired_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers APPLIED ne doit pas renseigner d''autres timestamps terminaux';
      END IF;
      IF NEW.applied_at IS NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers APPLIED requiert applied_at';
      END IF;
    ELSIF NEW.status = 'EXPIRED' THEN
      IF NEW.applied_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers EXPIRED ne doit pas renseigner d''autres timestamps terminaux';
      END IF;
      IF NEW.expired_at IS NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers EXPIRED requiert expired_at';
      END IF;
    ELSIF NEW.status = 'FAILED' THEN
      IF NEW.applied_at IS NOT NULL OR NEW.expired_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers FAILED ne doit pas renseigner d''autres timestamps terminaux';
      END IF;
      IF NEW.failed_at IS NULL THEN
        RAISE EXCEPTION 'booking_amendments: transition vers FAILED requiert failed_at';
      END IF;
    ELSE
      IF NEW.applied_at IS NOT NULL OR NEW.expired_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
        RAISE EXCEPTION 'booking_amendments: aucun timestamp terminal ne peut être renseigné dans un état non-terminal';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'booking_amendments: état source inattendu %', OLD.status;
END;
$$ LANGUAGE plpgsql;

-- ===========================================================================
-- Étape 2 — retry FAILED → PENDING_PROVIDER avec attempt N+1 explicite
-- ===========================================================================
CREATE OR REPLACE FUNCTION before_check_amendment_payment_transition()
RETURNS TRIGGER AS $$
DECLARE
  non_terminal_attempt_count integer;
  pending_provider_attempt_count integer;
  pending_provider_attempt_number integer;
  max_attempt_number integer;
BEGIN
  -- Colonnes immuables après création.
  IF NEW.id <> OLD.id
     OR NEW.organization_id <> OLD.organization_id
     OR NEW.booking_id <> OLD.booking_id
     OR NEW.amendment_id <> OLD.amendment_id
     OR NEW.customer_user_id <> OLD.customer_user_id
     OR NEW.amount_minor <> OLD.amount_minor
     OR NEW.currency <> OLD.currency
     OR NEW.environment <> OLD.environment
     OR NEW.connected_account_id <> OLD.connected_account_id
     OR NEW.on_behalf_of_account_id IS DISTINCT FROM OLD.on_behalf_of_account_id
     OR NEW.charge_model <> OLD.charge_model
     OR NEW.settlement_merchant_mode <> OLD.settlement_merchant_mode
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'amendment_payments: colonnes immuables modifiées';
  END IF;

  -- Un retry ne réarme le paiement que si l'appelant a d'abord créé, dans la
  -- même transaction et sous les verrous métier attendus, un nouvel attempt.
  IF OLD.status = 'FAILED' AND NEW.status = 'PENDING_PROVIDER' THEN
    IF NEW.succeeded_at IS NOT NULL
       OR NEW.failed_at IS NOT NULL
       OR NEW.cancelled_at IS NOT NULL
       OR NEW.processing_started_at IS NOT NULL
       OR NEW.processing_deadline_at IS NOT NULL THEN
      RAISE EXCEPTION 'amendment_payments: un retry PENDING_PROVIDER ne peut conserver aucun timestamp terminal ou processing';
    END IF;

    SELECT
      count(*) FILTER (
        WHERE status IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING')
      )::integer,
      count(*) FILTER (
        WHERE status = 'PENDING_PROVIDER'
          AND provider_payment_intent_id IS NULL
          AND provider_status IS NULL
      )::integer,
      max(attempt_number) FILTER (
        WHERE status = 'PENDING_PROVIDER'
          AND provider_payment_intent_id IS NULL
          AND provider_status IS NULL
      ),
      max(attempt_number)
    INTO
      non_terminal_attempt_count,
      pending_provider_attempt_count,
      pending_provider_attempt_number,
      max_attempt_number
    FROM amendment_payment_attempts
    WHERE amendment_payment_id = NEW.id;

    IF non_terminal_attempt_count <> 1
       OR pending_provider_attempt_count <> 1
       OR pending_provider_attempt_number IS NULL
       OR max_attempt_number IS NULL
       OR pending_provider_attempt_number <> max_attempt_number
       OR pending_provider_attempt_number <= 1 THEN
      RAISE EXCEPTION 'amendment_payments: retry FAILED→PENDING_PROVIDER nécessite un unique nouvel attempt PENDING_PROVIDER N+1 sans provider';
    END IF;

    RETURN NEW;
  END IF;

  -- États terminaux : immuables, sauf le retry FAILED contrôlé ci-dessus.
  IF OLD.status IN ('SUCCEEDED', 'FAILED', 'CANCELLED') THEN
    IF NEW.status <> OLD.status
       OR NEW.succeeded_at IS DISTINCT FROM OLD.succeeded_at
       OR NEW.failed_at IS DISTINCT FROM OLD.failed_at
       OR NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at
       OR NEW.updated_at <> OLD.updated_at THEN
      RAISE EXCEPTION 'amendment_payments: état terminal immuable, aucune modification autorisée';
    END IF;
    RETURN NEW;
  END IF;

  -- Transitions explicites par état source (ADR §5.2).
  IF OLD.status = 'PENDING_PROVIDER' THEN
    IF NEW.status NOT IN ('PENDING_PROVIDER', 'REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED') THEN
      RAISE EXCEPTION 'amendment_payments: transition invalide depuis PENDING_PROVIDER vers %', NEW.status;
    END IF;
  ELSIF OLD.status = 'REQUIRES_PAYMENT_METHOD' THEN
    IF NEW.status NOT IN ('REQUIRES_PAYMENT_METHOD', 'REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED') THEN
      RAISE EXCEPTION 'amendment_payments: transition invalide depuis REQUIRES_PAYMENT_METHOD vers %', NEW.status;
    END IF;
  ELSIF OLD.status = 'REQUIRES_ACTION' THEN
    IF NEW.status NOT IN ('REQUIRES_ACTION', 'PROCESSING', 'SUCCEEDED', 'FAILED') THEN
      RAISE EXCEPTION 'amendment_payments: transition invalide depuis REQUIRES_ACTION vers %', NEW.status;
    END IF;
  ELSIF OLD.status = 'PROCESSING' THEN
    IF NEW.status NOT IN ('PROCESSING', 'SUCCEEDED', 'FAILED', 'CANCELLED') THEN
      RAISE EXCEPTION 'amendment_payments: transition invalide depuis PROCESSING vers %', NEW.status;
    END IF;
  ELSE
    RAISE EXCEPTION 'amendment_payments: état source inattendu %', OLD.status;
  END IF;

  -- Transition vers un état terminal : seul le timestamp correspondant + updated_at peuvent changer.
  IF NEW.status = 'SUCCEEDED' THEN
    IF NEW.failed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers SUCCEEDED ne doit pas renseigner d''autres timestamps terminaux';
    END IF;
    IF NEW.succeeded_at IS NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers SUCCEEDED requiert succeeded_at';
    END IF;
  ELSIF NEW.status = 'FAILED' THEN
    IF NEW.succeeded_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers FAILED ne doit pas renseigner d''autres timestamps terminaux';
    END IF;
    IF NEW.failed_at IS NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers FAILED requiert failed_at';
    END IF;
  ELSIF NEW.status = 'CANCELLED' THEN
    IF NEW.succeeded_at IS NOT NULL OR NEW.failed_at IS NOT NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers CANCELLED ne doit pas renseigner d''autres timestamps terminaux';
    END IF;
    IF NEW.cancelled_at IS NULL THEN
      RAISE EXCEPTION 'amendment_payments: transition vers CANCELLED requiert cancelled_at';
    END IF;
  ELSE
    IF NEW.succeeded_at IS NOT NULL OR NEW.failed_at IS NOT NULL OR NEW.cancelled_at IS NOT NULL THEN
      RAISE EXCEPTION 'amendment_payments: aucun timestamp terminal ne peut être renseigné dans un état non-terminal';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
