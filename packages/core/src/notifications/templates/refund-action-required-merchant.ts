import { escapeHtml, formatEur, renderEmailLayout } from './layout';
import type { RenderedEmail } from '../types';

export interface RefundActionRequiredMerchantData {
  refundId: string;
  organizationName: string;
  bookingId: string;
  amountMinor: number;
  failureCode?: string | undefined;
}

export function renderRefundActionRequiredMerchant(
  data: RefundActionRequiredMerchantData,
): RenderedEmail {
  const subject = `⚠️ Action requise : Échec d'un remboursement (${formatEur(data.amountMinor)})`;

  const contentHtml = `
    <h1>⚠️ Action requise sur un remboursement</h1>
    <p>Un remboursement d'un montant de <strong>${escapeHtml(formatEur(data.amountMinor))}</strong> pour votre organisation <strong>${escapeHtml(data.organizationName)}</strong> n'a pas pu aboutir automatiquement.</p>
    
    <div class="card">
      <div class="metric-row">
        <span class="metric-label">Montant concerné :</span>
        <span class="metric-value" style="color: #b42318;">${escapeHtml(formatEur(data.amountMinor))}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Réservation :</span>
        <span class="metric-value">${escapeHtml(data.bookingId)}</span>
      </div>
      ${
        data.failureCode
          ? `<div class="metric-row">
              <span class="metric-label">Code d'erreur :</span>
              <span class="metric-value">${escapeHtml(data.failureCode)}</span>
            </div>`
          : ''
      }
    </div>

    <p>Veuillez vous connecter à votre espace d'administration Uttily / Finances pour régulariser la situation manuellement ou contacter le support.</p>
  `;

  const text = `Action requise sur un remboursement ⚠️

Un remboursement d'un montant de ${formatEur(data.amountMinor)} pour votre organisation ${data.organizationName} n'a pas pu aboutir automatiquement.

Montant concerné : ${formatEur(data.amountMinor)}
Réservation : ${data.bookingId}
${data.failureCode ? `Code d'erreur : ${data.failureCode}\n` : ''}
Veuillez vous connecter à votre espace d'administration Uttily / Finances pour régulariser la situation.

L'équipe Uttily
`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, contentHtml }),
    text,
  };
}
