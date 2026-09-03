import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalPageLayout } from '@/features/legal';
import type { AppLocale } from '@/lib/locale';

interface PrivacyPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PrivacyPageProps): Promise<Metadata> {
  const { locale } = await params;
  const fr = locale === 'fr';
  return {
    title: fr
      ? 'Politique de Confidentialité et Données Personnelles · Uttily'
      : 'Privacy Policy and Personal Data · Uttily',
    description: fr
      ? 'Engagement d’Uttily en matière de protection de vos données personnelles et respect du RGPD.'
      : 'Uttily’s commitment to personal data protection and GDPR compliance.',
  };
}

export default async function PrivacyPage({
  params,
}: PrivacyPageProps): Promise<React.ReactElement> {
  const { locale: rawLocale } = await params;
  if (rawLocale !== 'fr' && rawLocale !== 'en') notFound();
  const locale: AppLocale = rawLocale;
  const fr = locale === 'fr';

  return (
    <LegalPageLayout
      locale={locale}
      slug="privacy"
      title={
        fr
          ? 'Politique de Confidentialité et Protection des Données'
          : 'Privacy Policy and Data Protection'
      }
      effectiveDate={fr ? '1er septembre 2026' : 'September 1, 2026'}
      version="v1"
    >
      {fr ? (
        <>
          <section>
            <h2>1. Responsable de traitement</h2>
            <p>
              Le responsable du traitement des données personnelles collectées sur la plateforme est
              la société <strong>Uttily SAS</strong>.
            </p>
            <p>
              Pour toute question relative à la gestion de vos données ou pour exercer vos droits,
              vous pouvez contacter notre délégué à la protection des données par email à :{' '}
              <a href="mailto:privacy@uttily.com">privacy@uttily.com</a>.
            </p>
          </section>

          <section>
            <h2>2. Données personnelles collectées</h2>
            <p>
              Dans le cadre de l’utilisation de nos services, nous collectons uniquement les données
              strictement nécessaires aux finalités suivantes :
            </p>
            <ul>
              <li>
                <strong>Données d’identification et de contact :</strong> nom, prénom, adresse email
                et numéro de téléphone (utilisés pour la confirmation de réservation, l’accueil au
                comptoir et les alertes opérationnelles) ;
              </li>
              <li>
                <strong>Données de réservation et d’historique :</strong> équipements loués, dates,
                heures, établissements de retrait, constats d’état contradictoires et photographies
                d’équipements ;
              </li>
              <li>
                <strong>Données techniques de connexion :</strong> adresse IP, logs de connexion et
                identifiants de session technique (authentification Clerk).
              </li>
            </ul>
            <div className="callout">
              <p>
                <strong>Sécurité bancaire (zéro stockage) :</strong> Uttily ne collecte ni ne
                conserve aucun numéro complet de carte bancaire, date d’expiration ou cryptogramme
                visuel. Les transactions financières sont opérées directement par notre prestataire
                certifié <strong>Stripe</strong> (PCI-DSS Niveau 1).
              </p>
            </div>
          </section>

          <section>
            <h2>3. Finalités et bases légales des traitements</h2>
            <p>Vos données sont traitées sur les bases légales suivantes :</p>
            <ul>
              <li>
                <strong>Exécution du contrat de réservation (art. 6.1.b du RGPD) :</strong> gestion
                du compte, allocation du matériel physique, transmission au Loueur partenaire,
                émission des documents de location et assistance comptoir ;
              </li>
              <li>
                <strong>Respect d’obligations légales (art. 6.1.c du RGPD) :</strong> tenue de la
                comptabilité, facturation, conservation des preuves transactionnelles et lutte
                contre la fraude ;
              </li>
              <li>
                <strong>Intérêt légitime (art. 6.1.f du RGPD) :</strong> sécurité de la plateforme,
                prévention des impayés et amélioration de la qualité du service.
              </li>
            </ul>
          </section>

          <section>
            <h2>4. Destinataires des données et sous-traitants qualifiés</h2>
            <p>Vos données sont accessibles uniquement :</p>
            <ul>
              <li>
                <strong>Au Loueur professionnel partenaire</strong> chez qui vous retirez
                l’équipement, dans la stricte mesure nécessaire à l’exécution du service de location
                ;
              </li>
              <li>
                <strong>À nos sous-traitants techniques</strong> agissant sous contrat de conformité
                stricte au RGPD :
                <ul>
                  <li>
                    <strong>Clerk Inc.</strong> : gestion de l’authentification et des sessions
                    sécurisées ;
                  </li>
                  <li>
                    <strong>Stripe Payments Europe Ltd</strong> : paiement en ligne sécurisé et
                    séquestre ;
                  </li>
                  <li>
                    <strong>Neon Inc.</strong> : hébergement de la base de données transactionnelle
                    PostgreSQL ;
                  </li>
                  <li>
                    <strong>Cloudflare Inc.</strong> : hébergement sécurisé des photographies
                    d’équipements (Cloudflare R2) ;
                  </li>
                  <li>
                    <strong>Resend Inc.</strong> : acheminement des emails transactionnels et
                    notifications ;
                  </li>
                  <li>
                    <strong>Vercel Inc.</strong> : hébergement de l’application web.
                  </li>
                </ul>
              </li>
            </ul>
            <p>
              Aucune donnée personnelle n’est vendue, louée ou cédée à des tiers à des fins
              commerciales ou publicitaires.
            </p>
          </section>

          <section>
            <h2>5. Durée de conservation des données</h2>
            <p>
              Les données de compte restent actives tant que le compte utilisateur est ouvert. En
              cas d’inactivité prolongée de plus de 3 ans, les données sont anonymisées ou
              supprimées.
            </p>
            <p>
              Les données de réservation et de facturation sont conservées sous forme d’archives
              intermédiaires pendant les durées légales applicables (5 ans pour la responsabilité
              contractuelle, 10 ans pour les pièces comptables).
            </p>
          </section>

          <section>
            <h2>6. Vos droits et recours</h2>
            <p>
              Conformément à la réglementation européenne (RGPD) et à la loi Informatique et
              Libertés, vous disposez des droits suivants :
            </p>
            <ul>
              <li>Droit d’accès et d’information sur vos données ;</li>
              <li>Droit de rectification des informations inexactes ;</li>
              <li>
                Droit à l’effacement (« droit à l’oubli »), sous réserve des obligations légales de
                conservation ;
              </li>
              <li>Droit à la limitation du traitement et droit d’opposition ;</li>
              <li>Droit à la portabilité de vos données personnelles.</li>
            </ul>
            <p>
              Vous pouvez exercer ces droits en écrivant à{' '}
              <a href="mailto:privacy@uttily.com">privacy@uttily.com</a>. Si vous estimez que vos
              droits ne sont pas respectés, vous avez le droit d’introduire une réclamation auprès
              de la Commission Nationale de l’Informatique et des Libertés (CNIL).
            </p>
          </section>
        </>
      ) : (
        <>
          <section>
            <h2>1. Data Controller</h2>
            <p>
              The data controller responsible for personal data processing on the platform is{' '}
              <strong>Uttily SAS</strong>.
            </p>
            <p>
              For any inquiries regarding personal data processing or to exercise your rights, you
              may contact our Data Protection Officer at:{' '}
              <a href="mailto:privacy@uttily.com">privacy@uttily.com</a>.
            </p>
          </section>

          <section>
            <h2>2. Personal Data Collected</h2>
            <p>We collect only the data strictly necessary for our services, specifically:</p>
            <ul>
              <li>
                <strong>Identity and contact data:</strong> name, email address, and phone number
                (used for booking confirmation, on-site desk reception, and operational updates);
              </li>
              <li>
                <strong>Booking and rental history:</strong> rented equipment, dates, pickup
                locations, mutual condition reports, and gear photos;
              </li>
              <li>
                <strong>Technical connection data:</strong> IP addresses, access logs, and technical
                session identifiers (managed via Clerk).
              </li>
            </ul>
            <div className="callout">
              <p>
                <strong>Payment Security (Zero card storage):</strong> Uttily does not store or
                process full payment card details. All financial transactions are securely handled
                by our PCI-DSS Level 1 certified partner, <strong>Stripe</strong>.
              </p>
            </div>
          </section>

          <section>
            <h2>3. Purposes and Legal Bases</h2>
            <p>Your data is processed based on the following legal grounds:</p>
            <ul>
              <li>
                <strong>Performance of a contract (Art. 6.1.b GDPR):</strong> account management,
                physical equipment allocation, partner transmission, rental documentation, and desk
                operations;
              </li>
              <li>
                <strong>Compliance with legal obligations (Art. 6.1.c GDPR):</strong> accounting,
                billing, and transactional proof records;
              </li>
              <li>
                <strong>Legitimate interests (Art. 6.1.f GDPR):</strong> platform security, fraud
                prevention, and continuous service reliability.
              </li>
            </ul>
          </section>

          <section>
            <h2>4. Data Recipients and Processors</h2>
            <p>Your data is accessible exclusively to:</p>
            <ul>
              <li>
                <strong>The designated Partner rental shop</strong> where you collect your
                equipment, as strictly required to fulfill the rental agreement;
              </li>
              <li>
                <strong>Qualified technical subprocessors</strong> bound by strict GDPR data
                processing agreements:
                <ul>
                  <li>
                    <strong>Clerk Inc.</strong>: user authentication and session management;
                  </li>
                  <li>
                    <strong>Stripe Payments Europe Ltd</strong>: payment processing and escrow;
                  </li>
                  <li>
                    <strong>Neon Inc.</strong>: transactional PostgreSQL database hosting;
                  </li>
                  <li>
                    <strong>Cloudflare Inc.</strong>: secure equipment photo storage (Cloudflare
                    R2);
                  </li>
                  <li>
                    <strong>Resend Inc.</strong>: transactional email delivery;
                  </li>
                  <li>
                    <strong>Vercel Inc.</strong>: web application infrastructure.
                  </li>
                </ul>
              </li>
            </ul>
            <p>We do not sell, rent, or trade your personal data to third parties.</p>
          </section>

          <section>
            <h2>5. Retention Periods</h2>
            <p>
              Account data remains active as long as your account is maintained. Accounts inactive
              for more than 3 years are purged or anonymized.
            </p>
            <p>
              Transactional and billing records are archived in accordance with statutory retention
              requirements (5 years for contractual liability, 10 years for accounting records).
            </p>
          </section>

          <section>
            <h2>6. Your Rights</h2>
            <p>Under GDPR and applicable data protection regulations, you have the right to:</p>
            <ul>
              <li>Access and receive a copy of your personal data;</li>
              <li>Request rectification of inaccurate data;</li>
              <li>Request erasure of your data, subject to statutory retention obligations;</li>
              <li>Restrict or object to processing;</li>
              <li>Data portability.</li>
            </ul>
            <p>
              To exercise your rights, contact us at{' '}
              <a href="mailto:privacy@uttily.com">privacy@uttily.com</a>. You also have the right to
              lodge a complaint with the relevant data protection authority (CNIL in France).
            </p>
          </section>
        </>
      )}
    </LegalPageLayout>
  );
}
