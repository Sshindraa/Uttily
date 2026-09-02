import type { BookingStatus, FulfillmentEventType } from './types';
import type { ConditionReportPhase } from './report-types';
import type { InventoryCondition, InventoryStatus } from '../catalog/types';

/**
 * @uttily/core — Types des read models opérationnels fulfillment (G4A).
 *
 * Aucun champ financier, Stripe, terms snapshot ou payload JSON n'est exposé.
 * L'email du client n'apparaît que sur la fiche détaillée (nécessaire au retrait).
 *
 * Note serveur uniquement : ces read models portent des `Date` natives et ne
 * doivent pas être passés tels quels à un Client Component sans sérialisation
 * contrôlée (les Date ne sont pas sérialisables en JSON tel quel). Les Server
 * Components peuvent les consommer directement.
 */

export interface OperationalBookingSummary {
  id: string;
  status: BookingStatus;
  locationId: string;
  locationName: string;
  locationTimeZone: string;
  customerStartAt: Date;
  customerEndAt: Date;
  bookingItemCount: number;
  conditionReportCount: number;
  damageReportCount: number;
  lastFulfillmentEventAt: Date | null;
}

/** Buckets mutuellement exclusifs du cockpit opérationnel quotidien. */
export const OPERATIONAL_DESK_BUCKETS = [
  'PICKUPS_TODAY',
  'OVERDUE',
  'RETURNS_TODAY',
  'ONGOING',
] as const;

export type OperationalDeskBucket = (typeof OPERATIONAL_DESK_BUCKETS)[number];

/**
 * Résumé d'un exemplaire transmis au cockpit.
 * Aucun champ financier ou identifiant de client n'est exposé.
 */
export type OperationalDeskBookingItem = Pick<
  OperationalBookingItem,
  | 'bookingItemId'
  | 'inventoryItemId'
  | 'internalSku'
  | 'serialNumber'
  | 'currentCondition'
  | 'inventoryStatus'
>;

export interface OperationalDeskBooking extends OperationalBookingSummary {
  bucket: OperationalDeskBucket;
  items: OperationalDeskBookingItem[];
}

export type OperationalDayDeskBuckets = {
  [K in OperationalDeskBucket]: OperationalDeskBooking[];
};

export interface OperationalDayDesk {
  locationId: string;
  locationName: string;
  locationTimeZone: string;
  /** Date civile sélectionnée dans le fuseau du lieu (YYYY-MM-DD). */
  targetDate: string;
  /** Instant de référence utilisé pour le classement OVERDUE. */
  now: Date;
  buckets: OperationalDayDeskBuckets;
  counts: { [K in OperationalDeskBucket]: number };
  totalCount: number;
}

export interface OperationalBookingItem {
  bookingItemId: string;
  inventoryItemId: string;
  internalSku: string;
  serialNumber: string | null;
  currentCondition: InventoryCondition;
  inventoryStatus: InventoryStatus;
}

export interface OperationalConditionReport {
  id: string;
  bookingItemId: string;
  inventoryItemId: string;
  phase: ConditionReportPhase;
  condition: InventoryCondition;
  notes: string | null;
  reporterUserId: string;
  createdAt: Date;
}

export interface OperationalDamageReport {
  id: string;
  bookingItemId: string;
  inventoryItemId: string;
  description: string;
  reporterUserId: string;
  createdAt: Date;
}

export interface OperationalFulfillmentEvent {
  id: string;
  eventType: FulfillmentEventType;
  previousStatus: BookingStatus;
  nextStatus: BookingStatus;
  actorUserId: string;
  occurredAt: Date;
}

export interface OperationalBookingDetails {
  id: string;
  status: BookingStatus;
  locationId: string;
  locationName: string;
  locationTimeZone: string;
  customerStartAt: Date;
  customerEndAt: Date;
  customerEmail: string;
  items: OperationalBookingItem[];
  conditionReports: OperationalConditionReport[];
  damageReports: OperationalDamageReport[];
  fulfillmentEvents: OperationalFulfillmentEvent[];
}
