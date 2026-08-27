import { sql } from 'drizzle-orm';
import type { DatabaseClient } from '@uttily/database';
import { connectedAccountPayouts } from '@uttily/database';
import { CatalogError } from '../catalog/errors';

export interface ProjectPayoutInput {
  organizationId: string;
  providerPayoutId: string;
  providerAccountId: string;
  amountMinor: number;
  currency?: string;
  status: 'PENDING' | 'IN_TRANSIT' | 'PAID' | 'FAILED' | 'CANCELLED';
  arrivalDate?: Date | null | undefined;
  paidAt?: Date | null | undefined;
  failedAt?: Date | null | undefined;
  failureCode?: string | null | undefined;
  failureMessage?: string | null | undefined;
  providerCreatedAt?: number | null | undefined;
  environment?: 'TEST' | 'LIVE' | undefined;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function projectPayoutEvent(
  db: DatabaseClient,
  input: ProjectPayoutInput,
): Promise<{ payoutId: string; status: string }> {
  if (!UUID_REGEX.test(input.organizationId)) {
    throw new CatalogError('VALIDATION', 'organizationId doit être un UUID valide.');
  }

  const env = input.environment ?? 'TEST';
  const currency = input.currency ?? 'EUR';

  const rows = await db
    .insert(connectedAccountPayouts)
    .values({
      organizationId: input.organizationId,
      provider: 'STRIPE',
      environment: env,
      providerPayoutId: input.providerPayoutId,
      providerAccountId: input.providerAccountId,
      amountMinor: input.amountMinor,
      currency,
      status: input.status,
      arrivalDate: input.arrivalDate ?? null,
      paidAt: input.paidAt ?? null,
      failedAt: input.failedAt ?? null,
      failureCode: input.failureCode ?? null,
      failureMessage: input.failureMessage ?? null,
      providerCreatedAt: input.providerCreatedAt ?? null,
      lastProviderEventAt: sql`now()`,
    })
    .onConflictDoUpdate({
      target: [
        connectedAccountPayouts.provider,
        connectedAccountPayouts.environment,
        connectedAccountPayouts.providerPayoutId,
      ],
      set: {
        status: input.status,
        arrivalDate: input.arrivalDate ?? sql`${connectedAccountPayouts.arrivalDate}`,
        paidAt: input.paidAt ?? sql`${connectedAccountPayouts.paidAt}`,
        failedAt: input.failedAt ?? sql`${connectedAccountPayouts.failedAt}`,
        failureCode: input.failureCode ?? sql`${connectedAccountPayouts.failureCode}`,
        failureMessage: input.failureMessage ?? sql`${connectedAccountPayouts.failureMessage}`,
        lastProviderEventAt: sql`now()`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ id: connectedAccountPayouts.id, status: connectedAccountPayouts.status });

  return {
    payoutId: rows[0]!.id,
    status: rows[0]!.status,
  };
}
