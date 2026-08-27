import { describe, expect, it } from 'vitest';
import { projectCustomerBookingStatus } from './get-customer-bookings';

describe('Customer Bookings — projectCustomerBookingStatus', () => {
  it('projette CONFIRMED vers CONFIRMED', () => {
    expect(projectCustomerBookingStatus('CONFIRMED')).toBe('CONFIRMED');
  });

  it('projette READY_FOR_PICKUP vers READY_FOR_PICKUP', () => {
    expect(projectCustomerBookingStatus('READY_FOR_PICKUP')).toBe('READY_FOR_PICKUP');
  });

  it('projette ACTIVE vers ACTIVE', () => {
    expect(projectCustomerBookingStatus('ACTIVE')).toBe('ACTIVE');
  });

  it('projette RETURNED et CLOSED vers COMPLETED', () => {
    expect(projectCustomerBookingStatus('RETURNED')).toBe('COMPLETED');
    expect(projectCustomerBookingStatus('CLOSED')).toBe('COMPLETED');
  });

  it('projette CANCELLED sans remboursement vers CANCELLED_NO_REFUND', () => {
    expect(projectCustomerBookingStatus('CANCELLED', null, 0)).toBe('CANCELLED_NO_REFUND');
    expect(projectCustomerBookingStatus('CANCELLED', null, null)).toBe('CANCELLED_NO_REFUND');
  });

  it('projette CANCELLED avec remboursement PENDING vers CANCELLED_REFUND_PENDING', () => {
    expect(projectCustomerBookingStatus('CANCELLED', 'PENDING', 10000)).toBe(
      'CANCELLED_REFUND_PENDING',
    );
    expect(projectCustomerBookingStatus('CANCELLED', 'SUBMITTED', 10000)).toBe(
      'CANCELLED_REFUND_PENDING',
    );
  });

  it('projette CANCELLED avec remboursement SUCCEEDED vers CANCELLED_REFUNDED', () => {
    expect(projectCustomerBookingStatus('CANCELLED', 'SUCCEEDED', 10000)).toBe(
      'CANCELLED_REFUNDED',
    );
  });

  it('projette CANCELLED avec remboursement FAILED vers CANCELLED_ACTION_REQUIRED', () => {
    expect(projectCustomerBookingStatus('CANCELLED', 'FAILED_REQUIRES_MANUAL_ACTION', 10000)).toBe(
      'CANCELLED_ACTION_REQUIRED',
    );
  });
});
