export type PlanningEventType =
  'RENTAL' | 'HOLD' | 'MAINTENANCE' | 'MANUAL_BLOCK' | 'PICKUP' | 'RETURN';

export interface OperationalPlanningEvent {
  id: string;
  type: PlanningEventType;
  bookingId?: string | undefined;
  /** Bloc de disponibilité source pour les timelines détaillées. */
  inventoryBlockId?: string | undefined;
  /** Identifiant du bloc HOLD lorsqu'il s'agit d'une réservation temporaire. */
  holdId?: string | undefined;
  /** Échéance du hold, conservée comme instant UTC. */
  holdExpiresAt?: Date | undefined;
  maintenanceCaseId?: string | undefined;
  manualBlockId?: string | undefined;
  /** Série source lorsque le MANUAL_BLOCK est une occurrence récurrente. */
  recurringSeriesId?: string | undefined;
  inventoryItemId: string;
  internalSku: string;
  productName: string;
  variantName: string;
  categorySlug: string;
  locationId: string;
  locationName: string;
  locationTimeZone: string;
  startAt: Date;
  endAt: Date;
  /** Période client avant les buffers, lorsque la source la fournit. */
  customerStartAt?: Date | undefined;
  customerEndAt?: Date | undefined;
  /** Période opérationnelle complète avant troncature, lorsque disponible. */
  blockedStartAt?: Date | undefined;
  blockedEndAt?: Date | undefined;
  status: string;
  customerName?: string | undefined;
  reason?: string | undefined;
}

export interface OperationalPlanningFleetItem {
  id: string;
  internalSku: string;
  serialNumber: string | null;
  productName: string;
  variantName: string;
  categorySlug: string;
  condition: string;
  status: string;
  locationId: string;
  locationName: string;
}

export interface OperationalPlanning {
  from: Date;
  to: Date;
  locationId: string | null;
  locationName: string | null;
  locationTimeZone: string;
  events: OperationalPlanningEvent[];
  stats: {
    totalRentals: number;
    totalPickups: number;
    totalReturns: number;
    totalMaintenances: number;
    totalManualBlocks: number;
    /** Holds actifs dans la fenêtre ; optionnel pour les fixtures legacy. */
    totalHolds?: number | undefined;
  };
  fleetItems: OperationalPlanningFleetItem[];
}

export interface GetOperationalPlanningOptions {
  /** Instant de référence utilisé pour calculer la semaine par défaut. */
  asOf?: Date | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  locationId?: string | undefined;
  inventoryItemId?: string | undefined;
}

/** Événements affichables dans le calendrier détaillé d'un exemplaire. */
export type OperationalItemCalendarEvent = OperationalPlanningEvent & {
  type: 'HOLD' | 'RENTAL' | 'MAINTENANCE' | 'MANUAL_BLOCK';
};

export interface OperationalItemCalendar {
  from: Date;
  to: Date;
  locationId: string;
  locationName: string;
  locationTimeZone: string;
  item: OperationalPlanningFleetItem;
  events: OperationalItemCalendarEvent[];
}

export type GetOperationalItemCalendarOptions = Pick<
  GetOperationalPlanningOptions,
  'asOf' | 'from' | 'to' | 'locationId'
>;
