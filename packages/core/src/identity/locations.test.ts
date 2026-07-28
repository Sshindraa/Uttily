import { describe, it, expect } from 'vitest';
import { validateOpeningHours } from './locations';

describe('openingHours validation', () => {
  it('accepte des créneaux valides', () => {
    expect(() =>
      validateOpeningHours([
        { weekday: 0, openTime: '09:00:00', closeTime: '12:00:00' },
        { weekday: 0, openTime: '14:00:00', closeTime: '18:00:00' },
      ]),
    ).not.toThrow();
  });

  it('rejette open_time >= close_time', () => {
    expect(() =>
      validateOpeningHours([{ weekday: 1, openTime: '12:00:00', closeTime: '12:00:00' }]),
    ).toThrow();
    expect(() =>
      validateOpeningHours([{ weekday: 1, openTime: '18:00:00', closeTime: '09:00:00' }]),
    ).toThrow();
  });

  it('rejette un weekday hors 0-6', () => {
    expect(() =>
      validateOpeningHours([{ weekday: 7, openTime: '09:00:00', closeTime: '12:00:00' }]),
    ).toThrow();
    expect(() =>
      validateOpeningHours([{ weekday: -1, openTime: '09:00:00', closeTime: '12:00:00' }]),
    ).toThrow();
  });
});
