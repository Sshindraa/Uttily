'use client';

import { useState } from 'react';
import { useClerk } from '@clerk/nextjs';
import type { PrivacyRequestSummary, PrivacyRequestType } from '@uttily/core';
import { Card, Badge, PageHeader, Icon } from '@uttily/ui';
import type { BadgeTone } from '@uttily/ui';
import { eraseMyAccountAction, submitPrivacyRequestAction } from '@/app/actions/privacy';
import styles from './privacy-view.module.css';

interface PrivacyViewProps {
  locale: string;
  requests: PrivacyRequestSummary[];
}

function DownloadIcon({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function ShieldIcon({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
    </svg>
  );
}

function ClockIcon({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function InfoIcon({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function AlertTriangleIcon({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  );
}

function TrashIcon({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      <line x1="10" y1="11" x2="10" y2="17" />
      <line x1="14" y1="11" x2="14" y2="17" />
    </svg>
  );
}

function getStatusBadge(status: string, fr: boolean): { label: string; tone: BadgeTone } {
  switch (status) {
    case 'RECEIVED':
      return { label: fr ? 'Reçue' : 'Received', tone: 'info' };
    case 'IDENTITY_CHECK_REQUIRED':
      return { label: fr ? 'Vérification requise' : 'Verification required', tone: 'warning' };
    case 'IN_REVIEW':
      return { label: fr ? 'En cours d’instruction' : 'Under review', tone: 'info' };
    case 'PARTIALLY_FULFILLED':
      return { label: fr ? 'Partiellement traitée' : 'Partially fulfilled', tone: 'warning' };
    case 'FULFILLED':
      return { label: fr ? 'Traitée' : 'Fulfilled', tone: 'success' };
    case 'REFUSED':
      return { label: fr ? 'Refusée' : 'Refused', tone: 'danger' };
    case 'CANCELLED':
      return { label: fr ? 'Annulée' : 'Cancelled', tone: 'neutral' };
    default:
      return { label: status, tone: 'neutral' };
  }
}

function getRequestTypeLabel(type: PrivacyRequestType, fr: boolean): string {
  switch (type) {
    case 'ACCESS':
      return fr ? 'Droit d’accès (Art. 15)' : 'Right of access (Art. 15)';
    case 'PORTABILITY':
      return fr ? 'Portabilité des données (Art. 20)' : 'Data portability (Art. 20)';
    case 'RECTIFICATION':
      return fr ? 'Rectification (Art. 16)' : 'Rectification (Art. 16)';
    case 'ERASURE':
      return fr ? 'Effacement / Oubli (Art. 17)' : 'Erasure / Right to be forgotten (Art. 17)';
    case 'OPPOSITION':
      return fr ? 'Opposition (Art. 21)' : 'Right to object (Art. 21)';
    case 'RESTRICTION':
      return fr ? 'Limitation du traitement (Art. 18)' : 'Restriction of processing (Art. 18)';
    default:
      return type;
  }
}

export function PrivacyView({ locale, requests }: PrivacyViewProps): React.ReactElement {
  const fr = locale === 'fr';
  const { signOut } = useClerk();

  const [requestType, setRequestType] = useState<PrivacyRequestType>('ACCESS');
  const [details, setDetails] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submissionSuccess, setSubmissionSuccess] = useState<string | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);

  // Self-service account erasure state (Art. 17 RGPD / Lot 21-P2)
  const [showErasureModal, setShowErasureModal] = useState(false);
  const [erasureConfirmInput, setErasureConfirmInput] = useState('');
  const [isErasing, setIsErasing] = useState(false);
  const [erasureError, setErasureError] = useState<string | null>(null);
  const [erasureResult, setErasureResult] = useState<{
    civilRetentionUntil: string;
    accountingRetentionUntil: string;
  } | null>(null);

  async function handleSignOutAfterErasure(): Promise<void> {
    try {
      await signOut({ redirectUrl: `/${locale}` });
    } catch {
      window.location.href = `/${locale}`;
    }
  }

  async function handleErasureSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    const expectedWord = fr ? 'SUPPRIMER' : 'DELETE';
    if (erasureConfirmInput.trim().toUpperCase() !== expectedWord) {
      setErasureError(
        fr
          ? `Veuillez saisir exactement « ${expectedWord} » pour confirmer.`
          : `Please type exactly "${expectedWord}" to confirm.`,
      );
      return;
    }

    setIsErasing(true);
    setErasureError(null);
    try {
      const res = await eraseMyAccountAction();
      if (res.ok) {
        setErasureResult({
          civilRetentionUntil: res.data.civilRetentionUntil,
          accountingRetentionUntil: res.data.accountingRetentionUntil,
        });
        setShowErasureModal(false);
      } else {
        setErasureError(res.message);
      }
    } catch {
      setErasureError(
        fr
          ? 'Une erreur inattendue est survenue lors de l’effacement.'
          : 'An unexpected error occurred during erasure.',
      );
    } finally {
      setIsErasing(false);
    }
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmissionError(null);
    setSubmissionSuccess(null);

    try {
      const res = await submitPrivacyRequestAction(requestType, details);
      if (res.ok) {
        setSubmissionSuccess(
          fr
            ? `Votre demande a été enregistrée avec succès (Réf. : ${res.data.requestId.slice(0, 8)}). Délai légal de réponse : 1 mois calendaire.`
            : `Your request has been successfully registered (Ref: ${res.data.requestId.slice(0, 8)}). Statutory response deadline: 1 calendar month.`,
        );
        setDetails('');
      } else {
        setSubmissionError(res.message);
      }
    } catch {
      setSubmissionError(
        fr ? 'Une erreur inattendue est survenue.' : 'An unexpected error occurred.',
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className={styles.container}>
      <PageHeader
        title={fr ? 'Confidentialité et données personnelles' : 'Privacy and personal data'}
        description={
          fr
            ? 'Gérez vos données personnelles, téléchargez une copie de vos informations et exercez vos droits RGPD en toute transparence.'
            : 'Manage your personal data, download an intelligible copy of your information and exercise your GDPR rights with full transparency.'
        }
      />

      <div className={styles.sections}>
        {/* Section 1 : Téléchargement et Portabilité */}
        <Card className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.iconCircle}>
              <DownloadIcon size={20} />
            </div>
            <div>
              <h2 className={styles.cardTitle}>
                {fr ? 'Télécharger vos données' : 'Download your data'}
              </h2>
              <p className={styles.cardSubtitle}>
                {fr
                  ? 'Obtenez une copie lisible ou structurée de vos données détenues par Uttily.'
                  : 'Obtain an intelligible or structured copy of your data held by Uttily.'}
              </p>
            </div>
          </div>

          <div className={styles.exportGrid}>
            <div className={styles.exportItem}>
              <h3>
                {fr
                  ? 'Copie intégrale (Droit d’accès · Art. 15)'
                  : 'Full copy (Right of access · Art. 15)'}
              </h3>
              <p>
                {fr
                  ? 'Fichier JSON complet comprenant votre profil, vos réservations, règlements, consentements contractuels et liens vers vos reçus.'
                  : 'Complete JSON file including your profile, bookings, payments, terms consent snapshots and receipts.'}
              </p>
              <a
                href="/api/account/privacy/export"
                download
                className={styles.buttonPrimary}
                id="btn-export-access"
              >
                <DownloadIcon size={16} />
                {fr ? 'Télécharger ma copie (Art. 15)' : 'Download my copy (Art. 15)'}
              </a>
            </div>

            <div className={styles.exportItem}>
              <h3>
                {fr
                  ? 'Données portables (Portabilité · Art. 20)'
                  : 'Portable dataset (Portability · Art. 20)'}
              </h3>
              <p>
                {fr
                  ? 'Format structuré machine-readable limité strictement aux données que vous avez fournies ou observées dans le cadre de vos contrats.'
                  : 'Structured machine-readable format strictly limited to data you provided or observed through your contracts.'}
              </p>
              <a
                href="/api/account/privacy/export?scope=portability"
                download
                className={styles.buttonSecondary}
                id="btn-export-portability"
              >
                <DownloadIcon size={16} />
                {fr ? 'Exporter mes données (Art. 20)' : 'Export portable data (Art. 20)'}
              </a>
            </div>
          </div>
        </Card>

        {/* Section 2 : Formulaire d'exercice de droits */}
        <Card className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.iconCircle}>
              <ShieldIcon size={20} />
            </div>
            <div>
              <h2 className={styles.cardTitle}>
                {fr ? 'Exercer vos droits RGPD' : 'Exercise your GDPR rights'}
              </h2>
              <p className={styles.cardSubtitle}>
                {fr
                  ? 'Déposez une demande formelle auprès de notre délégué à la protection des données.'
                  : 'Submit a formal request to our Data Protection Officer.'}
              </p>
            </div>
          </div>

          {submissionSuccess && (
            <div className={styles.alertSuccess} role="alert">
              <Icon name="check" size={18} />
              <span>{submissionSuccess}</span>
            </div>
          )}

          {submissionError && (
            <div className={styles.alertError} role="alert">
              <AlertTriangleIcon size={18} />
              <span>{submissionError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className={styles.form}>
            <div className={styles.formGroup}>
              <label htmlFor="privacy-request-type" className={styles.label}>
                {fr ? 'Nature de votre demande' : 'Request type'}
              </label>
              <select
                id="privacy-request-type"
                value={requestType}
                onChange={(e) => setRequestType(e.target.value as PrivacyRequestType)}
                className={styles.select}
              >
                <option value="ACCESS">
                  {fr ? 'Droit d’accès (Art. 15)' : 'Right of access (Art. 15)'}
                </option>
                <option value="PORTABILITY">
                  {fr ? 'Portabilité des données (Art. 20)' : 'Data portability (Art. 20)'}
                </option>
                <option value="RECTIFICATION">
                  {fr
                    ? 'Rectification d’informations (Art. 16)'
                    : 'Rectification of information (Art. 16)'}
                </option>
                <option value="ERASURE">
                  {fr
                    ? 'Effacement / Clôture de compte (Art. 17)'
                    : 'Erasure / Account closure (Art. 17)'}
                </option>
                <option value="OPPOSITION">
                  {fr
                    ? 'Opposition à un traitement (Art. 21)'
                    : 'Objection to processing (Art. 21)'}
                </option>
                <option value="RESTRICTION">
                  {fr
                    ? 'Limitation du traitement (Art. 18)'
                    : 'Restriction of processing (Art. 18)'}
                </option>
              </select>
            </div>

            <div className={styles.formGroup}>
              <label htmlFor="privacy-details" className={styles.label}>
                {fr
                  ? 'Détails ou précisions (optionnel)'
                  : 'Details or additional context (optional)'}
              </label>
              <textarea
                id="privacy-details"
                rows={4}
                value={details}
                onChange={(e) => setDetails(e.target.value)}
                placeholder={
                  fr
                    ? 'Précisez l’objet de votre démarche si nécessaire...'
                    : 'Provide any specific details regarding your request...'
                }
                className={styles.textarea}
              />
            </div>

            <div className={styles.noticeBox}>
              <p>
                <strong>
                  {fr ? 'Délai légal d’instruction :' : 'Statutory response timeframe:'}
                </strong>{' '}
                {fr
                  ? 'Votre demande sera traitée dans un délai maximum d’un mois calendaire à compter de sa réception. Une prolongation de deux mois peut être appliquée en cas de complexité particulière.'
                  : 'Your request will be handled within a maximum of one calendar month. A two-month extension may apply in cases of special complexity.'}
              </p>
              <p>
                <strong>{fr ? 'Vérification d’identité :' : 'Identity verification:'}</strong>{' '}
                {fr
                  ? 'Votre identité est présumée établie par votre compte authentifié. Un justificatif complémentaire ne sera exigé qu’en cas de doute raisonnable.'
                  : 'Your identity is established via your authenticated session. Additional proof will only be requested in cases of reasonable doubt.'}
              </p>
            </div>

            <button
              type="submit"
              disabled={isSubmitting}
              className={styles.buttonSubmit}
              id="btn-submit-privacy-request"
            >
              {isSubmitting
                ? fr
                  ? 'Envoi en cours...'
                  : 'Submitting...'
                : fr
                  ? 'Transmettre ma demande'
                  : 'Submit my request'}
            </button>
          </form>
        </Card>

        {/* Section 3 : Suivi des demandes existantes */}
        {requests.length > 0 && (
          <Card className={styles.card}>
            <div className={styles.cardHeader}>
              <div className={styles.iconCircle}>
                <ClockIcon size={20} />
              </div>
              <div>
                <h2 className={styles.cardTitle}>
                  {fr ? 'Historique de vos demandes' : 'Request history'}
                </h2>
                <p className={styles.cardSubtitle}>
                  {fr
                    ? 'Consultez l’état d’avancement de vos demandes d’exercice de droits.'
                    : 'Track the status and statutory deadlines of your submitted requests.'}
                </p>
              </div>
            </div>

            <div className={styles.tableWrapper}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>{fr ? 'Type' : 'Type'}</th>
                    <th>{fr ? 'Statut' : 'Status'}</th>
                    <th>{fr ? 'Déposée le' : 'Submitted on'}</th>
                    <th>{fr ? 'Échéance légale' : 'Due date'}</th>
                    <th>{fr ? 'Résolue le' : 'Resolved on'}</th>
                  </tr>
                </thead>
                <tbody>
                  {requests.map((req) => {
                    const badge = getStatusBadge(req.status, fr);
                    return (
                      <tr key={req.id}>
                        <td>
                          <strong>{getRequestTypeLabel(req.requestType, fr)}</strong>
                          <span className={styles.refCode}>{req.id.slice(0, 8)}</span>
                        </td>
                        <td>
                          <Badge tone={badge.tone}>{badge.label}</Badge>
                        </td>
                        <td>{new Date(req.receivedAt).toLocaleDateString(locale)}</td>
                        <td>{new Date(req.responseDueAt).toLocaleDateString(locale)}</td>
                        <td>
                          {req.resolvedAt
                            ? new Date(req.resolvedAt).toLocaleDateString(locale)
                            : '—'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )}

        {/* Section 4 : Transparence et contact DPO */}
        <Card className={styles.card}>
          <div className={styles.cardHeader}>
            <div className={styles.iconCircle}>
              <InfoIcon size={20} />
            </div>
            <div>
              <h2 className={styles.cardTitle}>
                {fr ? 'Transparence & Sous-traitants' : 'Transparency & Processors'}
              </h2>
              <p className={styles.cardSubtitle}>
                {fr
                  ? 'Informations sur l’architecture et le traitement de vos données.'
                  : 'Information regarding platform architecture and data processing.'}
              </p>
            </div>
          </div>

          <div className={styles.transparencyContent}>
            <p>
              {fr
                ? 'Uttily s’appuie sur des prestataires qualifiés pour assurer son service : Clerk (authentification), Stripe (paiement sécurisé), Neon (base de données), Cloudflare (stockage sécurisé), Resend (emails transactionnels) et Vercel (infrastructure).'
                : 'Uttily relies on qualified service providers to operate: Clerk (authentication), Stripe (secure payments), Neon (database), Cloudflare (secure storage), Resend (transactional emails) and Vercel (infrastructure).'}
            </p>
            <p>
              {fr
                ? 'Les garanties contractuelles, localisations et accords de traitement (DPA) sont en cours de revue et consolidation par notre DPO. Les mesures d’analyse de production sont maintenues désactivées par défaut.'
                : 'Contractual guarantees, regions and Data Processing Agreements (DPAs) are under continuous review by our DPO. Production analytics remain disabled by default.'}
            </p>
            <p>
              {fr
                ? 'Pour toute question relative à vos données, contactez notre DPO à :'
                : 'For inquiries regarding your personal data, contact our DPO at:'}{' '}
              <a href="mailto:privacy@uttily.com" className={styles.link}>
                privacy@uttily.com
              </a>
              {' · '}
              <a href={`/${locale}/privacy`} className={styles.link}>
                {fr ? 'Lire notre Politique de confidentialité' : 'Read our Privacy Policy'}
              </a>
            </p>
          </div>
        </Card>

        {/* Section 5 : Zone de danger - Effacement autonome du compte (Art. 17 RGPD) */}
        <div className={styles.dangerCard} id="section-danger-erasure">
          <div className={styles.dangerCardHeader}>
            <div className={styles.dangerIconCircle}>
              <TrashIcon size={20} />
            </div>
            <div>
              <h2 className={styles.dangerCardTitle}>
                {fr ? 'Zone de danger · Suppression définitive du compte' : 'Danger Zone · Permanent Account Deletion'}
              </h2>
              <p className={styles.dangerCardSubtitle}>
                {fr
                  ? 'Exercez votre droit à l’effacement (Art. 17 RGPD) avec purge d’identité et scellement probatoire.'
                  : 'Exercise your right to erasure (Art. 17 GDPR) with identity purge and evidentiary seal.'}
              </p>
            </div>
          </div>

          {erasureResult ? (
            <div className={styles.sealedSuccessBox}>
              <h3 className={styles.sealedSuccessTitle}>
                {fr ? '✓ Votre compte a été effacé et scellé avec succès' : '✓ Your account has been successfully erased and sealed'}
              </h3>
              <p>
                {fr
                  ? 'Vos identifiants personnels directs ont été détruits dans notre base de données et votre session Clerk a été révoquée. Conformément aux arbitrages DPO (DPO-003 & DPO-004), les données relatives à vos transactions passées sont placées sous scellé probatoire et ne sont plus exploitables commercialement :'
                  : 'Your direct personal identifiers have been destroyed in our database and your Clerk session has been revoked. In accordance with DPO arbitrations (DPO-003 & DPO-004), past transactional data has been placed under evidentiary seal:'}
              </p>
              <ul className={styles.sealedDatesList}>
                <li>
                  <strong>
                    {fr
                      ? 'Responsabilité civile contractuelle (Art. 2224 Code civil) :'
                      : 'Contractual civil liability (Art. 2224 Civil Code):'}
                  </strong>{' '}
                  {fr ? 'Archives probatoires scellées jusqu’au ' : 'Evidentiary seal active until '}
                  {new Date(erasureResult.civilRetentionUntil).toLocaleDateString(locale)} (5{' '}
                  {fr ? 'ans' : 'years'}).
                </li>
                <li>
                  <strong>
                    {fr
                      ? 'Obligation comptable et fiscale (Art. L. 123-22 Code de commerce) :'
                      : 'Accounting & tax obligation (Art. L. 123-22 Commercial Code):'}
                  </strong>{' '}
                  {fr ? 'Conservation scellée jusqu’au ' : 'Sealed retention until '}
                  {new Date(erasureResult.accountingRetentionUntil).toLocaleDateString(locale)} (10{' '}
                  {fr ? 'ans' : 'years'}).
                </li>
              </ul>
              <div>
                <button
                  type="button"
                  className={styles.buttonPrimary}
                  onClick={handleSignOutAfterErasure}
                  id="btn-signout-after-erasure"
                >
                  {fr ? 'Terminer et quitter' : 'Finish and leave'}
                </button>
              </div>
            </div>
          ) : (
            <div className={styles.dangerContent}>
              <p>
                {fr
                  ? 'La suppression de votre compte est irréversible. Dès validation, votre adresse email, votre nom et vos identifiants d’authentification sont immédiatement détruits dans notre base de données et auprès de notre fournisseur d’identité Clerk.'
                  : 'Deleting your account is irreversible. Upon confirmation, your email address, name, and authentication credentials will be immediately destroyed in our database and with Clerk.'}
              </p>

              <div className={styles.dangerNotice}>
                <p>
                  <strong>
                    {fr
                      ? 'Garanties légales probatoires (DPO-003 / DPO-004) :'
                      : 'Statutory evidentiary safeguards (DPO-003 / DPO-004):'}
                  </strong>
                </p>
                <p>
                  {fr
                    ? 'Conformément à l’Art. 17.3.b et e du RGPD, vos contrats de location exécutés et factures émises sont conservés sous scellé probatoire sécurisé pendant 5 ans (responsabilité civile) et 10 ans (obligation légale comptable). Ces données sont strictement séquestrées et inaccessibles aux opérations courantes.'
                    : 'Pursuant to Art. 17.3.b and e of GDPR, completed contracts and issued invoices are retained in a secure evidentiary vault for 5 years (civil liability) and 10 years (accounting obligations). These records are quarantined and inaccessible for normal operations.'}
                </p>
                <p>
                  <strong>{fr ? 'Conditions préalables :' : 'Prerequisites:'}</strong>{' '}
                  {fr
                    ? 'Vous ne devez avoir aucune réservation en cours (active ou confirmée à venir), ni être l’unique propriétaire d’une organisation possédant des équipements actifs.'
                    : 'You must have no ongoing or upcoming confirmed bookings, and you must not be the sole owner of an organisation with active equipment.'}
                </p>
              </div>

              {erasureError && !showErasureModal && (
                <div className={styles.alertError} role="alert">
                  <AlertTriangleIcon size={18} />
                  <span>{erasureError}</span>
                </div>
              )}

              <button
                type="button"
                className={styles.buttonDanger}
                onClick={() => {
                  setErasureError(null);
                  setErasureConfirmInput('');
                  setShowErasureModal(true);
                }}
                id="btn-open-erasure-modal"
              >
                <TrashIcon size={16} />
                {fr ? 'Supprimer définitivement mon compte (Art. 17)' : 'Permanently delete my account (Art. 17)'}
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Modal de confirmation d'effacement */}
      {showErasureModal && (
        <div
          className={styles.modalOverlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="erasure-modal-title"
        >
          <div className={styles.modalContent}>
            <h3 id="erasure-modal-title" className={styles.modalTitle}>
              {fr ? 'Confirmer la suppression irréversible' : 'Confirm Permanent Erasure'}
            </h3>
            <p className={styles.modalDescription}>
              {fr
                ? 'Cette action est définitive. Votre profil et vos accès seront immédiatement détruits. Pour confirmer, veuillez saisir « SUPPRIMER » ci-dessous :'
                : 'This action is final. Your profile and access will be immediately destroyed. To confirm, please type "DELETE" below:'}
            </p>

            {erasureError && (
              <div className={styles.alertError} role="alert">
                <AlertTriangleIcon size={18} />
                <span>{erasureError}</span>
              </div>
            )}

            <form onSubmit={handleErasureSubmit} className={styles.form}>
              <div className={styles.confirmInputGroup}>
                <label htmlFor="input-confirm-erasure">
                  {fr ? 'Mot de confirmation :' : 'Confirmation word:'}
                </label>
                <input
                  id="input-confirm-erasure"
                  type="text"
                  value={erasureConfirmInput}
                  onChange={(e) => setErasureConfirmInput(e.target.value)}
                  placeholder={fr ? 'SUPPRIMER' : 'DELETE'}
                  className={styles.select}
                  autoFocus
                  required
                />
              </div>

              <div className={styles.modalActions}>
                <button
                  type="button"
                  className={styles.buttonSecondary}
                  onClick={() => setShowErasureModal(false)}
                  disabled={isErasing}
                >
                  {fr ? 'Annuler' : 'Cancel'}
                </button>
                <button
                  type="submit"
                  className={styles.buttonDanger}
                  disabled={
                    isErasing ||
                    erasureConfirmInput.trim().toUpperCase() !== (fr ? 'SUPPRIMER' : 'DELETE')
                  }
                  id="btn-confirm-account-erasure"
                >
                  {isErasing
                    ? fr
                      ? 'Suppression...'
                      : 'Deleting...'
                    : fr
                      ? 'Confirmer la suppression'
                      : 'Confirm deletion'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
