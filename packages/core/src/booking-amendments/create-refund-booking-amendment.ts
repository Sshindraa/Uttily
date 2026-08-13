/**
 * @uttily/core — createRefundBookingAmendment (G7M-B2-B1, ADR-023 §3-9, §11-13, §15).
 *
 * Wrapper public du moteur d'amendement pour le type REFUND (nouveau total < ancien total).
 * Crée et applique l'amendement, persiste la dette de remboursement (status: PENDING)
 * et publie l'événement outbox REFUND_REQUESTED.v1 dans la même transaction atomique.
 */

import type { DatabaseClient } from '@uttily/database';
import type { AuthenticatedUser } from '../identity/types';
import type { RefundAmendmentCommand, RefundAmendmentResult } from './types-amendment';
import { executeBookingAmendmentInternal } from './execute-booking-amendment-internal';

export async function createRefundBookingAmendment(
  db: DatabaseClient,
  authenticatedActor: AuthenticatedUser,
  organizationId: string,
  command: RefundAmendmentCommand,
  options?: { now?: Date },
): Promise<RefundAmendmentResult> {
  return (await executeBookingAmendmentInternal(
    db,
    authenticatedActor,
    organizationId,
    command,
    'REFUND',
    options,
  )) as RefundAmendmentResult;
}
