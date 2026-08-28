import { describe, it, expect, afterEach } from 'vitest';
import { verifyCronSecret } from './cron-auth';

/**
 * Chantier 18-A — Authentification partagée des endpoints cron.
 *
 * Convention Uttily : secret partagé `CRON_SECRET` en Bearer, refus
 * fail-closed si le secret est absent, comparaison à temps constant.
 */

const ORIGINAL = process.env.CRON_SECRET;

function requestWith(header?: string): Request {
  const headers = new Headers();
  if (header !== undefined) headers.set('Authorization', header);
  return new Request('https://uttily.test/api/cron/x', { method: 'GET', headers });
}

describe('18-A — verifyCronSecret', () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = ORIGINAL;
  });

  it('refuse quand CRON_SECRET est absent (fail-closed)', () => {
    delete process.env.CRON_SECRET;
    expect(verifyCronSecret(requestWith('Bearer quelconque'))).toBe(false);
  });

  it('refuse quand CRON_SECRET est vide (fail-closed)', () => {
    process.env.CRON_SECRET = '';
    expect(verifyCronSecret(requestWith('Bearer '))).toBe(false);
  });

  it('refuse sans en-tête Authorization', () => {
    process.env.CRON_SECRET = 's3cret';
    expect(verifyCronSecret(requestWith())).toBe(false);
  });

  it('refuse un schéma d’autorisation non Bearer', () => {
    process.env.CRON_SECRET = 's3cret';
    expect(verifyCronSecret(requestWith('Basic s3cret'))).toBe(false);
  });

  it('refuse un secret de longueur différente', () => {
    process.env.CRON_SECRET = 's3cret';
    expect(verifyCronSecret(requestWith('Bearer s3cret-plus-long'))).toBe(false);
  });

  it('refuse un secret de même longueur mais différent', () => {
    process.env.CRON_SECRET = 's3cret';
    expect(verifyCronSecret(requestWith('Bearer s4cret'))).toBe(false);
  });

  it('accepte le secret exact', () => {
    process.env.CRON_SECRET = 's3cret';
    expect(verifyCronSecret(requestWith('Bearer s3cret'))).toBe(true);
  });
});
