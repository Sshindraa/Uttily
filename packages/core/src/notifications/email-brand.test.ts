import { describe, expect, it } from 'vitest';
import { EmailBrandConfigurationError, getEmailBrandConfig } from './email-brand';
import { renderEmailLayout } from './templates/layout';

describe('getEmailBrandConfig', () => {
  it('utilise la configuration publique et support de l’environnement', () => {
    expect(
      getEmailBrandConfig({
        NODE_ENV: 'production',
        PUBLIC_APP_URL: 'https://staging.uttily.example',
        SUPPORT_EMAIL: 'help@staging.uttily.example',
      }),
    ).toEqual({
      publicAppUrl: 'https://staging.uttily.example',
      supportEmail: 'help@staging.uttily.example',
    });
  });

  it('refuse une configuration de production incomplète', () => {
    expect(() => getEmailBrandConfig({ NODE_ENV: 'production' })).toThrow(
      EmailBrandConfigurationError,
    );
    expect(() =>
      getEmailBrandConfig({
        NODE_ENV: 'production',
        PUBLIC_APP_URL: 'https://uttily.com',
      }),
    ).toThrow(/SUPPORT_EMAIL/);
  });

  it('conserve un secours explicite uniquement hors production', () => {
    expect(getEmailBrandConfig({ NODE_ENV: 'test' })).toEqual({
      publicAppUrl: 'https://uttily.com',
      supportEmail: 'support@uttily.com',
    });
  });

  it('injecte la marque configurée dans le template HTML', () => {
    const html = renderEmailLayout({
      title: 'Test',
      contentHtml: '<p>Contenu</p>',
      brand: {
        publicAppUrl: 'https://staging.uttily.example',
        supportEmail: 'help@staging.uttily.example',
      },
    });

    expect(html).toContain('href="https://staging.uttily.example"');
    expect(html).toContain('mailto:help@staging.uttily.example');
    expect(html).not.toContain('support@uttily.com');
  });
});
