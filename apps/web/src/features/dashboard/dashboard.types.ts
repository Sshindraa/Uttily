import type {
  MaintenanceDashboardSignal,
  OrganizationOnboardingReadiness,
  ProfessionalVerificationResult,
} from '@uttily/core';

export interface DashboardTask {
  type: 'PICKUP' | 'RETURN';
  bookingId: string;
  time: Date;
  timeZone: string;
  modelName: string;
  sku: string;
  locationName: string;
}

export interface DashboardCockpitData {
  organizationId: string;
  organizationName: string;
  formattedDate: string;
  readiness: OrganizationOnboardingReadiness;
  professionalVerification: ProfessionalVerificationResult;
  pickupCount: number;
  returnCount: number;
  activeFleetCount: number;
  maintenanceSignals: MaintenanceDashboardSignal[];
  todayTasks: DashboardTask[];
  activeBookingCount: number;
  locationCount: number;
  memberCount: number;
  financePeriodLabel: string;
  netAfterCommissionMinor: number;
}
