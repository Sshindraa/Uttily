import { describe, it, expect } from 'vitest';
import {
  DOCUMENT_TYPES,
  OUTBOX_EFFECT_TYPES,
  OUTBOX_EFFECT_STATUSES,
  NOTIFICATION_DELIVERY_STATUSES,
  DOCUMENT_PROCESSING_FAILURE_CODES,
} from './types';

describe('Enums dérivés de Drizzle — contrats publics', () => {
  it('DOCUMENT_TYPES est exact', () => {
    expect(DOCUMENT_TYPES).toEqual(['CONFIRMATION', 'CONTRACT', 'RECEIPT']);
  });

  it('OUTBOX_EFFECT_TYPES est exact', () => {
    expect(OUTBOX_EFFECT_TYPES).toEqual([
      'GENERATE_CONFIRMATION',
      'GENERATE_CONTRACT',
      'GENERATE_RECEIPT',
      'SEND_EMAIL',
    ]);
  });

  it('OUTBOX_EFFECT_STATUSES est exact', () => {
    expect(OUTBOX_EFFECT_STATUSES).toEqual(['PENDING', 'COMPLETED', 'FAILED']);
  });

  it('NOTIFICATION_DELIVERY_STATUSES est exact et ne contient pas BOUNCED', () => {
    expect(NOTIFICATION_DELIVERY_STATUSES).toEqual([
      'PENDING',
      'SENT',
      'FAILED',
      'REQUIRES_MANUAL_REVIEW',
    ]);
    expect(NOTIFICATION_DELIVERY_STATUSES).not.toContain('BOUNCED');
  });

  it('DOCUMENT_PROCESSING_FAILURE_CODES est exact et ne contient pas EMAIL_BOUNCED', () => {
    expect(DOCUMENT_PROCESSING_FAILURE_CODES).toEqual([
      'PAYLOAD_MALFORMED',
      'STORAGE_PUT_FAILED',
      'STORAGE_CHECKSUM_MISMATCH',
      'STORAGE_NOT_FOUND',
      'RENDER_FAILED',
      'EMAIL_SEND_FAILED',
      'LEASE_LOST',
      'UNKNOWN_ERROR',
      'PROVIDER_RESULT_UNCERTAIN',
      'EMAIL_RETRY_WINDOW_EXPIRED',
    ]);
    expect(DOCUMENT_PROCESSING_FAILURE_CODES).not.toContain('EMAIL_BOUNCED');
  });
});
