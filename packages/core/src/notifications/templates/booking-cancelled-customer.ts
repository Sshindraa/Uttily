import { escapeHtml, formatEur, renderEmailLayout } from './layout';
import type { RenderedEmail } from '../types';

export interface BookingCancelledCustomerData {
  bookingId: string;
  customerName?: string;
  organizationName: string;
  productName: string;
  refundAmountMinor: number;
  retainedAmountMinor: number;
}

export function renderBookingCancelledCustomer(data: BookingCancelledCustomerData): RenderedEmail {
  const subject = `Annulation de votre réservation — ${data.productName}`;
  const greeting = data.customerName ? `Bonjour ${escapeHtml(data.customerName)},` : 'Bonjour,';

  const refundSection =
    data.refundAmountMinor > 0
      ? `<div class="card">
          <div class="metric-row">
            <span class="metric-label">Remboursement demandé :</span>
            <span class="metric-value" style="color: #059669; font-size: 16px;">${escapeHtml(formatEur(data.refundAmountMinor))}</span>
          </div>
          ${
            data.retainedAmountMinor > 0
              ? `<div class="metric-row" style="margin-top: 8px;">
                  <span class="metric-label">Frais retenus selon la politique :</span>
                  <span class="metric-value">${escapeHtml(formatEur(data.retainedAmountMinor))}</span>
                </div>`
              : ''
          }
        </div>
        <p>Le virement de remboursement a été transmis à notre opérateur de paiement. Vous recevrez une confirmation dès que les fonds auront été traités.</p>`
      : `<p>Conformément aux conditions d'annulation applicables, aucun remboursement n'a été émis pour cette annulation.</p>`;

  const contentHtml = `
    <h1>Réservation annulée</h1>
    <p>${greeting}</p>
    <p>Votre réservation pour l'équipement <strong>${escapeHtml(data.productName)}</strong> auprès de <strong>${escapeHtml(data.organizationName)}</strong> a bien été annulée.</p>
    
    ${refundSection}

    <p>Nous restons à votre disposition pour vos futures réservations.</p>
  `;

  const text = `Réservation annulée

${greeting}

Votre réservation pour l'équipement ${data.productName} auprès de ${data.organizationName} a bien été annulée.

${
  data.refundAmountMinor > 0
    ? `Remboursement demandé : ${formatEur(data.refundAmountMinor)}
${data.retainedAmountMinor > 0 ? `Frais retenus : ${formatEur(data.retainedAmountMinor)}\n` : ''}
Le virement de remboursement a été transmis à notre opérateur de paiement. Vous recevrez une confirmation dès que les fonds auront été traités.`
    : `Conformément aux conditions d'annulation applicables, aucun remboursement n'a été émis.`
}

L'équipe Uttily
`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, contentHtml }),
    text,
  };
}
