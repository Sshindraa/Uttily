export type PlanningEventType = 'RENTAL' | 'MAINTENANCE' | 'PICKUP' | 'RETURN';

export interface OperationalPlanningEvent {
  id: string;
  type: PlanningEventType;
  bookingId?: string | undefined;
  maintenanceCaseId?: string | undefined;
  inventoryItemId: string;
  internalSku: string;
  productName: string;
  variantName: string;
  locationId: string;
  locationName: string;
  locationTimeZone: string;
  startAt: Date;
  endAt: Date;
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
