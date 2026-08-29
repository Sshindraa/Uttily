-- Migration 0049 : snapshot canonique des frais marketplace split-13-7-v1.
--
-- Migration additive : les lignes existantes restent explicitement legacy
-- (colonnes nullable, aucun backfill économique implicite). Les contraintes
-- ci-dessous protègent seulement les snapshots split effectivement présents.

ALTER TABLE booking_drafts
  ADD COLUMN IF NOT EXISTS customer_total_amount_minor bigint,
  ADD COLUMN IF NOT EXISTS marketplace_fee_snapshot jsonb;

ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS marketplace_fee_snapshot jsonb;

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS customer_total_amount_minor bigint,
  ADD COLUMN IF NOT EXISTS marketplace_fee_snapshot jsonb;

ALTER TABLE amendment_payments
  ADD COLUMN IF NOT EXISTS marketplace_fee_delta_snapshot jsonb;

ALTER TABLE booking_cancellations
  ADD COLUMN IF NOT EXISTS marketplace_fee_snapshot jsonb;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_drafts_customer_total_non_negative') THEN
    ALTER TABLE booking_drafts ADD CONSTRAINT booking_drafts_customer_total_non_negative
      CHECK (customer_total_amount_minor IS NULL OR customer_total_amount_minor >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_customer_total_non_negative') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_customer_total_non_negative
      CHECK (customer_total_amount_minor IS NULL OR customer_total_amount_minor >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'booking_drafts_marketplace_snapshot_shape') THEN
    ALTER TABLE booking_drafts ADD CONSTRAINT booking_drafts_marketplace_snapshot_shape CHECK (
      marketplace_fee_snapshot IS NULL OR (
        customer_total_amount_minor IS NOT NULL
        AND
        jsonb_typeof(marketplace_fee_snapshot) = 'object'
        AND marketplace_fee_snapshot ?& ARRAY[
          'ruleVersion', 'roundingRule', 'marketplaceFeeBaseAmountMinor',
          'merchantRateBps', 'merchantFeeAmountMinor', 'customerRateBps',
          'customerServiceFeeAmountMinor', 'customerTotalAmountMinor',
          'merchantNetAmountMinor', 'platformApplicationFeeAmountMinor'
        ]
        AND marketplace_fee_snapshot->>'ruleVersion' = 'split-13-7-v1'
        AND marketplace_fee_snapshot->>'roundingRule' = 'HALF_UP_PER_COMPONENT'
        AND (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'merchantRateBps') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'merchantFeeAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'customerRateBps') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'merchantNetAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'merchantNetAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'merchantRateBps')::integer = 1300
        AND (marketplace_fee_snapshot->>'customerRateBps')::integer = 700
        AND (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::bigint = total_amount_minor
        AND (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::bigint =
            subtotal_amount_minor + mandatory_fees_amount_minor
        AND (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::bigint =
            floor(((marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::numeric * 1300 + 5000) / 10000)::bigint
        AND (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::bigint =
            floor(((marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::numeric * 700 + 5000) / 10000)::bigint
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::bigint = customer_total_amount_minor
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::bigint +
            (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::bigint
        AND (marketplace_fee_snapshot->>'merchantNetAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::bigint -
            (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::bigint
        AND (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::bigint +
            (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::bigint
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::bigint -
            (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'merchantNetAmountMinor')::bigint
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_marketplace_snapshot_shape') THEN
    ALTER TABLE payments ADD CONSTRAINT payments_marketplace_snapshot_shape CHECK (
      marketplace_fee_snapshot IS NULL OR (
        jsonb_typeof(marketplace_fee_snapshot) = 'object'
        AND marketplace_fee_snapshot ?& ARRAY[
          'ruleVersion', 'roundingRule', 'marketplaceFeeBaseAmountMinor',
          'merchantRateBps', 'merchantFeeAmountMinor', 'customerRateBps',
          'customerServiceFeeAmountMinor', 'customerTotalAmountMinor',
          'merchantNetAmountMinor', 'platformApplicationFeeAmountMinor'
        ]
        AND marketplace_fee_snapshot->>'ruleVersion' = 'split-13-7-v1'
        AND marketplace_fee_snapshot->>'roundingRule' = 'HALF_UP_PER_COMPONENT'
        AND (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'merchantRateBps') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'merchantFeeAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'customerRateBps') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'merchantNetAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'merchantNetAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'merchantRateBps')::integer = 1300
        AND (marketplace_fee_snapshot->>'customerRateBps')::integer = 700
        AND (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::bigint =
            floor(((marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::numeric * 1300 + 5000) / 10000)::bigint
        AND (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::bigint =
            floor(((marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::numeric * 700 + 5000) / 10000)::bigint
        AND (marketplace_fee_snapshot->>'merchantNetAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::bigint -
            (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::bigint
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::bigint +
            (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::bigint
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::bigint = amount_minor
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::bigint -
            (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'merchantNetAmountMinor')::bigint
        AND (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::bigint +
            (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::bigint
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bookings_marketplace_snapshot_shape') THEN
    ALTER TABLE bookings ADD CONSTRAINT bookings_marketplace_snapshot_shape CHECK (
      marketplace_fee_snapshot IS NULL OR (
        customer_total_amount_minor IS NOT NULL
        AND
        jsonb_typeof(marketplace_fee_snapshot) = 'object'
        AND marketplace_fee_snapshot ?& ARRAY[
          'ruleVersion', 'roundingRule', 'marketplaceFeeBaseAmountMinor',
          'merchantRateBps', 'merchantFeeAmountMinor', 'customerRateBps',
          'customerServiceFeeAmountMinor', 'customerTotalAmountMinor',
          'merchantNetAmountMinor', 'platformApplicationFeeAmountMinor'
        ]
        AND marketplace_fee_snapshot->>'ruleVersion' = 'split-13-7-v1'
        AND marketplace_fee_snapshot->>'roundingRule' = 'HALF_UP_PER_COMPONENT'
        AND (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'merchantRateBps') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'merchantFeeAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'customerRateBps') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'merchantNetAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor') ~ '^[0-9]+$'
        AND (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'merchantNetAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor')::numeric <= 9007199254740991
        AND (marketplace_fee_snapshot->>'merchantRateBps')::integer = 1300
        AND (marketplace_fee_snapshot->>'customerRateBps')::integer = 700
        AND (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::bigint = total_amount_minor
        AND (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::bigint =
            subtotal_amount_minor + mandatory_fees_amount_minor
        AND (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::bigint =
            floor(((marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::numeric * 1300 + 5000) / 10000)::bigint
        AND (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::bigint =
            floor(((marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::numeric * 700 + 5000) / 10000)::bigint
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::bigint = customer_total_amount_minor
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::bigint +
            (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::bigint
        AND (marketplace_fee_snapshot->>'merchantNetAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'marketplaceFeeBaseAmountMinor')::bigint -
            (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::bigint
        AND (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'merchantFeeAmountMinor')::bigint +
            (marketplace_fee_snapshot->>'customerServiceFeeAmountMinor')::bigint
        AND (marketplace_fee_snapshot->>'customerTotalAmountMinor')::bigint -
            (marketplace_fee_snapshot->>'platformApplicationFeeAmountMinor')::bigint =
            (marketplace_fee_snapshot->>'merchantNetAmountMinor')::bigint
      )
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'amendment_payments_marketplace_delta_shape') THEN
    ALTER TABLE amendment_payments ADD CONSTRAINT amendment_payments_marketplace_delta_shape CHECK (
      marketplace_fee_delta_snapshot IS NULL OR (
        jsonb_typeof(marketplace_fee_delta_snapshot) = 'object'
        AND marketplace_fee_delta_snapshot->>'kind' = 'FINAL_STATE_DELTA_PER_COMPONENT'
        AND marketplace_fee_delta_snapshot->>'ruleVersion' = 'split-13-7-v1'
        AND marketplace_fee_delta_snapshot->>'roundingRule' = 'HALF_UP_PER_COMPONENT'
      )
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION validate_split_marketplace_fee_snapshot_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  new_row jsonb := to_jsonb(NEW);
  old_row jsonb := to_jsonb(OLD);
BEGIN
  IF TG_OP = 'UPDATE' AND (
    new_row -> 'marketplace_fee_snapshot' IS DISTINCT FROM old_row -> 'marketplace_fee_snapshot'
    OR (TG_TABLE_NAME IN ('booking_drafts', 'bookings') AND
        new_row -> 'customer_total_amount_minor' IS DISTINCT FROM old_row -> 'customer_total_amount_minor')
  ) THEN
    RAISE EXCEPTION 'marketplace fee snapshot is immutable once persisted';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS booking_drafts_marketplace_fee_snapshot_immutable ON booking_drafts;
CREATE TRIGGER booking_drafts_marketplace_fee_snapshot_immutable
  BEFORE UPDATE ON booking_drafts
  FOR EACH ROW EXECUTE FUNCTION validate_split_marketplace_fee_snapshot_immutability();

DROP TRIGGER IF EXISTS payments_marketplace_fee_snapshot_immutable ON payments;
CREATE TRIGGER payments_marketplace_fee_snapshot_immutable
  BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION validate_split_marketplace_fee_snapshot_immutability();

DROP TRIGGER IF EXISTS bookings_marketplace_fee_snapshot_immutable ON bookings;
CREATE TRIGGER bookings_marketplace_fee_snapshot_immutable
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION validate_split_marketplace_fee_snapshot_immutability();
