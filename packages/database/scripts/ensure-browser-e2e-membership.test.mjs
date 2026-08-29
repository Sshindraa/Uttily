import { describe, expect, it } from 'vitest';
import {
  assertBrowserE2eEnvironment,
  isBrowserE2eEnvironment,
} from './ensure-browser-e2e-membership.mjs';

describe('browser E2E membership fixture guards', () => {
  it('requires the explicit browser E2E marker and a non-production environment', () => {
    expect(isBrowserE2eEnvironment({ E2E_CLERK_USER_EMAIL: 'e2e+clerk_test@example.com' })).toBe(
      false,
    );
    expect(() =>
      assertBrowserE2eEnvironment({
        UTTILY_BROWSER_E2E: '1',
        NODE_ENV: 'production',
        E2E_CLERK_USER_EMAIL: 'e2e+clerk_test@example.com',
      }),
    ).toThrow(/fixture membership E2E/i);
  });

  it('accepts only a dedicated Clerk test email', () => {
    const validEnvironment = {
      UTTILY_BROWSER_E2E: '1',
      NODE_ENV: 'test',
      E2E_CLERK_USER_EMAIL: 'e2e+clerk_test@example.com',
    };
    expect(isBrowserE2eEnvironment(validEnvironment)).toBe(true);
    expect(() => assertBrowserE2eEnvironment(validEnvironment)).not.toThrow();
    expect(() =>
      assertBrowserE2eEnvironment({
        ...validEnvironment,
        E2E_CLERK_USER_EMAIL: 'person@example.com',
      }),
    ).toThrow(/adresse Clerk de test/i);
  });
});
