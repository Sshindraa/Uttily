export type MaintenanceCaseStatus = 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';

export interface MaintenanceCaseSummary {
  id: string;
  inventoryItemId: string;
  internalSku: string;
  serialNumber: string | null;
  productName: string;
  variantName: string;
  locationId: string;
  locationName: string;
  locationTimeZone: string;
  status: MaintenanceCaseStatus;
  condition: string;
  reason: string;
  notes: string | null;
  sourceDamageReportId: string | null;
  openedAt: Date;
  resolvedAt: Date | null;
}

export interface OpenMaintenanceInput {
  organizationId: string;
  inventoryItemId: string;
  actorUserId: string;
  reason: string;
  notes?: string | null | undefined;
  idempotencyKey: string;
}

export interface OpenMaintenanceResult {
  kind: 'APPLIED';
  maintenanceBlockId: string;
  inventoryItemId: string;
}

export interface ResolveMaintenanceInput {
  organizationId: string;
  maintenanceBlockId: string;
  actorUserId: string;
  targetCondition: 'GOOD' | 'FAIR' | 'NEW';
  notes?: string | null | undefined;
  idempotencyKey: string;
}

export interface ResolveMaintenanceResult {
  kind: 'APPLIED';
  maintenanceBlockId: string;
  inventoryItemId: string;
  releasedCondition: string;
}
