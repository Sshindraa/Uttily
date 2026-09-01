import { escapeHtml, formatEur, renderEmailLayout } from './layout';
import type { RenderedEmail } from '../types';

export interface BookingCancelledMerchantData {
  bookingId: string;
  organizationName: string;
  customerEmail: string;
  productName: string;
  actorReason: string;
  retainedAmountMinor: number;
  finalMerchantRevenueMinor: number;
}

export function renderBookingCancelledMerchant(data: BookingCancelledMerchantData): RenderedEmail {
  const subject = `Annulation de réservation — ${data.productName}`;

  const contentHtml = `
    <h1>✕ Réservation annulée</h1>
    <p>La réservation pour <strong>${escapeHtml(data.productName)}</strong> a été annulée.</p>
    
    <div class="card">
      <div class="metric-row">
        <span class="metric-label">Client :</span>
        <span class="metric-value">${escapeHtml(data.customerEmail)}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Motif :</span>
        <span class="metric-value">${escapeHtml(data.actorReason)}</span>
      </div>
      ${
        data.finalMerchantRevenueMinor > 0
          ? `<div class="metric-row" style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #d1e1e5;">
              <span class="metric-label">Frais conservés (revenu net) :</span>
              <span class="metric-value" style="color: #465b5f; font-size: 16px;">${escapeHtml(formatEur(data.finalMerchantRevenueMinor))}</span>
            </div>`
          : ''
      }
    </div>

    <p>L'équipement a été automatiquement débloqué et est de nouveau disponible à la location dans votre inventaire.</p>
  `;

  const text = `Réservation annulée ✕

La réservation pour ${data.productName} a été annulée.

Client : ${data.customerEmail}
Motif : ${data.actorReason}
${data.finalMerchantRevenueMinor > 0 ? `Revenu net conservé : ${formatEur(data.finalMerchantRevenueMinor)}\n` : ''}
L'équipement a été automatiquement débloqué et est de nouveau disponible à la location.

L'équipe Uttily
`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, contentHtml }),
    text,
  };
}
