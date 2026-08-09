export interface ListMaintenanceDashboardSignalsOptions {
  asOf?: Date;
  limit?: number;
}

export interface MaintenanceDashboardSignalCommon {
  inventoryItemId: string;
  internalSku: string;
  productName: string;
  variantName: string;
  locationId: string;
  locationName: string;
  locationTimeZone: string;
}

export type MaintenanceDashboardBrokenItemSignal = MaintenanceDashboardSignalCommon & {
  kind: 'BROKEN_ITEM';
};

export type MaintenanceDashboardActiveMaintenanceSignal = MaintenanceDashboardSignalCommon & {
  kind: 'ACTIVE_MAINTENANCE';
  maintenanceBlockId: string;
  blockedStartAt: Date;
  blockedEndAt: Date;
};

export type MaintenanceDashboardUpcomingMaintenanceSignal = MaintenanceDashboardSignalCommon & {
  kind: 'UPCOMING_MAINTENANCE';
  maintenanceBlockId: string;
  blockedStartAt: Date;
  blockedEndAt: Date;
};

export type MaintenanceDashboardMaintenanceSignal =
  MaintenanceDashboardActiveMaintenanceSignal | MaintenanceDashboardUpcomingMaintenanceSignal;

export type MaintenanceDashboardSignal =
  MaintenanceDashboardBrokenItemSignal | MaintenanceDashboardMaintenanceSignal;

export type MaintenanceBlockSignalKind = 'ACTIVE_MAINTENANCE' | 'UPCOMING_MAINTENANCE';

export interface MaintenanceBlockForClassification {
  blockedStartAt: Date;
  blockedEndAt: Date;
}
