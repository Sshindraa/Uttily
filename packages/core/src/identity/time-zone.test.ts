import { describe, it, expect } from 'vitest';
import { isValidTimeZone } from './time-zone';

describe('time-zone', () => {
  it('accepte les fuseaux IANA valides', () => {
    expect(isValidTimeZone('Europe/Paris')).toBe(true);
    expect(isValidTimeZone('America/New_York')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });

  it('rejette les fuseaux invalides', () => {
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('Paris')).toBe(false);
    expect(isValidTimeZone('Foo/Bar')).toBe(false);
  });
});
