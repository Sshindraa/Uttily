import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('@clerk/nextjs', () => ({
  SignedIn: () => null,
  SignedOut: ({ children }: { children: ReactNode }) => children,
  UserButton: () => <span>Gestion du compte Clerk</span>,
}));

vi.mock('next/navigation', () => ({
  usePathname: () => '/fr/terms',
  useRouter: () => ({ push: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));

import TermsPage, { generateMetadata as generateTermsMetadata } from '@/app/[locale]/terms/page';
import RentalTermsPage, {
  generateMetadata as generateRentalTermsMetadata,
} from '@/app/[locale]/rental-terms/page';
import PrivacyPage, {
  generateMetadata as generatePrivacyMetadata,
} from '@/app/[locale]/privacy/page';
import LegalNoticePage, {
  generateMetadata as generateLegalMetadata,
} from '@/app/[locale]/legal/page';
import ProTermsPage, {
  generateMetadata as generateProTermsMetadata,
} from '@/app/[locale]/pro-terms/page';
import { getCheckoutCopy } from '@/lib/checkout-copy';

describe('Pages légales et contractuelles (21-L1)', () => {
  describe('CGU — /terms', () => {
    it('génère les métadonnées FR et EN', async () => {
      const frMeta = await generateTermsMetadata({ params: Promise.resolve({ locale: 'fr' }) });
      expect(frMeta.title).toContain('Conditions Générales d’Utilisation');

      const enMeta = await generateTermsMetadata({ params: Promise.resolve({ locale: 'en' }) });
      expect(enMeta.title).toContain('Terms of Service');
    });

    it('affiche le document en français avec le titre et les sections', async () => {
      const element = await TermsPage({ params: Promise.resolve({ locale: 'fr' }) });
      const html = renderToStaticMarkup(element);

      expect(html).toContain('Conditions Générales d’Utilisation de la Plateforme');
      expect(html).toContain('Version v1');
      expect(html).toContain('Objet et rôle d’Uttily');
      expect(html).toContain('Code de la consommation');
    });

    it('affiche le document en anglais pour la locale EN', async () => {
      const element = await TermsPage({ params: Promise.resolve({ locale: 'en' }) });
      const html = renderToStaticMarkup(element);

      expect(html).toContain('Platform Terms of Service');
      expect(html).toContain('Purpose and Role of Uttily');
    });
  });

  describe('CGL / CGV — /rental-terms', () => {
    it('génère les métadonnées et affiche les règles de location', async () => {
      const frMeta = await generateRentalTermsMetadata({
        params: Promise.resolve({ locale: 'fr' }),
      });
      expect(frMeta.title).toContain('Conditions Générales de Location');

      const element = await RentalTermsPage({ params: Promise.resolve({ locale: 'fr' }) });
      const html = renderToStaticMarkup(element);

      expect(html).toContain('Conditions Générales de Location d’Équipements');
      expect(html).toContain('frais de service client Uttily');
      expect(html).toContain('Substitution d’urgence');
      expect(html).toContain('FLEXIBLE');
      expect(html).toContain('MODERATE');
      expect(html).toContain('FIRM');
      expect(html).toContain('Droit de grâce 24h');
    });
  });

  describe('Confidentialité — /privacy', () => {
    it('détaille le responsable de traitement et les sous-traitants RGPD', async () => {
      const frMeta = await generatePrivacyMetadata({ params: Promise.resolve({ locale: 'fr' }) });
      expect(frMeta.title).toContain('Politique de Confidentialité');

      const element = await PrivacyPage({ params: Promise.resolve({ locale: 'fr' }) });
      const html = renderToStaticMarkup(element);

      expect(html).toContain('Politique de Confidentialité et Protection des Données');
      expect(html).toContain('privacy@uttily.com');
      expect(html).toContain('Clerk Inc.');
      expect(html).toContain('Stripe Payments Europe Ltd');
      expect(html).toContain('Neon Inc.');
      expect(html).toContain('Cloudflare Inc.');
      expect(html).toContain('Resend Inc.');
    });
  });

  describe('Mentions légales — /legal', () => {
    it('affiche les mentions de l’éditeur et des hébergeurs', async () => {
      const frMeta = await generateLegalMetadata({ params: Promise.resolve({ locale: 'fr' }) });
      expect(frMeta.title).toContain('Mentions Légales');

      const element = await LegalNoticePage({ params: Promise.resolve({ locale: 'fr' }) });
      const html = renderToStaticMarkup(element);

      expect(html).toContain('Mentions Légales');
      expect(html).toContain('Uttily SAS');
      expect(html).toContain('Vercel Inc.');
      expect(html).toContain('Neon Inc.');
      expect(html).toContain('Stripe Payments Europe, Ltd.');
    });
  });

  describe('Conditions Partenaires Pro — /pro-terms (21-L2)', () => {
    it('génère les métadonnées FR et EN pour les conditions pro', async () => {
      const frMeta = await generateProTermsMetadata({ params: Promise.resolve({ locale: 'fr' }) });
      expect(frMeta.title).toContain('Conditions Générales Partenaires');

      const enMeta = await generateProTermsMetadata({ params: Promise.resolve({ locale: 'en' }) });
      expect(enMeta.title).toContain('Partner Terms');
    });

    it('affiche le contrat pro avec les clauses marketplace, commission et substitution', async () => {
      const element = await ProTermsPage({ params: Promise.resolve({ locale: 'fr' }) });
      const html = renderToStaticMarkup(element);

      expect(html).toContain('Conditions Générales Partenaires (Contrat Loueur Pro)');
      expect(html).toContain('Responsabilité Civile Professionnelle');
      expect(html).toContain('Obligation de substitution');
      expect(html).toContain('13 % HT');
      expect(html).toContain('Stripe Connect');
    });
  });

  describe('Consentement checkout client', () => {
    it('expose les libellés de consentement légal FR et EN', () => {
      const frCopy = getCheckoutCopy('fr');
      expect(frCopy.summary.legalConsentPrefix).toBe('En procédant au paiement, vous acceptez les');
      expect(frCopy.summary.rentalTermsLabel).toBe('Conditions Générales de Location');
      expect(frCopy.summary.cguLabel).toBe('Conditions d’Utilisation');
      expect(frCopy.summary.privacyLabel).toBe('Politique de Confidentialité');
      expect(frCopy.summary.legalTermsVersionBadge).toBe('(version v1)');

      const enCopy = getCheckoutCopy('en');
      expect(enCopy.summary.legalConsentPrefix).toBe('By proceeding to payment, you agree to the');
      expect(enCopy.summary.rentalTermsLabel).toBe('Rental Terms');
      expect(enCopy.summary.cguLabel).toBe('Terms of Service');
      expect(enCopy.summary.privacyLabel).toBe('Privacy Policy');
    });
  });
});
