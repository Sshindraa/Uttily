export type PrivacyRequestUrgency = 'DUE_OVERDUE' | 'DUE_IMMINENT' | 'DUE_WARNING' | 'DUE_OK';

export type ExtensionComplianceStatus =
  'NONE' | 'PENDING_NOTIFICATION' | 'NOTIFIED_TIMELY' | 'NOTIFIED_LATE';

export type ResponseComplianceStatus = 'ON_TIME' | 'RESPONSE_LATE';

export interface SupportPrivacyRequestItem {
  readonly id: string;
  readonly userId: string;
  readonly userEmail: string | null;
  readonly userDisplayName: string | null;
  readonly requestType: string;
  readonly status: string;
  readonly resolution: string | null;
  readonly details: string | null;
  readonly decisionReasonCode: string | null;
  readonly resolutionNotes: string | null;
  readonly decisionAt: Date | null;
  readonly decisionByUserId: string | null;
  readonly responseNotifiedAt: Date | null;
  readonly responseNotifiedByUserId: string | null;
  readonly receivedAt: Date;
  readonly responseDueAt: Date;
  readonly extendedUntil: Date | null;
  readonly extensionReason: string | null;
  readonly extendedAt: Date | null;
  readonly extendedByUserId: string | null;
  readonly extensionNotifiedAt: Date | null;
  readonly extensionCompliance: ExtensionComplianceStatus;
  readonly effectiveDueAt: Date;
  readonly responseCompliance: ResponseComplianceStatus | null;
  readonly daysRemaining: number;
  readonly urgency: PrivacyRequestUrgency;
  readonly resolvedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ListPrivacyRequestsFilters {
  readonly tab?: 'ACTIVE' | 'CLOSED' | 'ALL' | undefined;
  readonly requestType?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

export interface ListPrivacyRequestsResult {
  readonly items: readonly SupportPrivacyRequestItem[];
  readonly totalCount: number;
  readonly activeCount: number;
  readonly closedCount: number;
  readonly overdueCount: number;
}

export interface StartPrivacyReviewInput {
  readonly requestId: string;
  readonly actorUserId: string;
}

export interface FlagPrivacyIdentityCheckInput {
  readonly requestId: string;
  readonly actorUserId: string;
  readonly note?: string | undefined;
}

export interface ExtendPrivacyDeadlineInput {
  readonly requestId: string;
  readonly actorUserId: string;
  readonly extendedUntil: Date;
  readonly reason: string;
  readonly notifiedAt?: Date | undefined;
}

export interface RecordExtensionNotificationInput {
  readonly requestId: string;
  readonly actorUserId: string;
  readonly notifiedAt?: Date | undefined;
}

export interface RecordPrivacyDecisionInput {
  readonly requestId: string;
  readonly actorUserId: string;
  readonly resolution: 'FULFILLED' | 'PARTIALLY_FULFILLED' | 'REFUSED';
  readonly decisionReasonCode?: string | null | undefined;
  readonly resolutionNotes: string;
}

export interface RecordPrivacyResponseNotificationInput {
  readonly requestId: string;
  readonly actorUserId: string;
  readonly responseNotifiedAt?: Date | undefined;
}

// Rétrocompatibilité : alias input
export interface ResolvePrivacyRequestInput {
  readonly requestId: string;
  readonly actorUserId: string;
  readonly resolution?: 'FULFILLED' | 'PARTIALLY_FULFILLED' | 'REFUSED' | undefined;
  readonly resolutionStatus?: 'FULFILLED' | 'PARTIALLY_FULFILLED' | 'REFUSED' | undefined;
  readonly decisionReasonCode?: string | null | undefined;
  readonly resolutionNotes: string;
}

export class PrivacySupportActionError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'PrivacySupportActionError';
    this.code = code;
  }
}
