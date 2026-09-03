import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalPageLayout } from '@/features/legal';
import type { AppLocale } from '@/lib/locale';

interface ProTermsPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: ProTermsPageProps): Promise<Metadata> {
  const { locale } = await params;
  const fr = locale === 'fr';
  return {
    title: fr
      ? 'Conditions Générales Partenaires (Conditions Pro) · Uttily'
      : 'Partner Terms and Conditions (Pro) · Uttily',
    description: fr
      ? 'Contrat de distribution et conditions générales applicables aux loueurs professionnels partenaires de la plateforme Uttily.'
      : 'Marketplace distribution agreement and terms applicable to professional rental operators partnering with Uttily.',
  };
}

export default async function ProTermsPage({
  params,
}: ProTermsPageProps): Promise<React.ReactElement> {
  const { locale: rawLocale } = await params;
  if (rawLocale !== 'fr' && rawLocale !== 'en') notFound();
  const locale: AppLocale = rawLocale;
  const fr = locale === 'fr';

  return (
    <LegalPageLayout
      locale={locale}
      slug="pro-terms"
      title={
        fr
          ? 'Conditions Générales Partenaires (Contrat Loueur Pro)'
          : 'Partner Terms and Conditions (Pro Rental Agreement)'
      }
      effectiveDate={fr ? '1er septembre 2026' : 'September 1, 2026'}
      version="v1"
    >
      {fr ? (
        <>
          <section>
            <h2>1. Objet du contrat cadre et rôle d’Uttily</h2>
            <p>
              Les présentes Conditions Générales Partenaires (ci-après les «{' '}
              <strong>Conditions Pro</strong> ») régissent les relations contractuelles entre la
              société <strong>Uttily SAS</strong> (« <strong>Uttily</strong> ») et tout loueur
              professionnel indépendant immatriculé (le « <strong>Loueur</strong> » ou le «{' '}
              <strong>Partenaire</strong> ») ouvrant un compte organisation sur la plateforme.
            </p>
            <p>
              Uttily met à disposition du Partenaire une suite logicielle opérationnelle (gestion de
              flotte, gestion des établissements, cockpit de comptoir, tarification dynamique) et
              assure la distribution en ligne de ses offres de location auprès des clients finaux.
            </p>
            <div className="callout">
              <p>
                <strong>Intermédiation technique :</strong> Le contrat de location d’équipement est
                conclu directement entre le Loueur et le client locataire. Uttily agit exclusivement
                en qualité d’intermédiaire technique et d’opérateur de plateforme en ligne.
              </p>
            </div>
          </section>

          <section>
            <h2>2. Qualité de professionnel et éligibilité</h2>
            <p>Pour être éligible et maintenir son compte actif, le Loueur déclare et garantit :</p>
            <ul>
              <li>
                Être légalement constitué et immatriculé au Registre du Commerce et des Sociétés
                (RCS) ou au registre professionnel équivalent de son pays d’établissement ;
              </li>
              <li>
                Fournir une dénomination sociale, un numéro SIREN/SIRET et des coordonnées fiscales
                exacts et vérifiables ;
              </li>
              <li>
                <strong>Assurance Responsabilité Civile Professionnelle :</strong> détenir une
                police d’assurance RC Pro en cours de validité garantissant les dommages corporels,
                matériels et immatériels liés à la mise à disposition de matériel outdoor ;
              </li>
              <li>
                Disposer d’un compte bancaire professionnel relié à la solution de paiement Stripe
                Connect de la plateforme.
              </li>
            </ul>
          </section>

          <section>
            <h2>3. Obligations d’exploitation et gestion de flotte</h2>
            <p>Le Loueur s’engage rigoureusement à :</p>
            <ul>
              <li>
                <strong>Conformité et sécurité :</strong> Ne proposer à la location que des
                équipements en parfait état de fonctionnement, entretenus selon les préconisations
                du fabricant et classés dans un état physique conforme (`NEW`, `GOOD`, `FAIR`) ;
              </li>
              <li>
                <strong>Fermeté des réservations :</strong> Toute réservation confirmée sur la
                plateforme engage fermement le Loueur. Il lui est interdit d’annuler arbitrairement
                une réservation sans motif légitime de sécurité ;
              </li>
              <li>
                <strong>Obligation de substitution :</strong> En cas d’avarie ou d’indisponibilité
                technique fortuite sur un exemplaire alloué, le Loueur s’engage à fournir
                immédiatement au comptoir un exemplaire équivalent de même variante et de qualité
                égale ou supérieure, sans surcoût pour le client ;
              </li>
              <li>
                <strong>Handovers et constats contradictoires :</strong> Réaliser systématiquement
                les constats contradictoires d’état au départ (`PICKUP`) et au retour (`RETURN`) via
                l’interface comptoir de la plateforme.
              </li>
            </ul>
          </section>

          <section>
            <h2>4. Modèle financier, commission et reversement (Split 13/7)</h2>
            <p>
              Le modèle économique de la plateforme est transparent et fondé sur la règle de split
              13/7 (conforme à l’ADR-029) :
            </p>
            <ul>
              <li>
                <strong>Commission marketplace Uttily :</strong> Uttily perçoit une commission de{' '}
                <strong>13 % HT</strong> calculée sur le montant de base de la location (hors
                options additionnelles et suppléments éventuels) ;
              </li>
              <li>
                <strong>Frais de service client :</strong> Un montant de 7 % TTC est facturé au
                locataire en sus du prix de location de base ;
              </li>
              <li>
                <strong>Encaissement et séquestre :</strong> Les paiements sont sécurisés par Stripe
                Connect. Le montant net revenant au Loueur (87 % de la base de location) est
                transféré sur son solde Stripe et reversé selon son calendrier de virements
                bancaires habituel.
              </li>
            </ul>
          </section>

          <section>
            <h2>5. Dépôts de garantie, avaries et non-restitution</h2>
            <p>
              <strong>Cautions physiques :</strong> La fixation, l’encaissement éventuel et la
              restitution de cautions restent sous la responsabilité exclusive du Loueur au moment
              de la remise du matériel.
            </p>
            <p>
              <strong>Matériel dégradé (`BROKEN`) et Perte/Vol (`LOST`) :</strong> En cas de dommage
              anormal ou de retard critique caractérisant une non-restitution, le Loueur instruit le
              dossier dans le cockpit opérationnel avec constat contradictoire et pièces
              justificatives, pour mise en œuvre de sa caution ou recours direct contre le
              locataire.
            </p>
          </section>

          <section>
            <h2>6. Données personnelles et secret professionnel</h2>
            <p>
              Dans le cadre de l’accueil au comptoir, le Loueur a accès aux données de contact du
              locataire (nom, prénom, email, téléphone) strictement nécessaires à la bonne exécution
              du contrat de location.
            </p>
            <p>
              Le Loueur s’interdit formellement de réutiliser ces données à des fins de prospection
              commerciale non sollicitée ou de les transmettre à des tiers, conformément au RGPD.
            </p>
          </section>

          <section>
            <h2>7. Durée, résiliation et litiges</h2>
            <p>
              Les présentes Conditions Pro entrent en vigueur dès leur acceptation lors de la
              création de l’espace organisation du Loueur. Elles sont conclues pour une durée
              indéterminée.
            </p>
            <p>
              Chaque partie peut résilier le contrat sous préavis écrit de 30 jours, sous réserve de
              la bonne exécution des réservations déjà confirmées. En cas de manquement grave
              (matériel dangereux, annulations récurrentes, fraude), Uttily se réserve le droit de
              suspendre l’accès au compte sans préavis.
            </p>
            <p>
              Le présent contrat est soumis au droit français. Tout litige relèvera de la compétence
              exclusive des tribunaux de commerce du ressort de la Cour d’appel de Paris.
            </p>
          </section>
        </>
      ) : (
        <>
          <section>
            <h2>1. Purpose of Agreement and Role of Uttily</h2>
            <p>
              These Partner Terms and Conditions (the “<strong>Pro Terms</strong>”) govern the
              contractual relationship between <strong>Uttily SAS</strong> (“<strong>Uttily</strong>
              ”) and any registered professional rental business (the “<strong>Partner</strong>” or
              “<strong>Rental Operator</strong>”) creating an organization on the platform.
            </p>
            <p>
              Uttily provides the Partner with an integrated operational software suite (fleet
              management, multi-location administration, counter desk cockpit, dynamic pricing) and
              online distribution to end-customers.
            </p>
            <div className="callout">
              <p>
                <strong>Technical Intermediary:</strong> The rental agreement is formed directly
                between the Partner and the customer. Uttily acts solely as an online platform
                operator and technical intermediary.
              </p>
            </div>
          </section>

          <section>
            <h2>2. Professional Status and Eligibility</h2>
            <p>
              To qualify and maintain an active account, the Partner represents and warrants that
              it:
            </p>
            <ul>
              <li>
                Is formally incorporated and registered in the commercial register of its home
                jurisdiction;
              </li>
              <li>
                Provides accurate and verifiable legal name, corporate ID, and tax credentials;
              </li>
              <li>
                <strong>Professional Liability Insurance:</strong> Holds a valid commercial
                liability insurance policy covering property damage, bodily injury, and liability
                arising from outdoor equipment rental;
              </li>
              <li>Maintains a verified professional bank account connected via Stripe Connect.</li>
            </ul>
          </section>

          <section>
            <h2>3. Operational Obligations and Fleet Standards</h2>
            <p>The Partner strictly commits to:</p>
            <ul>
              <li>
                <strong>Compliance and Safety:</strong> Listing exclusively equipment in proper
                working order, maintained according to manufacturer specifications and graded
                accurately (`NEW`, `GOOD`, `FAIR`);
              </li>
              <li>
                <strong>Booking Commitment:</strong> Confirmed reservations are strictly binding.
                The Partner shall not arbitrarily cancel confirmed bookings without genuine safety
                grounds;
              </li>
              <li>
                <strong>Mandatory Substitution:</strong> In the event of unexpected mechanical
                failure on an allocated item, the Partner shall immediately provide an equivalent
                replacement item of identical variant and equal or superior grade at no added
                customer charge;
              </li>
              <li>
                <strong>Digital Handovers:</strong> Systematically performing digital check-in
                (`PICKUP`) and check-out (`RETURN`) condition reports using the counter interface.
              </li>
            </ul>
          </section>

          <section>
            <h2>4. Financial Model, Commissions, and Payouts (13/7 Split)</h2>
            <p>
              The platform fee structure is transparent and governed by the 13/7 marketplace split
              rule (ADR-029):
            </p>
            <ul>
              <li>
                <strong>Uttily Marketplace Commission:</strong> Uttily charges a commission of{' '}
                <strong>13% excl. VAT</strong> calculated on the base rental amount;
              </li>
              <li>
                <strong>Customer Service Fee:</strong> A 7% fee (incl. VAT) is paid directly by the
                customer;
              </li>
              <li>
                <strong>Payment and Payouts:</strong> Payments are secured via Stripe Connect. Net
                proceeds due to the Partner (87% of base rental) are transferred to the Partner’s
                connected balance and paid out per standard banking payout schedules.
              </li>
            </ul>
          </section>

          <section>
            <h2>5. Security Deposits, Damages, and Loss</h2>
            <p>
              <strong>Security Deposits:</strong> Determining, collecting, and releasing security
              deposits remains under the Partner’s sole authority at the pickup desk.
            </p>
            <p>
              <strong>Damaged Gear (`BROKEN`) and Loss (`LOST`):</strong> In case of severe damage
              or unreturned gear, the Partner documents the case in the operational cockpit with
              condition reports to exercise deposit deductions or formal recovery procedures.
            </p>
          </section>

          <section>
            <h2>6. Data Protection and Confidentiality</h2>
            <p>
              The Partner accesses customer contact details solely to execute the rental service.
              The Partner is strictly prohibited from using customer data for unsolicited direct
              marketing or disclosing it to third parties.
            </p>
          </section>

          <section>
            <h2>7. Term, Termination, and Governing Law</h2>
            <p>
              These Pro Terms take effect upon acceptance during organization onboarding and
              continue for an indefinite term. Either party may terminate with 30 days’ written
              notice, subject to fulfilling already confirmed bookings.
            </p>
            <p>
              These Pro Terms are governed by French law. Commercial disputes shall be subject to
              the exclusive jurisdiction of the Commercial Courts of Paris, France.
            </p>
          </section>
        </>
      )}
    </LegalPageLayout>
  );
}
