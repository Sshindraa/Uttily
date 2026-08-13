/**
 * @uttily/core — createNeutralBookingAmendment (G7M-B2-A, ADR-023 §3-9, §11-13, §15).
 *
 * Wrapper public du moteur d'amendement pour le type NEUTRAL (delta financier nul).
 */

import type { DatabaseClient } from '@uttily/database';
import type { AuthenticatedUser } from '../identity/types';
import type { NeutralAmendmentCommand, NeutralAmendmentResult } from './types-amendment';
import { executeBookingAmendmentInternal } from './execute-booking-amendment-internal';

export {
  validateCommand,
  computeAmendmentFingerprint,
  computeLineDiff,
  classifyDelta,
} from './execute-booking-amendment-internal';

export async function createNeutralBookingAmendment(
  db: DatabaseClient,
  authenticatedActor: AuthenticatedUser,
  organizationId: string,
  command: NeutralAmendmentCommand,
  options?: { now?: Date },
): Promise<NeutralAmendmentResult> {
  return (await executeBookingAmendmentInternal(
    db,
    authenticatedActor,
    organizationId,
    command,
    'NEUTRAL',
    options,
  )) as NeutralAmendmentResult;
}
