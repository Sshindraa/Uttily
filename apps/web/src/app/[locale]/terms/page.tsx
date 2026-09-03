import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalPageLayout } from '@/features/legal';
import type { AppLocale } from '@/lib/locale';

interface TermsPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: TermsPageProps): Promise<Metadata> {
  const { locale } = await params;
  const fr = locale === 'fr';
  return {
    title: fr
      ? 'Conditions Générales d’Utilisation (CGU) · Uttily'
      : 'Terms of Service (ToS) · Uttily',
    description: fr
      ? 'Conditions générales d’utilisation de la plateforme de location d’équipements outdoor Uttily.'
      : 'Terms of service of the Uttily outdoor equipment rental marketplace platform.',
  };
}

export default async function TermsPage({ params }: TermsPageProps): Promise<React.ReactElement> {
  const { locale: rawLocale } = await params;
  if (rawLocale !== 'fr' && rawLocale !== 'en') notFound();
  const locale: AppLocale = rawLocale;
  const fr = locale === 'fr';

  return (
    <LegalPageLayout
      locale={locale}
      slug="terms"
      title={
        fr ? 'Conditions Générales d’Utilisation de la Plateforme' : 'Platform Terms of Service'
      }
      effectiveDate={fr ? '1er septembre 2026' : 'September 1, 2026'}
      version="v1"
    >
      {fr ? (
        <>
          <section>
            <h2>1. Objet et rôle d’Uttily</h2>
            <p>
              Les présentes Conditions Générales d’Utilisation (ci-après les « <strong>CGU</strong>{' '}
              ») définissent les règles d’accès et d’utilisation de la plateforme web éditée par
              Uttily SAS (ci-après « <strong>Uttily</strong> »).
            </p>
            <p>
              Uttily exploite une plateforme technique d’intermédiation B2B2C mettant en relation
              des utilisateurs (« <strong>Locataires</strong> » ou « <strong>Clients</strong> »)
              avec des professionnels indépendants de la location d’équipements outdoor («{' '}
              <strong>Loueurs</strong> »).
            </p>
            <div className="callout">
              <p>
                <strong>Important :</strong> Uttily agit exclusivement en qualité d’opérateur de
                plateforme technique en ligne (au sens de l’article L. 111-7 du Code de la
                consommation). Uttily n’est pas propriétaire des équipements mis en location, ne
                définit pas les stocks physiques et n’est pas partie au contrat de location conclu
                directement entre le Locataire et le Loueur.
              </p>
            </div>
          </section>

          <section>
            <h2>2. Accès au service et création de compte</h2>
            <p>
              La consultation du catalogue d’équipements et la recherche géographique sont
              accessibles sans obligation de création de compte préalable.
            </p>
            <p>
              La réservation et le paiement d’un équipement nécessitent la création d’un compte
              personnel authentifié. L’utilisateur garantit être âgé d’au moins 18 ans et disposer
              de la pleine capacité juridique pour s’engager. Les identifiants de connexion sont
              personnels, confidentiels et sous la responsabilité exclusive de l’utilisateur.
            </p>
          </section>

          <section>
            <h2>3. Fonctionnement de la plateforme et réservations</h2>
            <p>
              La plateforme permet la sélection d’équipements dans une destination donnée pour une
              période déterminée. Chaque panier de réservation est obligatoirement mono-loueur :
              tous les équipements d’une même commande proviennent d’un seul et même établissement
              partenaire.
            </p>
            <p>
              Lors de la validation du panier, un blocage temporaire (<em>hold</em>) réserve
              immédiatement l’exemplaire physique désigné afin d’empêcher tout surbooking pendant la
              finalisation du paiement sécurisé.
            </p>
          </section>

          <section>
            <h2>4. Obligations de l’utilisateur</h2>
            <p>En utilisant Uttily, l’utilisateur s’engage à :</p>
            <ul>
              <li>Fournir des informations véridiques, exactes et à jour ;</li>
              <li>
                Ne pas perturber l’intégrité technique de la plateforme ou tenter d’accéder à des
                données non autorisées ;
              </li>
              <li>
                Respecter les horaires de mise à disposition et de restitution convenus avec le
                Loueur ;
              </li>
              <li>
                Utiliser les équipements loués en personne prudente et raisonnable, conformément à
                leur destination outdoor et aux règles de sécurité en vigueur.
              </li>
            </ul>
          </section>

          <section>
            <h2>5. Propriété intellectuelle</h2>
            <p>
              L’ensemble des éléments composant la plateforme Uttily (marques, logos, graphismes,
              textes, code source, interfaces utilisateur et design system) sont la propriété
              exclusive d’Uttily SAS et sont protégés par le Code de la propriété intellectuelle.
              Toute reproduction ou extraction non autorisée est strictement interdite.
            </p>
          </section>

          <section>
            <h2>6. Responsabilité et disponibilité de la plateforme</h2>
            <p>
              Uttily met en œuvre tous les moyens raisonnables pour assurer la disponibilité
              continue de ses services 24h/24 et 7j/7. Toutefois, l’accès peut être temporairement
              suspendu pour des raisons de maintenance technique, d’évolution ou de force majeure.
            </p>
            <p>
              Uttily ne saurait être tenue responsable des manquements imputables au Loueur
              partenaire (ex. retard de préparation, défaut de matériel au comptoir) ou au
              Locataire, ni des dommages indirects résultant de l’utilisation de la plateforme.
            </p>
          </section>

          <section>
            <h2>7. Modification des conditions et droit applicable</h2>
            <p>
              Uttily se réserve le droit de modifier les présentes CGU à tout moment. La version
              applicable est la version <strong>v1</strong>, en vigueur à la date de réservation.
            </p>
            <p>
              Les présentes CGU sont régies par le droit français. Tout litige relatif à leur
              validité, interprétation ou exécution sera soumis aux tribunaux compétents du ressort
              de la Cour d’appel de Paris, sous réserve des dispositions protectrices applicables
              aux consommateurs.
            </p>
          </section>
        </>
      ) : (
        <>
          <section>
            <h2>1. Purpose and Role of Uttily</h2>
            <p>
              These Terms of Service (the “<strong>Terms</strong>”) govern access to and use of the
              web platform operated by Uttily SAS (“<strong>Uttily</strong>”).
            </p>
            <p>
              Uttily operates a B2B2C technical marketplace connecting customers (“
              <strong>Renters</strong>” or “<strong>Users</strong>”) with independent professional
              outdoor equipment rental businesses (“<strong>Partners</strong>” or “
              <strong>Rental Operators</strong>”).
            </p>
            <div className="callout">
              <p>
                <strong>Important:</strong> Uttily acts solely as an online technical intermediary
                platform. Uttily does not own the equipment listed for rental, does not manage
                physical inventories, and is not a party to the rental agreement entered into
                directly between the Renter and the Partner.
              </p>
            </div>
          </section>

          <section>
            <h2>2. Access to Services and User Account</h2>
            <p>
              Browsing equipment catalogs and conducting geographic searches is available without
              requiring an account.
            </p>
            <p>
              Booking and paying for equipment requires creating an authenticated user account.
              Users represent that they are at least 18 years old and have full legal capacity to
              enter into binding agreements. Login credentials are strictly personal and
              confidential.
            </p>
          </section>

          <section>
            <h2>3. Platform Functionality and Bookings</h2>
            <p>
              The platform enables selecting equipment in a designated destination for a defined
              rental window. Each booking cart is strictly single-partner: all items in a single
              booking belong to one specific rental location.
            </p>
            <p>
              Upon initiating checkout, a temporary hold locks the allocated physical items in real
              time to prevent double-booking while secure payment is processed.
            </p>
          </section>

          <section>
            <h2>4. User Obligations</h2>
            <p>By using Uttily, users agree to:</p>
            <ul>
              <li>Provide accurate, truthful, and up-to-date personal details;</li>
              <li>
                Refrain from tampering with platform security or attempting unauthorized data
                access;
              </li>
              <li>Respect pickup and return schedules agreed upon with the Rental Operator;</li>
              <li>
                Operate and care for rented outdoor equipment prudently and strictly in accordance
                with applicable safety regulations.
              </li>
            </ul>
          </section>

          <section>
            <h2>5. Intellectual Property</h2>
            <p>
              All components of the Uttily platform (trademarks, logos, visuals, texts, source code,
              UI components, and design system) are the exclusive property of Uttily SAS and
              protected by intellectual property law. Unauthorized copying or extraction is
              prohibited.
            </p>
          </section>

          <section>
            <h2>6. Liability and Platform Availability</h2>
            <p>
              Uttily endeavors to maintain uninterrupted service availability. However, service may
              be briefly paused for scheduled maintenance or unforeseen operational incidents.
            </p>
            <p>
              Uttily cannot be held liable for breaches or defaults attributable to the Partner
              (such as on-site gear condition) or the Renter, nor for indirect damages resulting
              from platform usage.
            </p>
          </section>

          <section>
            <h2>7. Governing Law and Amendments</h2>
            <p>
              These Terms may be amended periodically. The applicable version is version{' '}
              <strong>v1</strong>, effective on the date of your booking.
            </p>
            <p>
              These Terms are governed by French law. In the event of a dispute, jurisdiction is
              conferred upon the competent courts of Paris, France, subject to mandatory consumer
              protection laws.
            </p>
          </section>
        </>
      )}
    </LegalPageLayout>
  );
}
