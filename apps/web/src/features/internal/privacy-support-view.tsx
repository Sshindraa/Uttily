'use client';

import { useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type {
  ListPrivacyRequestsFilters,
  ListPrivacyRequestsResult,
  SupportPrivacyRequestItem,
} from '@uttily/core';
import {
  extendPrivacyDeadlineAction,
  flagPrivacyIdentityCheckAction,
  recordExtensionNotificationAction,
  recordPrivacyResponseNotificationAction,
  resolvePrivacyRequestAction,
  startPrivacyReviewAction,
} from '@/app/actions/support-privacy';
import styles from './privacy-support.module.css';

const REQUEST_TYPE_LABELS: Record<string, string> = {
  ACCESS: 'Accès (Art. 15)',
  PORTABILITY: 'Portabilité (Art. 20)',
  RECTIFICATION: 'Rectification (Art. 16)',
  ERASURE: 'Effacement (Art. 17)',
  OPPOSITION: 'Opposition (Art. 21)',
  RESTRICTION: 'Limitation (Art. 18)',
};

const STATUS_LABELS: Record<string, { label: string; className: string }> = {
  RECEIVED: { label: 'Reçue', className: styles.statusReceived ?? '' },
  IDENTITY_CHECK_REQUIRED: { label: 'Vérif. identité', className: styles.statusIdentity ?? '' },
  IN_REVIEW: { label: 'En instruction', className: styles.statusInReview ?? '' },
  DECISION_READY: { label: 'Décision prête', className: styles.statusDecisionReady ?? '' },
  COMPLETED: { label: 'Clôturée (notifiée)', className: styles.statusCompleted ?? '' },
  CANCELLED: { label: 'Annulée', className: styles.statusCancelled ?? '' },
};

const RESOLUTION_LABELS: Record<string, string> = {
  FULFILLED: 'Satisfaite (droit exécuté)',
  PARTIALLY_FULFILLED: 'Partiellement satisfaite',
  REFUSED: 'Refusée (avec motif légal)',
};

const DECISION_REASON_LABELS: Record<string, string> = {
  LEGAL_RETENTION_OBLIGATION: 'Obligation légale de conservation (factures/comptabilité)',
  LITIGATION_HOLD: 'Préservation pour litige ou contentieux en cours',
  IDENTITY_NOT_VERIFIED: 'Impossibilité d’établir l’identité (doute raisonnable)',
  THIRD_PARTY_RIGHTS: 'Atteinte disproportionnée aux droits de tiers',
  MANIFESTLY_UNFOUNDED: 'Demande manifestement infondée ou excessive',
  ALREADY_FULFILLED: 'Demande déjà exécutée',
  TECHNICALLY_IMPOSSIBLE: 'Impossibilité technique démontrée',
};

export interface PrivacySupportViewProps {
  initialData: ListPrivacyRequestsResult;
  filters: ListPrivacyRequestsFilters;
}

export function PrivacySupportView({ initialData, filters }: PrivacySupportViewProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [selectedRequest, setSelectedRequest] = useState<SupportPrivacyRequestItem | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionMessage, setActionMessage] = useState<{ ok: boolean; text: string } | null>(null);

  // Form states in drawer
  const [extensionDate, setExtensionDate] = useState('');
  const [extensionReason, setExtensionReason] = useState('');
  const [resolutionStatus, setResolutionStatus] = useState<
    'FULFILLED' | 'PARTIALLY_FULFILLED' | 'REFUSED'
  >('FULFILLED');
  const [decisionReasonCode, setDecisionReasonCode] = useState('');
  const [resolutionNotes, setResolutionNotes] = useState('');

  const handleTabChange = (tab: 'ACTIVE' | 'CLOSED' | 'ALL') => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', tab);
    router.push(`${pathname}?${params.toString()}`);
  };

  const handleTypeFilterChange = (type: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (type === 'ALL') {
      params.delete('type');
    } else {
      params.set('type', type);
    }
    router.push(`${pathname}?${params.toString()}`);
  };

  const openDrawer = (req: SupportPrivacyRequestItem) => {
    setSelectedRequest(req);
    setActionMessage(null);
    setExtensionDate('');
    setExtensionReason('');
    setResolutionStatus('FULFILLED');
    setDecisionReasonCode('');
    setResolutionNotes('');
  };

  const closeDrawer = () => {
    setSelectedRequest(null);
    setActionMessage(null);
  };

  const handleStartReview = async () => {
    if (!selectedRequest) return;
    setActionLoading(true);
    setActionMessage(null);
    try {
      const res = await startPrivacyReviewAction(selectedRequest.id);
      if (res.ok) {
        setActionMessage({ ok: true, text: 'Demande prise en charge (statut : EN INSTRUCTION).' });
        router.refresh();
      } else {
        setActionMessage({ ok: false, text: res.message });
      }
    } catch {
      setActionMessage({ ok: false, text: 'Erreur inattendue.' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleFlagIdentity = async () => {
    if (!selectedRequest) return;
    setActionLoading(true);
    setActionMessage(null);
    try {
      const res = await flagPrivacyIdentityCheckAction(selectedRequest.id);
      if (res.ok) {
        setActionMessage({
          ok: true,
          text: 'Vérification d’identité signalée (statut : VÉRIF. IDENTITÉ).',
        });
        router.refresh();
      } else {
        setActionMessage({ ok: false, text: res.message });
      }
    } catch {
      setActionMessage({ ok: false, text: 'Erreur inattendue.' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleExtendDeadline = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRequest || !extensionDate || !extensionReason) return;
    setActionLoading(true);
    setActionMessage(null);
    try {
      const res = await extendPrivacyDeadlineAction(selectedRequest.id, {
        extendedUntil: extensionDate,
        reason: extensionReason,
      });
      if (res.ok) {
        setActionMessage({ ok: true, text: 'Échéance prolongée avec succès.' });
        router.refresh();
      } else {
        setActionMessage({ ok: false, text: res.message });
      }
    } catch {
      setActionMessage({ ok: false, text: 'Erreur inattendue.' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmNotification = async () => {
    if (!selectedRequest) return;
    setActionLoading(true);
    setActionMessage(null);
    try {
      const res = await recordExtensionNotificationAction(selectedRequest.id);
      if (res.ok) {
        setActionMessage({
          ok: true,
          text: 'Preuve d’information du demandeur consignée : le SLA étendu est effectif.',
        });
        router.refresh();
      } else {
        setActionMessage({ ok: false, text: res.message });
      }
    } catch {
      setActionMessage({ ok: false, text: 'Erreur inattendue.' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleResolve = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedRequest || !resolutionNotes) return;
    if (resolutionStatus === 'REFUSED' && !decisionReasonCode) {
      setActionMessage({ ok: false, text: 'Un motif légal de refus est obligatoire.' });
      return;
    }
    setActionLoading(true);
    setActionMessage(null);
    try {
      const res = await resolvePrivacyRequestAction(selectedRequest.id, {
        resolutionStatus,
        decisionReasonCode: resolutionStatus === 'REFUSED' ? decisionReasonCode : null,
        resolutionNotes,
      });
      if (res.ok) {
        setActionMessage({
          ok: true,
          text: `Décision interne enregistrée (${RESOLUTION_LABELS[resolutionStatus]}). Statut : DÉCISION PRÊTE.`,
        });
        router.refresh();
      } else {
        setActionMessage({ ok: false, text: res.message });
      }
    } catch {
      setActionMessage({ ok: false, text: 'Erreur inattendue.' });
    } finally {
      setActionLoading(false);
    }
  };

  const handleConfirmResponseNotification = async () => {
    if (!selectedRequest) return;
    setActionLoading(true);
    setActionMessage(null);
    try {
      const res = await recordPrivacyResponseNotificationAction(selectedRequest.id);
      if (res.ok) {
        setActionMessage({
          ok: true,
          text: 'Attestation d’envoi de la réponse enregistrée. Demande clôturée (COMPLETED).',
        });
        router.refresh();
      } else {
        setActionMessage({ ok: false, text: res.message });
      }
    } catch {
      setActionMessage({ ok: false, text: 'Erreur inattendue.' });
    } finally {
      setActionLoading(false);
    }
  };

  const currentTab = filters.tab ?? 'ACTIVE';

  return (
    <div className={styles.container}>
      {/* Header */}
      <div className={styles.header}>
        <h1 className={styles.title}>🛡️ Opérations & Droits RGPD</h1>
        <p className={styles.subtitle}>
          Cockpit d’instruction et de gestion des demandes de droits (Art. 12 à 20 RGPD). Suivi des
          délais légaux, vérifications d’identité et traçabilité d’audit sans PII.
        </p>
      </div>

      {/* KPI Cards */}
      <div className={styles.kpiGrid}>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Demandes en cours</div>
          <div className={`${styles.kpiValue} ${styles.kpiValueActive}`}>
            {initialData.activeCount}
          </div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Échéances dépassées</div>
          <div className={`${styles.kpiValue} ${styles.kpiValueOverdue}`}>
            {initialData.overdueCount}
          </div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Demandes clôturées</div>
          <div className={styles.kpiValue}>{initialData.closedCount}</div>
        </div>
        <div className={styles.kpiCard}>
          <div className={styles.kpiLabel}>Total reçues</div>
          <div className={styles.kpiValue}>{initialData.totalCount}</div>
        </div>
      </div>

      {/* Filter Bar */}
      <div className={styles.filterBar}>
        <div className={styles.tabs}>
          <button
            type="button"
            className={`${styles.tabBtn} ${currentTab === 'ACTIVE' ? styles.tabBtnActive : ''}`}
            onClick={() => handleTabChange('ACTIVE')}
          >
            En cours ({initialData.activeCount})
          </button>
          <button
            type="button"
            className={`${styles.tabBtn} ${currentTab === 'CLOSED' ? styles.tabBtnActive : ''}`}
            onClick={() => handleTabChange('CLOSED')}
          >
            Clôturées ({initialData.closedCount})
          </button>
          <button
            type="button"
            className={`${styles.tabBtn} ${currentTab === 'ALL' ? styles.tabBtnActive : ''}`}
            onClick={() => handleTabChange('ALL')}
          >
            Toutes ({initialData.totalCount})
          </button>
        </div>

        <div>
          <select
            className={styles.typeSelect}
            value={filters.requestType ?? 'ALL'}
            onChange={(e) => handleTypeFilterChange(e.target.value)}
            aria-label="Filtrer par type de droit"
          >
            <option value="ALL">Tous les types de droit</option>
            <option value="ACCESS">Accès (Art. 15)</option>
            <option value="PORTABILITY">Portabilité (Art. 20)</option>
            <option value="RECTIFICATION">Rectification (Art. 16)</option>
            <option value="ERASURE">Effacement (Art. 17)</option>
            <option value="OPPOSITION">Opposition (Art. 21)</option>
            <option value="RESTRICTION">Limitation (Art. 18)</option>
          </select>
        </div>
      </div>

      {/* Table */}
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Date reçue</th>
              <th className={styles.th}>Type de droit</th>
              <th className={styles.th}>Demandeur</th>
              <th className={styles.th}>Échéance légale (SLA)</th>
              <th className={styles.th}>Statut</th>
              <th className={styles.th} style={{ textAlign: 'right' }}>
                Action
              </th>
            </tr>
          </thead>
          <tbody>
            {initialData.items.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  style={{ padding: '2.5rem', textAlign: 'center', color: '#64748b' }}
                >
                  Aucune demande trouvée pour ces filtres.
                </td>
              </tr>
            ) : (
              initialData.items.map((req) => {
                const statusInfo = STATUS_LABELS[req.status] ?? {
                  label: req.status,
                  className: styles.statusReceived,
                };
                let urgencyClass = styles.slaOk;
                let urgencyText = `⏳ ${req.daysRemaining} j restants`;
                if (req.urgency === 'DUE_OVERDUE') {
                  urgencyClass = styles.slaOverdue;
                  urgencyText = `🚨 Échue (${Math.abs(req.daysRemaining)} j)`;
                } else if (req.urgency === 'DUE_IMMINENT') {
                  urgencyClass = styles.slaImminent;
                  urgencyText = `⚠️ ${req.daysRemaining} j restants`;
                } else if (req.urgency === 'DUE_WARNING') {
                  urgencyClass = styles.slaWarning;
                  urgencyText = `⏳ ${req.daysRemaining} j restants`;
                }

                return (
                  <tr key={req.id} className={styles.tr}>
                    <td className={styles.td} style={{ whiteSpace: 'nowrap' }}>
                      {req.receivedAt.toLocaleDateString('fr-FR')}
                    </td>
                    <td className={styles.td}>
                      <span className={`${styles.badge} ${styles.typeBadge}`}>
                        {REQUEST_TYPE_LABELS[req.requestType] ?? req.requestType}
                      </span>
                    </td>
                    <td className={styles.td}>
                      <div>
                        <strong>{req.userDisplayName ?? 'Utilisateur'}</strong>
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#64748b' }}>
                        {req.userEmail ?? req.userId}
                      </div>
                    </td>
                    <td className={styles.td}>
                      {req.resolvedAt ? (
                        <div>
                          <div style={{ color: '#64748b', fontSize: '0.85rem' }}>
                            Clôturée le {req.resolvedAt.toLocaleDateString('fr-FR')}
                          </div>
                          {req.responseCompliance === 'RESPONSE_LATE' ? (
                            <div style={{ color: '#b91c1c', fontSize: '0.75rem', fontWeight: 600 }}>
                              🚨 Répondue hors délai
                            </div>
                          ) : (
                            <div style={{ color: '#166534', fontSize: '0.75rem', fontWeight: 500 }}>
                              ✓ Répondue dans les délais
                            </div>
                          )}
                        </div>
                      ) : (
                        <div>
                          <span className={`${styles.badge} ${urgencyClass}`}>{urgencyText}</span>
                          <div
                            style={{ fontSize: '0.75rem', color: '#64748b', marginTop: '0.2rem' }}
                          >
                            Max : {req.effectiveDueAt.toLocaleDateString('fr-FR')}
                            {req.extendedUntil &&
                              (req.extensionCompliance === 'NOTIFIED_TIMELY' ? (
                                <span
                                  style={{
                                    color: '#166534',
                                    fontWeight: 600,
                                    marginLeft: '0.25rem',
                                  }}
                                >
                                  (+2m notifiée)
                                </span>
                              ) : req.extensionCompliance === 'NOTIFIED_LATE' ? (
                                <span
                                  style={{
                                    color: '#b91c1c',
                                    fontWeight: 600,
                                    marginLeft: '0.25rem',
                                  }}
                                >
                                  (notif hors délai)
                                </span>
                              ) : (
                                <span
                                  style={{
                                    color: '#b45309',
                                    fontWeight: 600,
                                    marginLeft: '0.25rem',
                                  }}
                                >
                                  (attente attestation)
                                </span>
                              ))}
                          </div>
                        </div>
                      )}
                    </td>
                    <td className={styles.td}>
                      <span className={`${styles.badge} ${statusInfo.className}`}>
                        {statusInfo.label}
                      </span>
                    </td>
                    <td className={styles.td} style={{ textAlign: 'right' }}>
                      <button
                        type="button"
                        className={styles.actionBtn}
                        onClick={() => openDrawer(req)}
                      >
                        Instruire →
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Drawer / Action Modal */}
      {selectedRequest && (
        <div className={styles.modalBackdrop} onClick={closeDrawer}>
          <div className={styles.drawer} onClick={(e) => e.stopPropagation()}>
            <div className={styles.drawerHeader}>
              <h2 className={styles.drawerTitle}>
                Instruction demande #{selectedRequest.id.slice(0, 8)}
              </h2>
              <button
                type="button"
                className={styles.closeBtn}
                onClick={closeDrawer}
                aria-label="Fermer"
              >
                &times;
              </button>
            </div>

            {/* Notification message */}
            {actionMessage && (
              <div
                className={`${styles.feedbackMessage} ${
                  actionMessage.ok ? styles.feedbackSuccess : styles.feedbackError
                }`}
              >
                {actionMessage.text}
              </div>
            )}

            {/* Section 1 : Informations de la demande */}
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Détails de la demande</div>
              <div className={styles.fieldRow}>
                <div className={styles.fieldLabel}>Type d'exercice :</div>
                <div className={styles.fieldValue}>
                  <strong>
                    {REQUEST_TYPE_LABELS[selectedRequest.requestType] ??
                      selectedRequest.requestType}
                  </strong>
                </div>
              </div>
              <div className={styles.fieldRow}>
                <div className={styles.fieldLabel}>Demandeur :</div>
                <div className={styles.fieldValue}>
                  {selectedRequest.userDisplayName} (
                  {selectedRequest.userEmail ?? selectedRequest.userId})
                </div>
              </div>
              <div className={styles.fieldRow}>
                <div className={styles.fieldLabel}>Date de réception :</div>
                <div className={styles.fieldValue}>
                  {selectedRequest.receivedAt.toLocaleString('fr-FR')}
                </div>
              </div>
              <div className={styles.fieldRow}>
                <div className={styles.fieldLabel}>Échéance légale :</div>
                <div className={styles.fieldValue}>
                  {selectedRequest.effectiveDueAt.toLocaleDateString('fr-FR')}
                  {selectedRequest.extendedUntil ? ' (Prolongation de 2 mois appliquée)' : ''}
                </div>
              </div>
              <div className={styles.fieldRow}>
                <div className={styles.fieldLabel}>Statut actuel :</div>
                <div className={styles.fieldValue}>
                  <span
                    className={`${styles.badge} ${
                      STATUS_LABELS[selectedRequest.status]?.className ?? ''
                    }`}
                  >
                    {STATUS_LABELS[selectedRequest.status]?.label ?? selectedRequest.status}
                  </span>
                </div>
              </div>

              {selectedRequest.decisionReasonCode && (
                <div className={styles.fieldRow}>
                  <div className={styles.fieldLabel}>Motif de décision :</div>
                  <div className={styles.fieldValue}>
                    <strong>
                      {DECISION_REASON_LABELS[selectedRequest.decisionReasonCode] ??
                        selectedRequest.decisionReasonCode}
                    </strong>
                  </div>
                </div>
              )}

              {selectedRequest.details && (
                <div style={{ marginTop: '0.75rem' }}>
                  <div className={styles.fieldLabel} style={{ marginBottom: '0.25rem' }}>
                    Motivation rédigée par le demandeur :
                  </div>
                  <div className={styles.detailsBox}>{selectedRequest.details}</div>
                </div>
              )}

              {selectedRequest.resolutionNotes && (
                <div style={{ marginTop: '0.75rem' }}>
                  <div className={styles.fieldLabel} style={{ marginBottom: '0.25rem' }}>
                    Notes internes d'instruction :
                  </div>
                  <div className={styles.detailsBox}>{selectedRequest.resolutionNotes}</div>
                </div>
              )}
            </div>

            {/* Section 2 : Actions contextuelles */}
            {selectedRequest.status === 'RECEIVED' && (
              <div
                className={styles.section}
                style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem' }}
              >
                <div className={styles.sectionTitle}>Actions d’instruction</div>
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className={styles.btnPrimary}
                    disabled={actionLoading}
                    onClick={handleStartReview}
                  >
                    {actionLoading ? 'En cours...' : '▶ Prendre en charge (Instruction)'}
                  </button>
                  <button
                    type="button"
                    className={styles.btnWarning}
                    disabled={actionLoading}
                    onClick={handleFlagIdentity}
                  >
                    {actionLoading ? 'En cours...' : '❓ Doute identité (Art. 12.6)'}
                  </button>
                </div>
              </div>
            )}

            {selectedRequest.status === 'IDENTITY_CHECK_REQUIRED' && (
              <div
                className={styles.section}
                style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem' }}
              >
                <div className={styles.sectionTitle}>Validation de l’identité</div>
                <p style={{ fontSize: '0.85rem', color: '#64748b' }}>
                  Une vérification d’identité a été demandée au client (Art. 12.6 RGPD). Une fois
                  l’identité confirmée sans équivoque, démarrez l’instruction.
                </p>
                <button
                  type="button"
                  className={styles.btnPrimary}
                  disabled={actionLoading}
                  onClick={handleStartReview}
                >
                  {actionLoading ? 'En cours...' : '✓ Identité confirmée → Démarrer l’instruction'}
                </button>
              </div>
            )}

            {selectedRequest.status === 'IN_REVIEW' && (
              <>
                {/* Formulaire de prolongation */}
                {!selectedRequest.extendedUntil && (
                  <form
                    onSubmit={handleExtendDeadline}
                    className={styles.section}
                    style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem' }}
                  >
                    <div className={styles.sectionTitle}>
                      Prolonger l’échéance (+2 mois max Art. 12.3)
                    </div>
                    <div className={styles.formGroup}>
                      <label className={styles.label}>Nouvelle date limite :</label>
                      <input
                        type="date"
                        className={styles.input}
                        required
                        value={extensionDate}
                        onChange={(e) => setExtensionDate(e.target.value)}
                      />
                    </div>
                    <div className={styles.formGroup}>
                      <label className={styles.label}>Motif interne de la prorogation :</label>
                      <input
                        type="text"
                        className={styles.input}
                        required
                        placeholder="Ex: Complexité technique des volumétries d'archives"
                        value={extensionReason}
                        onChange={(e) => setExtensionReason(e.target.value)}
                      />
                    </div>
                    <button type="submit" className={styles.btnWarning} disabled={actionLoading}>
                      {actionLoading ? 'Enregistrement...' : 'Prolonger l’échéance'}
                    </button>
                  </form>
                )}

                {/* Section Confirmation Notification Demandeur */}
                {selectedRequest.extendedUntil && !selectedRequest.extensionNotifiedAt && (
                  <div
                    className={styles.section}
                    style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem' }}
                  >
                    <div className={styles.sectionTitle}>
                      Attestation d’information du demandeur (Art. 12.3 RGPD)
                    </div>
                    <p style={{ fontSize: '0.85rem', color: '#b45309', margin: '0 0 0.75rem 0' }}>
                      ⚠️ La prorogation a été enregistrée, mais l’envoi de l’information au
                      demandeur n’a pas encore été attesté. L’échéance nominale de 1 mois reste le
                      repère légal effectif tant que cette attestation n’est pas actée.
                    </p>
                    <button
                      type="button"
                      className={styles.btnWarning}
                      disabled={actionLoading}
                      onClick={handleConfirmNotification}
                    >
                      {actionLoading
                        ? 'Validation...'
                        : '✓ Attester de l’envoi de l’information au demandeur'}
                    </button>
                  </div>
                )}

                {selectedRequest.extendedUntil &&
                  selectedRequest.extensionCompliance === 'NOTIFIED_LATE' && (
                    <div
                      className={styles.section}
                      style={{ borderTop: '1px solid #fee2e2', paddingTop: '1rem' }}
                    >
                      <div className={styles.sectionTitle} style={{ color: '#b91c1c' }}>
                        Notification tardive (Dépassement Art. 12.3 RGPD)
                      </div>
                      <p style={{ fontSize: '0.85rem', color: '#b91c1c', margin: 0 }}>
                        🚨 L’information du demandeur a été consignée après l’échéance nominale
                        initiale. Conformément à l’Art. 12.3 RGPD, une information tardive ne
                        régularise pas le délai : la demande demeure en dépassement d’échéance
                        initiale.
                      </p>
                    </div>
                  )}

                {/* Étape 1 : Décision interne (disponible quand IN_REVIEW) */}
                <form
                  onSubmit={handleResolve}
                  className={styles.section}
                  style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem' }}
                >
                  <div className={styles.sectionTitle}>
                    1. Décision interne sur la suite à donner (Art. 12.3 & 12.4 RGPD)
                  </div>
                  <p style={{ fontSize: '0.85rem', color: '#64748b', margin: '0 0 0.75rem 0' }}>
                    Arrête la position juridique du DPO/Support. La demande passera en « DÉCISION
                    PRÊTE » et restera ouverte jusqu’à l’attestation d’envoi de la réponse.
                  </p>
                  <div className={styles.formGroup}>
                    <label className={styles.label}>Décision retenue :</label>
                    <select
                      className={styles.select}
                      value={resolutionStatus}
                      onChange={(e) =>
                        setResolutionStatus(
                          e.target.value as 'FULFILLED' | 'PARTIALLY_FULFILLED' | 'REFUSED',
                        )
                      }
                    >
                      <option value="FULFILLED">Satisfaite (droit exécuté)</option>
                      <option value="PARTIALLY_FULFILLED">Partiellement satisfaite</option>
                      <option value="REFUSED">Refusée (avec motif légal)</option>
                    </select>
                  </div>

                  {resolutionStatus === 'REFUSED' && (
                    <div className={styles.formGroup}>
                      <label className={styles.label}>
                        Motif légal impératif (Art. 12.4 RGPD) :
                      </label>
                      <select
                        className={styles.select}
                        required
                        value={decisionReasonCode}
                        onChange={(e) => setDecisionReasonCode(e.target.value)}
                      >
                        <option value="">-- Sélectionner un motif légal --</option>
                        {Object.entries(DECISION_REASON_LABELS).map(([code, label]) => (
                          <option key={code} value={code}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div className={styles.formGroup}>
                    <label className={styles.label}>Notes internes de justification :</label>
                    <textarea
                      className={styles.textarea}
                      required
                      placeholder="Indiquez la synthèse de l'instruction et les fondements de la décision..."
                      value={resolutionNotes}
                      onChange={(e) => setResolutionNotes(e.target.value)}
                    />
                  </div>

                  <button
                    type="submit"
                    className={
                      resolutionStatus === 'REFUSED' ? styles.btnDanger : styles.btnPrimary
                    }
                    disabled={actionLoading}
                  >
                    {actionLoading
                      ? 'Enregistrement...'
                      : 'Enregistrer la décision interne (Étape 1/2)'}
                  </button>
                </form>
              </>
            )}

            {/* Étape 2 : Attestation d'envoi de la réponse (disponible quand DECISION_READY) */}
            {selectedRequest.status === 'DECISION_READY' && (
              <div
                className={styles.section}
                style={{ borderTop: '1px solid #e2e8f0', paddingTop: '1rem' }}
              >
                <div className={styles.sectionTitle}>
                  2. Attestation d’envoi de la réponse au demandeur (Art. 12.3 & 12.4 RGPD)
                </div>
                <div
                  style={{
                    background: '#f8fafc',
                    border: '1px solid #e2e8f0',
                    borderRadius: '6px',
                    padding: '0.75rem',
                    marginBottom: '0.75rem',
                    fontSize: '0.85rem',
                  }}
                >
                  <div>
                    <strong>Décision arrêtée :</strong>{' '}
                    {RESOLUTION_LABELS[selectedRequest.resolution ?? ''] ??
                      selectedRequest.resolution}
                  </div>
                  {selectedRequest.decisionReasonCode && (
                    <div style={{ marginTop: '0.25rem' }}>
                      <strong>Motif légal :</strong>{' '}
                      {DECISION_REASON_LABELS[selectedRequest.decisionReasonCode] ??
                        selectedRequest.decisionReasonCode}
                    </div>
                  )}
                  {selectedRequest.decisionAt && (
                    <div style={{ marginTop: '0.25rem', color: '#64748b' }}>
                      Décision prise le {selectedRequest.decisionAt.toLocaleDateString('fr-FR')}
                    </div>
                  )}
                </div>
                <p style={{ fontSize: '0.85rem', color: '#1e293b', margin: '0 0 0.75rem 0' }}>
                  Conformément aux articles 12.3 et 12.4 du RGPD, la demande n’est juridiquement
                  clôturée que lorsque les informations (mesures prises ou motifs de refus avec
                  voies de recours CNIL/judiciaire) ont été formellement communiquées à la personne
                  concernée.
                </p>
                <button
                  type="button"
                  className={styles.btnSuccess}
                  disabled={actionLoading}
                  onClick={handleConfirmResponseNotification}
                >
                  {actionLoading
                    ? 'Clôture en cours...'
                    : '✓ Attester de l’envoi de la réponse au demandeur (Clôturer)'}
                </button>
              </div>
            )}

            {/* État clôturé (COMPLETED) */}
            {selectedRequest.status === 'COMPLETED' && (
              <div
                className={styles.section}
                style={{
                  borderTop: '1px solid #bbf7d0',
                  background: '#f0fdf4',
                  padding: '1rem',
                  borderRadius: '6px',
                }}
              >
                <div className={styles.sectionTitle} style={{ color: '#15803d' }}>
                  ✓ Demande clôturée (Boucle d’information fermée)
                </div>
                <p style={{ fontSize: '0.85rem', color: '#166534', margin: 0 }}>
                  Résolution :{' '}
                  <strong>
                    {RESOLUTION_LABELS[selectedRequest.resolution ?? ''] ??
                      selectedRequest.resolution}
                  </strong>
                  {selectedRequest.decisionReasonCode &&
                    ` — Motif : ${DECISION_REASON_LABELS[selectedRequest.decisionReasonCode] ?? selectedRequest.decisionReasonCode}`}
                  <br />
                  Réponse formelle communiquée au demandeur le{' '}
                  {selectedRequest.responseNotifiedAt?.toLocaleDateString('fr-FR')} (attestée par
                  opérateur).
                </p>
                {selectedRequest.responseCompliance === 'RESPONSE_LATE' ? (
                  <div
                    style={{
                      marginTop: '0.5rem',
                      color: '#b91c1c',
                      fontWeight: 600,
                      fontSize: '0.8rem',
                    }}
                  >
                    🚨 Réponse communiquée après l’échéance légale effective (Art. 12.3 RGPD).
                  </div>
                ) : (
                  <div
                    style={{
                      marginTop: '0.5rem',
                      color: '#15803d',
                      fontWeight: 600,
                      fontSize: '0.8rem',
                    }}
                  >
                    ✓ Réponse communiquée dans le respect des délais légaux.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
