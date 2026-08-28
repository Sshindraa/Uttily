import type { OrganizationOnboardingReadiness } from '../dashboard/onboarding-readiness';
import type { MembershipRole } from '../identity/types';

export type SupportEntityType =
  'ORGANIZATION' | 'LOCATION' | 'BOOKING' | 'USER' | 'PAYMENT' | 'REFUND';

export interface SupportSearchItem {
  readonly id: string;
  readonly entityType: SupportEntityType;
  readonly title: string;
  readonly subtitle: string;
  readonly url: string;
  readonly badge?: {
    readonly label: string;
    readonly variant: 'default' | 'success' | 'warning' | 'danger' | 'info';
  };
  readonly metadata?: Record<string, string | number | boolean | null>;
}

export interface SupportSearchResult {
  readonly query: string;
  readonly totalMatches: number;
  readonly items: readonly SupportSearchItem[];
  readonly byCategory: {
    readonly organizations: readonly SupportSearchItem[];
    readonly locations: readonly SupportSearchItem[];
    readonly bookings: readonly SupportSearchItem[];
    readonly users: readonly SupportSearchItem[];
    readonly payments: readonly SupportSearchItem[];
    readonly refunds: readonly SupportSearchItem[];
  };
}

export interface OrganizationSupportDetails {
  readonly id: string;
  readonly legalName: string;
  readonly slug: string;
  readonly publicDisplayName: string | null;
  readonly status: string;
  readonly defaultCurrency: string;
  readonly defaultCancellationPolicyCode: string;
  readonly createdAt: Date;
  readonly readiness: OrganizationOnboardingReadiness;
  readonly locations: readonly {
    readonly id: string;
    readonly name: string;
    readonly addressLine1: string;
    readonly city: string;
    readonly postalCode: string;
    readonly countryCode: string;
    readonly timeZone: string;
    readonly pickupEnabled: boolean;
    readonly openingHoursCount: number;
    readonly scheduleExceptionsCount: number;
  }[];
  readonly members: readonly {
    readonly id: string;
    readonly userId: string;
    readonly email: string;
    readonly displayName: string | null;
    readonly role: MembershipRole;
    readonly status: string;
    readonly isPlatformAdmin: boolean;
    readonly createdAt: Date;
    readonly acceptedAt: Date | null;
  }[];
  readonly pendingInvitations: readonly {
    readonly id: string;
    readonly email: string;
    readonly role: MembershipRole;
    readonly status: string;
    readonly expiresAt: Date;
    readonly createdAt: Date;
  }[];
  readonly paymentAccount: {
    readonly id: string;
    readonly providerAccountId: string;
    readonly onboardingStatus: string | null;
    readonly chargesEnabled: boolean;
    readonly payoutsEnabled: boolean;
    readonly transfersCapabilityStatus: string | null;
  } | null;
  readonly inventoryOverview: {
    readonly total: number;
    readonly active: number;
    readonly retired: number;
    readonly lost: number;
    readonly byProduct: readonly {
      readonly productId: string;
      readonly productName: string;
      readonly totalCount: number;
      readonly activeCount: number;
    }[];
  };
  readonly recentBookings: readonly {
    readonly id: string;
    readonly customerEmail: string | null;
    readonly status: string;
    readonly totalAmountMinor: number;
    readonly currency: string;
    readonly pickupDate: Date;
    readonly returnDate: Date;
    readonly createdAt: Date;
  }[];
  readonly openIncidents: {
    readonly openMaintenanceCount: number;
    readonly damageReportsCount: number;
    readonly maintenanceCases: readonly {
      readonly id: string;
      readonly status: string;
      readonly reason: string;
      readonly openedAt: Date;
      readonly inventoryItemId: string;
      readonly bikeIdentifier: string | null;
    }[];
  };
  readonly alerts: {
    readonly failedNotificationsCount: number;
    readonly failedPaymentsCount: number;
    readonly requiresAttentionCount: number;
  };
}

export interface SupportTimelineEvent {
  readonly id: string;
  readonly timestamp: Date;
  readonly label: string;
  readonly description: string;
  readonly type: 'INFO' | 'SUCCESS' | 'WARNING' | 'ERROR';
  readonly actorEmail?: string | null;
}

export interface BookingSupportDetails {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly organizationSlug: string;
  readonly locationId: string;
  readonly locationName: string;
  readonly locationCity: string;
  readonly locationTimeZone: string;
  readonly customer: {
    readonly id: string | null;
    readonly email: string;
    readonly displayName: string | null;
  };
  readonly status: string;
  readonly fulfillmentStatus: string;
  readonly dates: {
    readonly pickupUtc: Date;
    readonly returnUtc: Date;
    readonly pickupLocalIso: string;
    readonly returnLocalIso: string;
    readonly timeZone: string;
  };
  readonly financial: {
    readonly currency: string;
    readonly grossPaidMinor: number;
    readonly originalTotalMinor: number;
    readonly supplementTotalMinor: number;
    readonly refundTotalMinor: number;
    readonly netRetainedMinor: number;
    readonly platformCommissionMinor: number;
    readonly finalMerchantRevenueMinor: number;
  };
  readonly lines: readonly {
    readonly id: string;
    readonly productId: string;
    readonly productName: string;
    readonly productVariantId: string;
    readonly variantName: string;
    readonly quantity: number;
    readonly unitPriceMinor: number;
    readonly totalAmountMinor: number;
    readonly allocations: readonly {
      readonly id: string;
      readonly inventoryItemId: string;
      readonly internalIdentifier: string | null;
      readonly serialNumber: string | null;
      readonly condition: string;
      readonly status: string;
    }[];
  }[];
  readonly payment: {
    readonly id: string;
    readonly status: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly providerPaymentIntentId: string | null;
    readonly createdAt: Date;
    readonly attempts: readonly {
      readonly id: string;
      readonly attemptNumber: number;
      readonly status: string;
      readonly providerStatus: string | null;
      readonly lastErrorCode: string | null;
      readonly createdAt: Date;
    }[];
  } | null;
  readonly cancellation: {
    readonly id: string;
    readonly occurredAt: Date;
    readonly actorReason: string;
    readonly policyCode: string;
    readonly grossPaidMinor: number;
    readonly refundAmountMinor: number;
    readonly retainedAmountMinor: number;
    readonly finalCommissionMinor: number;
    readonly finalMerchantRevenueMinor: number;
    readonly cancelledByEmail: string | null;
  } | null;
  readonly refunds: readonly {
    readonly id: string;
    readonly status: string;
    readonly amountMinor: number;
    readonly currency: string;
    readonly reason: string;
    readonly providerRefundId: string | null;
    readonly failureCode: string | null;
    readonly createdAt: Date;
  }[];
  readonly fulfillmentEvents: readonly {
    readonly id: string;
    readonly eventType: string;
    readonly occurredAt: Date;
    readonly actorUserId: string | null;
    readonly notes: string | null;
  }[];
  readonly conditionReports: readonly {
    readonly id: string;
    readonly phase: string;
    readonly condition: string;
    readonly notes: string | null;
    readonly createdAt: Date;
  }[];
  readonly damageReports: readonly {
    readonly id: string;
    readonly description: string;
    readonly createdAt: Date;
  }[];
  readonly notifications: readonly {
    readonly id: string;
    readonly template: string;
    readonly recipient: string;
    readonly status: string;
    readonly attemptCount: number;
    readonly scheduledFor: Date;
    readonly sentAt: Date | null;
    readonly failedAt: Date | null;
    readonly failureCode: string | null;
    readonly requiresManualReview: boolean;
  }[];
  readonly timeline: readonly SupportTimelineEvent[];
}

export interface PaymentSupportListItem {
  readonly id: string;
  readonly organizationId: string;
  readonly organizationName: string;
  readonly bookingId: string | null;
  readonly customerEmail: string | null;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: string;
  readonly providerPaymentIntentId: string | null;
  readonly createdAt: Date;
  readonly lastError: string | null;
  readonly requiresAttention: boolean;
}

export interface NotificationSupportListItem {
  readonly id: string;
  readonly organizationId: string | null;
  readonly organizationName: string | null;
  readonly bookingId: string | null;
  readonly template: string;
  readonly recipient: string;
  readonly status: string;
  readonly attemptCount: number;
  readonly scheduledFor: Date;
  readonly nextAttemptAt: Date | null;
  readonly sentAt: Date | null;
  readonly failedAt: Date | null;
  readonly failureCode: string | null;
  readonly requiresManualReview: boolean;
  readonly createdAt: Date;
}

export interface AuditLogSupportListItem {
  readonly id: string;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string | null;
  readonly metadata: Record<string, unknown> | null;
  readonly createdAt: Date;
}

export interface SupportActionContext {
  readonly actorUserId: string;
  readonly reason?: string | undefined;
}
