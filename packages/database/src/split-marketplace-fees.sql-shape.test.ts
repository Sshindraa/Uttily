import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const migrationPath = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'drizzle',
  '0049_split_marketplace_fees.sql',
);
const migration = readFileSync(migrationPath, 'utf8');

describe('migration 0049 — forme SQL du guard split-fee', () => {
  it('isole le guard split sous un nom de fonction spécifique', () => {
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION validate_split_marketplace_fee_snapshot_immutability()',
    );
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION validate_marketplace_fee_snapshot_immutability()',
    );
    expect(migration).toContain('new_row jsonb := to_jsonb(NEW);');
    expect(migration).toContain('old_row jsonb := to_jsonb(OLD);');

    for (const table of ['booking_drafts', 'payments', 'bookings']) {
      expect(migration).toContain(
        `EXECUTE FUNCTION validate_split_marketplace_fee_snapshot_immutability();`,
      );
      expect(migration).toContain(`${table}_marketplace_fee_snapshot_immutable`);
    }
  });

  it('reste additive et conserve les colonnes split prévues', () => {
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS customer_total_amount_minor bigint');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS marketplace_fee_snapshot jsonb');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS marketplace_fee_delta_snapshot jsonb');
    expect(migration).toContain('ALTER TABLE booking_cancellations');
    expect(migration).not.toMatch(/UPDATE\s+(booking_drafts|payments|bookings)\b/i);
  });
});
