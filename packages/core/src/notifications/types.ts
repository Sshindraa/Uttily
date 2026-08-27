import type { DatabaseClient } from '@uttily/database';
import type { TransactionalEmailSender } from '../transactional-documents/ports';

export type NotificationChannel = 'EMAIL';

export type NotificationTemplate =
  | 'BOOKING_CONFIRMED_CUSTOMER'
  | 'BOOKING_CONFIRMED_MERCHANT'
  | 'BOOKING_CANCELLED_CUSTOMER'
  | 'BOOKING_CANCELLED_MERCHANT'
  | 'REFUND_CONFIRMED_CUSTOMER'
  | 'PICKUP_REMINDER_CUSTOMER'
  | 'RETURN_REMINDER_CUSTOMER'
  | 'REFUND_ACTION_REQUIRED_MERCHANT';

export type NotificationStatus = 'PENDING' | 'SENDING' | 'SENT' | 'FAILED' | 'CANCELLED';

export interface NotificationDependencies {
  readonly db: DatabaseClient;
  readonly emailSender: TransactionalEmailSender;
}

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface ProcessNotificationOptions {
  readonly batchLimit?: number;
  readonly now?: Date;
}

export interface ProcessNotificationBatchResult {
  readonly claimedCount: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly cancelledCount: number;
}
