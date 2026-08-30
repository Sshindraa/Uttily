/**
 * @uttily/core — LIVE Readiness Checker Tests (Chantier 20-A, A2 + A4).
 *
 * Vérifie que :
 * - une config LIVE factice complète → PASS (ready = true)
 * - un secret requis manquant → FAIL (ready = false)
 * - un mélange TEST/LIVE → FAIL (INVALID_PREFIX)
 * - aucun secret dans les résultats
 */

import { describe, expect, it } from 'vitest';
import { checkLiveReadiness } from './check-live-readiness';
import { REQUIRED_LIVE_VARIABLES, OPTIONAL_VARIABLES } from './live-config';

/** Construit un environnement LIVE factice complet et cohérent. */
function fakeLiveEnv(): Record<string, string> {
  return {
    STRIPE_SECRET_KEY: 'sk_live_fake_key_for_readiness_test_only',
    NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_live_fake_publishable_key_for_test',
    STRIPE_ENVIRONMENT: 'LIVE',
    PAYMENTS_LIVE_ENABLED: 'true',
    STRIPE_PLATFORM_WEBHOOK_SECRET: 'whsec_platform_fake_secret',
    STRIPE_CONNECT_WEBHOOK_SECRET: 'whsec_connect_fake_secret',
    STRIPE_WEBHOOK_IP_ALLOWLIST: '54.187.174.169,54.187.205.235',
    STRIPE_WEBHOOK_RATE_LIMIT_VERIFIED: 'true',
    DATABASE_URL: 'postgresql://user:pass@host:5432/db',
    CLERK_SECRET_KEY: 'sk_live_fake_clerk_secret_key_sufficient_length',
    NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: 'pk_live_fake_clerk_publishable_key_sufficient_length',
    INVITATION_SECRET: 'a'.repeat(44), // Base64 of 32+ bytes
    CRON_SECRET: 'b'.repeat(44),
    PUBLIC_SEARCH_CURSOR_SECRET: 'c'.repeat(44),
    PUBLIC_APP_URL: 'https://app.uttily.com',
    SUPPORT_EMAIL: 'support@app.uttily.com',
    R2_ACCOUNT_ID: 'fake_account_id',
    R2_ACCESS_KEY_ID: 'fake_access_key',
    R2_SECRET_ACCESS_KEY: 'fake_secret_key',
    R2_BUCKET_NAME: 'uttily-production-documents',
    RESEND_API_KEY: 're_fake_api_key_for_testing',
    RESEND_FROM_EMAIL: 'Uttily <noreply@uttily.com>',
    RESEND_BOOKING_CONFIRMED_TEMPLATE_ID: 'tmpl_fake_booking_confirmed',
  };
}

describe('checkLiveReadiness', () => {
  it('config LIVE factice complète → ready = true, tous PRESENT', () => {
    const report = checkLiveReadiness(fakeLiveEnv());

    expect(report.ready).toBe(true);
    expect(report.requiredFailCount).toBe(0);
    expect(report.requiredPassCount).toBe(REQUIRED_LIVE_VARIABLES.length);
    for (const r of report.required) {
      expect(r.status).toBe('PRESENT');
    }
  });

  it('secret requis manquant → ready = false, variable MISSING', () => {
    const env = fakeLiveEnv();
    delete (env as Record<string, string | undefined>).STRIPE_SECRET_KEY;

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    expect(report.requiredFailCount).toBeGreaterThanOrEqual(1);
    const stripe = report.required.find((r) => r.name === 'STRIPE_SECRET_KEY');
    expect(stripe?.status).toBe('MISSING');
  });

  it('mélange TEST/LIVE (clé sk_test_ dans config LIVE) → INVALID_PREFIX', () => {
    const env = fakeLiveEnv();
    env.STRIPE_SECRET_KEY = 'sk_test_wrong_environment_key';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    const stripe = report.required.find((r) => r.name === 'STRIPE_SECRET_KEY');
    expect(stripe?.status).toBe('INVALID_PREFIX');
  });

  it('Clerk TEST dans config LIVE → INVALID_PREFIX', () => {
    const env = fakeLiveEnv();
    env.CLERK_SECRET_KEY = 'sk_test_wrong_clerk_env';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    const clerk = report.required.find((r) => r.name === 'CLERK_SECRET_KEY');
    expect(clerk?.status).toBe('INVALID_PREFIX');
  });

  it('INVITATION_SECRET trop court → TOO_SHORT', () => {
    const env = fakeLiveEnv();
    env.INVITATION_SECRET = 'short';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    const inv = report.required.find((r) => r.name === 'INVITATION_SECRET');
    expect(inv?.status).toBe('TOO_SHORT');
  });

  it('ne requiert plus de taux de commission dans l’environnement', () => {
    expect(
      REQUIRED_LIVE_VARIABLES.some((rule) => rule.name === 'PLATFORM_COMMISSION_RATE_BPS'),
    ).toBe(false);
  });

  it('PUBLIC_APP_URL HTTP → NOT_HTTPS', () => {
    const env = fakeLiveEnv();
    env.PUBLIC_APP_URL = 'http://localhost:3000';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    const url = report.required.find((r) => r.name === 'PUBLIC_APP_URL');
    expect(url?.status).toBe('NOT_HTTPS');
  });

  it('PUBLIC_APP_URL HTTPS locale → NOT_PUBLIC', () => {
    const env = fakeLiveEnv();
    env.PUBLIC_APP_URL = 'https://localhost';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    const url = report.required.find((r) => r.name === 'PUBLIC_APP_URL');
    expect(url?.status).toBe('NOT_PUBLIC');
  });

  it('DATABASE_URL locale → INVALID_VALUE', () => {
    const env = fakeLiveEnv();
    env.DATABASE_URL = 'postgresql://user:pass@127.0.0.1:5432/db';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    const database = report.required.find((r) => r.name === 'DATABASE_URL');
    expect(database?.status).toBe('INVALID_VALUE');
  });

  it('STRIPE_ENVIRONMENT = TEST dans config LIVE → INVALID_VALUE', () => {
    const env = fakeLiveEnv();
    env.STRIPE_ENVIRONMENT = 'TEST';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    const stripeEnv = report.required.find((r) => r.name === 'STRIPE_ENVIRONMENT');
    expect(stripeEnv?.status).toBe('INVALID_VALUE');
  });

  it('PAYMENTS_LIVE_ENABLED = false → INVALID_VALUE', () => {
    const env = fakeLiveEnv();
    env.PAYMENTS_LIVE_ENABLED = 'false';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    const gate = report.required.find((r) => r.name === 'PAYMENTS_LIVE_ENABLED');
    expect(gate?.status).toBe('INVALID_VALUE');
  });

  it('variable vide → EMPTY', () => {
    const env = fakeLiveEnv();
    env.DATABASE_URL = '   ';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    const db = report.required.find((r) => r.name === 'DATABASE_URL');
    expect(db?.status).toBe('EMPTY');
  });

  it("les variables optionnelles sont rapportées mais n'affectent pas ready", () => {
    const env = fakeLiveEnv();
    // Aucune variable optionnelle n'est définie

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(true); // Seules les required comptent
    expect(report.optional.length).toBe(OPTIONAL_VARIABLES.length);
    // Toutes les optionnelles sont MISSING puisque non fournies
    for (const opt of report.optional) {
      expect(opt.required).toBe(false);
    }
  });

  it('rejette des secrets webhook identiques pour les deux endpoints', () => {
    const env = fakeLiveEnv();
    env.STRIPE_CONNECT_WEBHOOK_SECRET = 'whsec_platform_fake_secret';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    expect(report.gates).toContainEqual({
      name: 'STRIPE_WEBHOOK_ENDPOINT_SECRETS_DISTINCT',
      description: 'Les secrets webhook plateforme et Connect sont distincts',
      status: 'FAIL',
    });
  });

  it('garde analytics PRODUCTION verrouillé sans sign-off privacy 20-C', () => {
    const env = fakeLiveEnv();
    env.PRODUCT_ANALYTICS_ENVIRONMENT = 'PRODUCTION';

    const report = checkLiveReadiness(env);

    expect(report.ready).toBe(false);
    expect(report.gates).toContainEqual({
      name: 'ANALYTICS_PRODUCTION_PRIVACY_LOCK',
      description: 'Analytics PRODUCTION bloqué jusqu’au sign-off privacy 20-C',
      status: 'FAIL',
    });
  });

  it('aucun secret dans le rapport — pas de champ value', () => {
    const report = checkLiveReadiness(fakeLiveEnv());

    const serialized = JSON.stringify(report);
    // Aucune valeur factice ne doit apparaître
    expect(serialized).not.toContain('sk_live_fake');
    expect(serialized).not.toContain('pk_live_fake');
    expect(serialized).not.toContain('whsec_');
    expect(serialized).not.toContain('re_fake');
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('fake_account_id');
    expect(serialized).not.toContain('tmpl_fake_booking_confirmed');
    // Les noms de variables sont attendus
    expect(serialized).toContain('STRIPE_SECRET_KEY');
  });

  it('environnement entièrement vide → tous MISSING, ready = false', () => {
    const report = checkLiveReadiness({});

    expect(report.ready).toBe(false);
    expect(report.requiredFailCount).toBe(REQUIRED_LIVE_VARIABLES.length);
    for (const r of report.required) {
      expect(r.status).toBe('MISSING');
    }
  });
});
