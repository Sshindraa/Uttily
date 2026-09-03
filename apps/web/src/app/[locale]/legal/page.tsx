import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalPageLayout } from '@/features/legal';
import type { AppLocale } from '@/lib/locale';

interface LegalNoticePageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: LegalNoticePageProps): Promise<Metadata> {
  const { locale } = await params;
  const fr = locale === 'fr';
  return {
    title: fr ? 'Mentions Légales · Uttily' : 'Legal Notice · Uttily',
    description: fr
      ? 'Mentions légales obligatoires, éditeur et hébergeurs de la plateforme Uttily.'
      : 'Mandatory legal notices, publisher and host details for the Uttily platform.',
  };
}

export default async function LegalNoticePage({
  params,
}: LegalNoticePageProps): Promise<React.ReactElement> {
  const { locale: rawLocale } = await params;
  if (rawLocale !== 'fr' && rawLocale !== 'en') notFound();
  const locale: AppLocale = rawLocale;
  const fr = locale === 'fr';

  return (
    <LegalPageLayout
      locale={locale}
      slug="legal"
      title={fr ? 'Mentions Légales' : 'Legal Notice'}
      effectiveDate={fr ? '1er septembre 2026' : 'September 1, 2026'}
      version="v1"
    >
      {fr ? (
        <>
          <section>
            <h2>1. Éditeur de la plateforme</h2>
            <p>
              Le site et la plateforme <strong>Uttily</strong> sont édités par la société :
            </p>
            <ul>
              <li>
                <strong>Dénomination sociale :</strong> Uttily SAS
              </li>
              <li>
                <strong>Forme juridique :</strong> Société par Actions Simplifiée (SAS)
              </li>
              <li>
                <strong>Capital social :</strong> 10 000 euros
              </li>
              <li>
                <strong>Siège social :</strong> Paris, France
              </li>
              <li>
                <strong>Courrier électronique :</strong>{' '}
                <a href="mailto:contact@uttily.com">contact@uttily.com</a>
              </li>
              <li>
                <strong>Directeur de la publication :</strong> La présidence d’Uttily SAS
              </li>
            </ul>
          </section>

          <section>
            <h2>2. Hébergement de l’application</h2>
            <p>L’application web et ses interfaces sont hébergées par :</p>
            <ul>
              <li>
                <strong>Société :</strong> Vercel Inc.
              </li>
              <li>
                <strong>Adresse :</strong> 440 N Barranca Ave #4133, Covina, CA 91723, États-Unis
              </li>
              <li>
                <strong>Site web :</strong>{' '}
                <a href="https://vercel.com" target="_blank" rel="noopener noreferrer">
                  https://vercel.com
                </a>
              </li>
            </ul>
          </section>

          <section>
            <h2>3. Hébergement des données transactionnelles</h2>
            <p>La base de données PostgreSQL de la plateforme est hébergée par :</p>
            <ul>
              <li>
                <strong>Société :</strong> Neon Inc.
              </li>
              <li>
                <strong>Adresse :</strong> 340 S Lemon Ave #9397, Walnut, CA 91789, États-Unis
              </li>
              <li>
                <strong>Site web :</strong>{' '}
                <a href="https://neon.tech" target="_blank" rel="noopener noreferrer">
                  https://neon.tech
                </a>
              </li>
            </ul>
          </section>

          <section>
            <h2>4. Prestataire de services de paiement</h2>
            <p>Les transactions financières et le séquestre des fonds sont opérés par :</p>
            <ul>
              <li>
                <strong>Société :</strong> Stripe Payments Europe, Ltd.
              </li>
              <li>
                <strong>Adresse :</strong> 1 Grand Canal Street Lower, Grand Canal Dock, Dublin, D02
                H210, Irlande
              </li>
              <li>
                <strong>Agrément :</strong> Établissement de monnaie électronique agréé par la
                Banque Centrale d’Irlande
              </li>
            </ul>
          </section>

          <section>
            <h2>5. Propriété intellectuelle</h2>
            <p>
              La marque <strong>Uttily</strong>, les logos, graphismes, iconographies, éléments de
              design et codes informatiques de la plateforme constituent des œuvres de l’esprit
              protégées par les dispositions du Code de la propriété intellectuelle.
            </p>
            <p>
              Toute reproduction, représentation, modification ou exploitation totale ou partielle
              du site sans l’autorisation écrite préalable d’Uttily SAS est constitutive de
              contrefaçon.
            </p>
          </section>
        </>
      ) : (
        <>
          <section>
            <h2>1. Platform Publisher</h2>
            <p>
              The <strong>Uttily</strong> platform and website are published by:
            </p>
            <ul>
              <li>
                <strong>Company name:</strong> Uttily SAS
              </li>
              <li>
                <strong>Legal structure:</strong> Simplified Joint-Stock Company (Société par
                Actions Simplifiée)
              </li>
              <li>
                <strong>Share capital:</strong> €10,000
              </li>
              <li>
                <strong>Head office:</strong> Paris, France
              </li>
              <li>
                <strong>Contact email:</strong>{' '}
                <a href="mailto:contact@uttily.com">contact@uttily.com</a>
              </li>
              <li>
                <strong>Publication Director:</strong> The Presidency of Uttily SAS
              </li>
            </ul>
          </section>

          <section>
            <h2>2. Application Hosting</h2>
            <p>The web platform and application interfaces are hosted by:</p>
            <ul>
              <li>
                <strong>Company:</strong> Vercel Inc.
              </li>
              <li>
                <strong>Address:</strong> 440 N Barranca Ave #4133, Covina, CA 91723, USA
              </li>
              <li>
                <strong>Website:</strong>{' '}
                <a href="https://vercel.com" target="_blank" rel="noopener noreferrer">
                  https://vercel.com
                </a>
              </li>
            </ul>
          </section>

          <section>
            <h2>3. Transactional Database Hosting</h2>
            <p>Platform PostgreSQL databases are hosted by:</p>
            <ul>
              <li>
                <strong>Company:</strong> Neon Inc.
              </li>
              <li>
                <strong>Address:</strong> 340 S Lemon Ave #9397, Walnut, CA 91789, USA
              </li>
              <li>
                <strong>Website:</strong>{' '}
                <a href="https://neon.tech" target="_blank" rel="noopener noreferrer">
                  https://neon.tech
                </a>
              </li>
            </ul>
          </section>

          <section>
            <h2>4. Payment Services Provider</h2>
            <p>Payment flows and escrow operations are handled by:</p>
            <ul>
              <li>
                <strong>Company:</strong> Stripe Payments Europe, Ltd.
              </li>
              <li>
                <strong>Address:</strong> 1 Grand Canal Street Lower, Grand Canal Dock, Dublin, D02
                H210, Ireland
              </li>
              <li>
                <strong>Authorization:</strong> Electronic Money Institution regulated by the
                Central Bank of Ireland
              </li>
            </ul>
          </section>

          <section>
            <h2>5. Intellectual Property</h2>
            <p>
              The <strong>Uttily</strong> brand, logos, graphic assets, interface components, and
              software source code are protected under intellectual property law.
            </p>
            <p>
              Any unauthorized reproduction or exploitation without prior written consent from
              Uttily SAS constitutes an infringement.
            </p>
          </section>
        </>
      )}
    </LegalPageLayout>
  );
}
