import type { DatabaseClient } from '@uttily/database';

export type NotificationChannel = 'EMAIL';

export type NotificationTemplate =
  | 'BOOKING_CONFIRMED_CUSTOMER'
  | 'BOOKING_CONFIRMED_MERCHANT'
  | 'BOOKING_CANCELLED_CUSTOMER'
  | 'BOOKING_CANCELLED_MERCHANT'
  | 'REFUND_CONFIRMED_CUSTOMER'
  | 'PICKUP_REMINDER_CUSTOMER'
  | 'RETURN_REMINDER_CUSTOMER'
  | 'REFUND_ACTION_REQUIRED_MERCHANT'
  | 'ORGANIZATION_INVITATION';

export type NotificationStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED';

export type NotificationErrorCategory = 'TRANSIENT' | 'DETERMINISTIC' | 'UNCERTAIN';

export class NotificationSendError extends Error {
  readonly category: NotificationErrorCategory;
  readonly code: string;

  constructor(category: NotificationErrorCategory, code: string, message: string) {
    super(message);
    this.name = 'NotificationSendError';
    this.category = category;
    this.code = code;
  }
}

export interface NotificationDependencies {
  readonly db: DatabaseClient;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface ProcessNotificationOptions {
  readonly batchLimit?: number;
  readonly now?: Date;
  readonly leaseDurationSeconds?: number;
}

export interface ProcessNotificationBatchResult {
  readonly claimedCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly retriedCount: number;
  readonly cancelledCount: number;
  readonly leaseLostCount: number;
}
