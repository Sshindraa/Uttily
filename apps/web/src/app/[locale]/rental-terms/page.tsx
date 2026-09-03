import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LegalPageLayout } from '@/features/legal';
import type { AppLocale } from '@/lib/locale';

interface RentalTermsPageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: RentalTermsPageProps): Promise<Metadata> {
  const { locale } = await params;
  const fr = locale === 'fr';
  return {
    title: fr
      ? 'Conditions Générales de Location (CGL) · Uttily'
      : 'Rental Terms and Conditions · Uttily',
    description: fr
      ? 'Conditions contractuelles régissant la réservation et la location d’équipements outdoor auprès des loueurs partenaires.'
      : 'Contractual terms governing booking and rental of outdoor equipment with partner rental operators.',
  };
}

export default async function RentalTermsPage({
  params,
}: RentalTermsPageProps): Promise<React.ReactElement> {
  const { locale: rawLocale } = await params;
  if (rawLocale !== 'fr' && rawLocale !== 'en') notFound();
  const locale: AppLocale = rawLocale;
  const fr = locale === 'fr';

  return (
    <LegalPageLayout
      locale={locale}
      slug="rental-terms"
      title={
        fr
          ? 'Conditions Générales de Location d’Équipements'
          : 'Equipment Rental Terms and Conditions'
      }
      effectiveDate={fr ? '1er septembre 2026' : 'September 1, 2026'}
      version="v1"
    >
      {fr ? (
        <>
          <section>
            <h2>1. Objet et formation du contrat de location</h2>
            <p>
              Les présentes Conditions Générales de Location (ci-après les « <strong>CGL</strong> »)
              régissent la relation contractuelle directe conclue entre le client locataire (le «{' '}
              <strong>Locataire</strong> ») et le loueur professionnel indépendant (le «{' '}
              <strong>Loueur</strong> ») pour toute réservation effectuée par l’intermédiaire de la
              plateforme Uttily.
            </p>
            <p>
              En confirmant sa réservation et en procédant au paiement, le Locataire accepte sans
              réserve les présentes CGL ainsi que les conditions particulières fixées par le Loueur
              (tarifs, horaires d’ouverture et politique d’annulation applicable).
            </p>
          </section>

          <section>
            <h2>2. Prix, frais de service et modalités de paiement</h2>
            <p>
              Le montant total facturé au Locataire est exprimé en euros TTC et comprend de manière
              transparente :
            </p>
            <ul>
              <li>
                <strong>Le prix de location de base</strong> fixé par le Loueur pour les équipements
                et la période demandés ;
              </li>
              <li>
                <strong>Les frais de service client Uttily</strong> (7 % TTC de la base de
                location), rémunérant le fonctionnement de la plateforme technique, l’assistance et
                la sécurisation des transactions (modèle de split 13/7 conforme à l’ADR-029).
              </li>
            </ul>
            <p>
              Le paiement est opéré de manière sécurisée par carte bancaire au moyen de la solution
              de paiement Stripe Connect. Les fonds sont encaissés sous séquestre transactionnel
              jusqu’à la confirmation ferme de la réservation.
            </p>
          </section>

          <section>
            <h2>3. Retrait de l’équipement (Check-in / Pickup)</h2>
            <p>
              Le Locataire se présente à l’établissement du Loueur aux dates et heures convenues,
              muni d’une pièce d’identité en cours de validité et de la confirmation de réservation.
            </p>
            <p>
              Un <strong>constat d’état contradictoire de départ</strong> est établi au moment de la
              remise de l’équipement. L’état du matériel (`NEW`, `GOOD`, `FAIR`) et les éventuelles
              observations sont enregistrés numériquement. La prise en possession de l’équipement
              vaut reconnaissance de sa conformité.
            </p>
            <div className="callout">
              <p>
                <strong>Substitution d’urgence :</strong> Si l’exemplaire initialement alloué
                présente une défaillance fortuite lors de la préparation, le Loueur est expressément
                autorisé à substituer un exemplaire équivalent de même variante et de condition
                égale ou supérieure, sans frais additionnel pour le Locataire.
              </p>
            </div>
          </section>

          <section>
            <h2>4. Restitution, retards et dégradations (Check-out / Return)</h2>
            <p>
              L’équipement doit être restitué au point de retrait initial au plus tard à l’heure de
              fin stipulée dans la réservation. Un constat d’état de retour est dressé
              contradictoirement.
            </p>
            <ul>
              <li>
                <strong>Retards :</strong> Tout dépassement horaire non autorisé perturbe le
                planning d’autres usagers. Le Loueur se réserve le droit de facturer les heures ou
                journées supplémentaires entamées au tarif en vigueur.
              </li>
              <li>
                <strong>Dommages et réparations :</strong> Si l’équipement est restitué avec des
                dégradations anormales (`BROKEN`) nécessitant une immobilisation en maintenance, les
                frais de remise en état ou de remplacement des pièces sont à la charge du Locataire.
              </li>
              <li>
                <strong>Non-restitution et perte (`LOST`) :</strong> À défaut de restitution dans un
                délai raisonnable et sans justificatif légitime, l’équipement sera déclaré perdu ou
                volé, ouvrant droit à l’encaissement de la caution et à l’engagement de poursuites.
              </li>
            </ul>
          </section>

          <section>
            <h2>5. Non-présentation (No-Show)</h2>
            <p>
              Si le Locataire ne se présente pas au point de retrait pendant le créneau prévu sans
              avoir valablement notifié son annulation, le Loueur peut constater la non-présentation
              (<em>No-Show</em>).
            </p>
            <p>
              Dans ce cas, le matériel réservé est immédiatement libéré pour être remis à la
              disposition d’autres usagers. La réservation est clôturée sans que le Locataire ne
              puisse prétendre à un quelconque remboursement du montant déjà réglé.
            </p>
          </section>

          <section>
            <h2>6. Politiques d’annulation et remboursements</h2>
            <p>
              Chaque fiche d’équipement mentionne la politique d’annulation choisie par le Loueur
              parmi les trois barèmes officiels de la plateforme :
            </p>
            <ul>
              <li>
                <strong>FLEXIBLE :</strong> Remboursement intégral (100 %) jusqu’à 24 heures avant
                le début de la location ; aucun remboursement sous 24 heures.
              </li>
              <li>
                <strong>MODERATE :</strong> Remboursement intégral (100 %) jusqu’à 5 jours avant le
                début ; remboursement à 50 % entre 5 jours et 24 heures avant ; aucun remboursement
                sous 24 heures.
              </li>
              <li>
                <strong>FIRM :</strong> Remboursement intégral (100 %) jusqu’à 14 jours avant le
                début ; remboursement à 50 % entre 14 jours et 7 jours avant ; aucun remboursement
                sous 7 jours.
              </li>
            </ul>
            <div className="callout">
              <p>
                <strong>Droit de grâce 24h :</strong> Pour toute réservation effectuée au moins 7
                jours à l’avance, le Locataire bénéficie d’un droit d’annulation avec remboursement
                à 100 % s’il annule dans les 24 heures suivant la confirmation de son paiement.
              </p>
            </div>
          </section>

          <section>
            <h2>7. Cautions et dépôts de garantie</h2>
            <p>
              Le Loueur peut exiger la constitution d’un dépôt de garantie (caution) au moment du
              retrait du matériel (empreinte de carte bancaire, chèque ou caution en ligne selon ses
              modalités déclarées). Cette caution n’est pas débitée par Uttily lors de la
              réservation en ligne et reste gérée sous la responsabilité directe du Loueur.
            </p>
          </section>

          <section>
            <h2>8. Droit applicable et réclamations</h2>
            <p>
              Les présentes CGL sont soumises au droit français. En cas de différend entre le
              Locataire et le Loueur, les parties s’engagent à rechercher en priorité un règlement
              amiable avec le concours du service support d’Uttily.
            </p>
          </section>
        </>
      ) : (
        <>
          <section>
            <h2>1. Purpose and Formation of the Rental Agreement</h2>
            <p>
              These Rental Terms and Conditions (the “<strong>Rental Terms</strong>”) govern the
              direct contractual relationship between the customer renting equipment (the “
              <strong>Renter</strong>”) and the independent professional rental operator (the “
              <strong>Partner</strong>”) for any booking completed via the Uttily platform.
            </p>
            <p>
              By completing a booking and proceeding to checkout, the Renter unreservedly accepts
              these Rental Terms and the specific operational policies set by the Partner (pricing,
              location hours, and cancellation rules).
            </p>
          </section>

          <section>
            <h2>2. Pricing, Service Fees, and Payment Terms</h2>
            <p>
              The total price charged to the Renter is denominated in Euros (inclusive of VAT) and
              includes:
            </p>
            <ul>
              <li>
                <strong>The base rental rate</strong> set by the Partner for the selected equipment
                and period;
              </li>
              <li>
                <strong>The Uttily customer service fee</strong> (7% inclusive of VAT on the rental
                base), funding platform operations, support, and secure payments (under the 13/7 fee
                split model per ADR-029).
              </li>
            </ul>
            <p>
              Payments are processed securely via Stripe Connect. Funds remain escrowed pending firm
              booking confirmation.
            </p>
          </section>

          <section>
            <h2>3. Equipment Pickup (Check-in)</h2>
            <p>
              The Renter must report to the Partner’s designated location at the agreed schedule,
              presenting a valid government ID and booking confirmation.
            </p>
            <p>
              A <strong>mutual pickup condition report</strong> is established digitally upon
              handover. Equipment physical condition (`NEW`, `GOOD`, `FAIR`) and any pre-existing
              markings are recorded. Taking delivery confirms initial gear compliance.
            </p>
            <div className="callout">
              <p>
                <strong>Emergency Substitution:</strong> If an allocated item exhibits an unexpected
                mechanical defect prior to handover, the Partner is entitled to substitute an
                equivalent item of identical variant and equal or superior condition at no added
                charge.
              </p>
            </div>
          </section>

          <section>
            <h2>4. Equipment Return, Delays, and Damage (Check-out)</h2>
            <p>
              Equipment must be returned to the pickup location no later than the agreed return
              time. A return condition report is performed upon check-in.
            </p>
            <ul>
              <li>
                <strong>Overdue returns:</strong> Unauthorized return delays impact subsequent
                renters. The Partner reserves the right to bill extra hours or days at standard
                retail rates.
              </li>
              <li>
                <strong>Damage and repairs:</strong> If equipment is returned in damaged condition (
                `BROKEN`) requiring repair or parts replacement, the Renter is liable for the cost
                of remediation.
              </li>
              <li>
                <strong>Unreturned or lost gear (`LOST`):</strong> Unreturned equipment after
                reasonable notice will be declared lost or stolen, entitling the Partner to seize
                the security deposit and pursue recovery remedies.
              </li>
            </ul>
          </section>

          <section>
            <h2>5. No-Show Policy</h2>
            <p>
              If the Renter fails to pick up the equipment during the reserved window without prior
              cancellation, the Partner may record a <em>No-Show</em>.
            </p>
            <p>
              The equipment is immediately released for other users, and the booking is closed
              without any entitlement to a refund.
            </p>
          </section>

          <section>
            <h2>6. Cancellation and Refund Policies</h2>
            <p>
              Each equipment listing specifies one of three platform standard cancellation policies:
            </p>
            <ul>
              <li>
                <strong>FLEXIBLE:</strong> Full refund (100%) up to 24 hours prior to pickup; no
                refund under 24 hours.
              </li>
              <li>
                <strong>MODERATE:</strong> Full refund (100%) up to 5 days prior to pickup; 50%
                refund between 5 days and 24 hours prior; no refund under 24 hours.
              </li>
              <li>
                <strong>FIRM:</strong> Full refund (100%) up to 14 days prior to pickup; 50% refund
                between 14 days and 7 days prior; no refund under 7 days.
              </li>
            </ul>
            <div className="callout">
              <p>
                <strong>24-Hour Grace Period:</strong> For bookings made at least 7 days in advance,
                the Renter is entitled to cancel with a 100% refund within the first 24 hours
                following booking confirmation.
              </p>
            </div>
          </section>

          <section>
            <h2>7. Security Deposits</h2>
            <p>
              Partners may require a security deposit upon pickup (credit card hold, check, or
              online deposit per their shop policy). Deposits are not collected by Uttily online and
              remain under the Partner’s direct oversight.
            </p>
          </section>

          <section>
            <h2>8. Applicable Law and Disputes</h2>
            <p>
              These Rental Terms are governed by French law. In case of dispute, the parties agree
              to seek an amicable resolution with the assistance of Uttily customer support.
            </p>
          </section>
        </>
      )}
    </LegalPageLayout>
  );
}
