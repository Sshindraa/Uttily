import React from 'react';
import type { PreviewBookingAmendmentSuccess, PreviewLineDiffEntry } from '@uttily/core';

export interface AmendmentPreviewResultProps {
  preview: PreviewBookingAmendmentSuccess;
  headingRef?: React.RefObject<HTMLHeadingElement | null>;
}

export function formatEuros(amountMinor: number): string {
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
  }).format(amountMinor / 100);
}

export function formatDisplayDate(dateInput: Date | string, timeZone: string): string {
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  return new Intl.DateTimeFormat('fr-FR', {
    timeZone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(d);
}

export function actionLabel(action: PreviewLineDiffEntry['action']): {
  text: string;
  bg: string;
  color: string;
} {
  switch (action) {
    case 'UNCHANGED':
      return {
        text: 'Inchangé',
        bg: 'var(--ut-color-surface-raised)',
        color: 'var(--ut-color-ink)',
      };
    case 'MODIFY':
      return {
        text: 'Modifié',
        bg: 'var(--ut-color-primary-soft)',
        color: 'var(--ut-color-primary-strong)',
      };
    case 'ADD':
      return {
        text: 'Ajouté',
        bg: 'var(--ut-color-success-soft)',
        color: 'var(--ut-color-success)',
      };
    case 'REMOVE':
      return { text: 'Retiré', bg: 'var(--ut-color-danger-soft)', color: 'var(--ut-color-danger)' };
  }
}

/**
 * Composant de présentation du résultat de prévisualisation (G7M-C5-A).
 * Affiche la classification, les comparaisons de dates et montants, le détail par article
 * et le bilan financier de manière claire, mobile-first et accessible.
 */
export function AmendmentPreviewResult({
  preview,
  headingRef,
}: AmendmentPreviewResultProps): React.ReactElement {
  return (
    <section
      aria-labelledby="preview-heading"
      aria-live="polite"
      style={{
        backgroundColor: 'var(--ut-color-surface)',
        border: '1px solid var(--ut-color-border)',
        borderRadius: '0.5rem',
        padding: '1.5rem',
        display: 'flex',
        flexDirection: 'column',
        gap: '1.5rem',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: '0.5rem',
        }}
      >
        <h2
          id="preview-heading"
          ref={headingRef}
          tabIndex={-1}
          style={{
            fontSize: '1.25rem',
            fontWeight: 'var(--ut-weight-semibold)',
            margin: 0,
            outline: 'none',
          }}
        >
          Votre modification
        </h2>
        <span
          data-testid="classification-badge"
          style={{
            display: 'inline-block',
            padding: '0.25rem 0.75rem',
            borderRadius: '9999px',
            fontSize: '0.75rem',
            fontWeight: 'var(--ut-weight-semibold)',
            backgroundColor:
              preview.classification === 'NEUTRAL'
                ? 'var(--ut-color-primary-soft)'
                : preview.classification === 'REFUND'
                  ? 'var(--ut-color-warning-soft)'
                  : 'var(--ut-color-success-soft)',
            color:
              preview.classification === 'NEUTRAL'
                ? 'var(--ut-color-primary-strong)'
                : preview.classification === 'REFUND'
                  ? 'var(--ut-color-warning)'
                  : 'var(--ut-color-success)',
          }}
        >
          {preview.classification === 'NEUTRAL' && 'Modification neutre (0 €)'}
          {preview.classification === 'REFUND' && 'Remboursement client'}
          {preview.classification === 'SUPPLEMENT' && 'Supplément à régler'}
        </span>
      </div>

      {/* Comparaison Avant / Après */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
          gap: '1rem',
        }}
      >
        <div
          style={{
            border: '1px solid var(--ut-color-border)',
            borderRadius: '0.375rem',
            padding: '1rem',
          }}
        >
          <h3
            style={{
              margin: '0 0 0.5rem 0',
              fontSize: '0.925rem',
              color: 'var(--ut-color-ink-muted)',
            }}
          >
            Avant
          </h3>
          <p style={{ margin: '0 0 0.25rem 0', fontSize: '0.875rem' }}>
            <strong>Dates :</strong>{' '}
            {formatDisplayDate(preview.previousCustomerStartAt, preview.locationTimeZone)} →{' '}
            {formatDisplayDate(preview.previousCustomerEndAt, preview.locationTimeZone)}
          </p>
          <p style={{ margin: 0, fontSize: '0.875rem' }}>
            <strong>Total :</strong> {formatEuros(preview.previousContractualTotalAmountMinor)}
          </p>
        </div>

        <div
          style={{
            border: '1px solid var(--ut-color-border)',
            borderRadius: '0.375rem',
            padding: '1rem',
            backgroundColor: 'var(--ut-color-surface-raised)',
          }}
        >
          <h3
            style={{
              margin: '0 0 0.5rem 0',
              fontSize: '0.925rem',
              color: 'var(--ut-color-primary-strong)',
            }}
          >
            Après
          </h3>
          <p style={{ margin: '0 0 0.25rem 0', fontSize: '0.875rem' }}>
            <strong>Dates :</strong>{' '}
            {formatDisplayDate(preview.nextCustomerStartAt, preview.locationTimeZone)} →{' '}
            {formatDisplayDate(preview.nextCustomerEndAt, preview.locationTimeZone)}
          </p>
          <p style={{ margin: 0, fontSize: '0.875rem' }}>
            <strong>Nouveau total :</strong> {formatEuros(preview.nextContractualTotalAmountMinor)}
          </p>
        </div>
      </div>

      {/* Détail des lignes */}
      <div>
        <h3
          style={{
            fontSize: '1rem',
            fontWeight: 'var(--ut-weight-semibold)',
            margin: '0 0 0.75rem 0',
          }}
        >
          Détail des articles
        </h3>
        <ul
          style={{
            listStyle: 'none',
            padding: 0,
            margin: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: '0.5rem',
          }}
        >
          {preview.lines.map((l) => {
            const badge = actionLabel(l.action);
            return (
              <li
                key={l.variantId}
                data-testid={`line-diff-${l.variantId}`}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '0.75rem',
                  border: '1px solid var(--ut-color-surface-raised)',
                  borderRadius: '0.375rem',
                  backgroundColor:
                    l.action === 'REMOVE'
                      ? 'var(--ut-color-surface)5f5'
                      : 'var(--ut-color-surface)',
                }}
              >
                <div>
                  <p
                    style={{
                      margin: 0,
                      fontWeight: 'var(--ut-weight-medium)',
                      fontSize: '0.875rem',
                    }}
                  >
                    {l.productName} — {l.variantName}
                  </p>
                  <p
                    style={{
                      margin: '0.25rem 0 0 0',
                      color: 'var(--ut-color-ink-muted)',
                      fontSize: '0.75rem',
                    }}
                  >
                    Quantité : {l.beforeQuantity} → {l.afterQuantity}
                  </p>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                  <span
                    style={{
                      fontSize: '0.875rem',
                      fontWeight: 'var(--ut-weight-medium)',
                      color:
                        l.action === 'REMOVE'
                          ? 'var(--ut-color-ink-subtle)'
                          : 'var(--ut-color-ink-strong)',
                    }}
                  >
                    {formatEuros(l.afterLineTotalAmountMinor)}
                  </span>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.125rem 0.5rem',
                      borderRadius: '0.25rem',
                      backgroundColor: badge.bg,
                      color: badge.color,
                      fontWeight: 'var(--ut-weight-medium)',
                    }}
                  >
                    {badge.text}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      {/* Bilan financier */}
      <div
        style={{
          padding: '1rem',
          backgroundColor: 'var(--ut-color-surface-raised)',
          borderRadius: '0.375rem',
          border: '1px solid var(--ut-color-border)',
        }}
      >
        <h3
          style={{
            fontSize: '0.925rem',
            fontWeight: 'var(--ut-weight-semibold)',
            margin: '0 0 0.5rem 0',
          }}
        >
          Bilan financier
        </h3>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '0.875rem',
            marginBottom: '0.25rem',
          }}
        >
          <span>Total actuel :</span>
          <span>{formatEuros(preview.previousContractualTotalAmountMinor)}</span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '0.875rem',
            marginBottom: '0.25rem',
          }}
        >
          <span>Nouveau total :</span>
          <span style={{ fontWeight: 'var(--ut-weight-semibold)' }}>
            {formatEuros(preview.nextContractualTotalAmountMinor)}
          </span>
        </div>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '0.925rem',
            fontWeight: 'var(--ut-weight-semibold)',
            borderTop: '1px solid var(--ut-color-border)',
            paddingTop: '0.5rem',
            marginTop: '0.5rem',
          }}
        >
          <span>Différence :</span>
          <span
            data-testid="delta-amount"
            style={{
              color:
                preview.deltaAmountMinor > 0
                  ? 'var(--ut-color-success)'
                  : preview.deltaAmountMinor < 0
                    ? 'var(--ut-color-warning)'
                    : 'var(--ut-color-ink)',
            }}
          >
            {preview.deltaAmountMinor > 0 ? '+' : ''}
            {formatEuros(preview.deltaAmountMinor)}
          </span>
        </div>

        {preview.classification === 'SUPPLEMENT' && (
          <div
            data-testid="supplement-financials"
            style={{
              marginTop: '0.5rem',
              paddingTop: '0.5rem',
              borderTop: '1px dashed var(--ut-color-border)',
              fontSize: '0.8125rem',
              color: 'var(--ut-color-ink)',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Commission Uttily estimée :</span>
              <span>{formatEuros(preview.supplementCommissionAmountMinor ?? 0)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Net loueur estimé :</span>
              <span>{formatEuros(preview.supplementNetAmountMinor ?? 0)}</span>
            </div>
          </div>
        )}
      </div>

      {/* Explications et avertissements */}
      <div
        style={{
          backgroundColor: 'var(--ut-color-success-soft)',
          border: '1px solid var(--ut-color-success-soft)',
          borderRadius: '0.375rem',
          padding: '0.875rem',
          fontSize: '0.875rem',
          color: 'var(--ut-color-success-strong)',
        }}
      >
        {preview.classification === 'NEUTRAL' && (
          <p style={{ margin: 0 }}>
            Aucun paiement ni remboursement nécessaire. Vous pourrez appliquer directement ces
            changements à l'étape de confirmation.
          </p>
        )}
        {preview.classification === 'REFUND' && (
          <p style={{ margin: 0 }}>
            Un remboursement de <strong>{formatEuros(Math.abs(preview.deltaAmountMinor))}</strong>{' '}
            sera émis vers le moyen de paiement d'origine du client lors de la confirmation.
          </p>
        )}
        {preview.classification === 'SUPPLEMENT' && (
          <p style={{ margin: 0 }}>
            Le client devra régler un supplément de{' '}
            <strong>{formatEuros(preview.deltaAmountMinor)}</strong> par carte bancaire. Un hold
            temporaire de 10 minutes sera posé sur les articles supplémentaires dès l'initiation.
          </p>
        )}
        <p
          style={{ margin: '0.5rem 0 0 0', fontSize: '0.75rem', color: 'var(--ut-color-success)' }}
        >
          ℹ️ La disponibilité physique indiquée ici est prévisionnelle et sera vérifiée à nouveau et
          verrouillée lors de la confirmation.
        </p>
      </div>
    </section>
  );
}
