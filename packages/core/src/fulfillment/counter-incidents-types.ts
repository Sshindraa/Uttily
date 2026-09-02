import type { BookingStatus } from './types';
import type { InventoryCondition } from '../catalog/types';

export interface RecordBookingNoShowInput {
  organizationId: string;
  bookingId: string;
  actorUserId: string;
  idempotencyKey: string;
  reason?: string | null | undefined;
  /** Horloge injectée pour les tests ; en production, l'instant courant est utilisé. */
  now?: Date | undefined;
}

export interface RecordBookingNoShowResult {
  kind: 'APPLIED';
  bookingId: string;
  previousStatus: 'CONFIRMED' | 'READY_FOR_PICKUP';
  status: 'CANCELLED';
  releasedBlockCount: number;
}

export interface SubstituteBookingItemInput {
  organizationId: string;
  bookingId: string;
  bookingItemId: string;
  replacementInventoryItemId: string;
  actorUserId: string;
  idempotencyKey: string;
}

export interface SubstituteBookingItemResult {
  kind: 'APPLIED';
  bookingId: string;
  bookingItemId: string;
  bookingBlockId: string;
  previousInventoryItemId: string;
  replacementInventoryItemId: string;
  previousSku: string;
  replacementSku: string;
}

export interface SubstitutionCandidate {
  id: string;
  internalSku: string;
  serialNumber: string | null;
  condition: InventoryCondition;
}

/** Vue sûre pour le sélecteur comptoir : aucun identifiant technique d'item. */
export type SubstitutionCandidateOption = Omit<SubstitutionCandidate, 'id'>;

export function isNoShowEligibleStatus(
  status: BookingStatus,
): status is 'CONFIRMED' | 'READY_FOR_PICKUP' {
  return status === 'CONFIRMED' || status === 'READY_FOR_PICKUP';
}

export function isBookingNoShowEligible(
  status: BookingStatus,
  customerStartAt: Date,
  now: Date,
): status is 'CONFIRMED' | 'READY_FOR_PICKUP' {
  return (
    isNoShowEligibleStatus(status) &&
    Number.isFinite(customerStartAt.getTime()) &&
    Number.isFinite(now.getTime()) &&
    customerStartAt.getTime() <= now.getTime()
  );
}

export function isSubstitutionEligibleStatus(
  status: BookingStatus,
): status is 'CONFIRMED' | 'READY_FOR_PICKUP' {
  return isNoShowEligibleStatus(status);
}

export function isUsableSubstitutionCondition(
  condition: InventoryCondition,
): condition is 'NEW' | 'GOOD' | 'FAIR' {
  return condition === 'NEW' || condition === 'GOOD' || condition === 'FAIR';
}
