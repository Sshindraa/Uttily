import { escapeHtml, formatDate, formatEur, renderEmailLayout } from './layout';
import type { RenderedEmail } from '../types';

export interface BookingConfirmedCustomerData {
  bookingId: string;
  customerName?: string;
  organizationName: string;
  productName: string;
  customerStartAt: Date;
  customerEndAt: Date;
  locationName: string;
  locationAddress?: string;
  timeZone: string;
  totalAmountMinor: number;
}

export function renderBookingConfirmedCustomer(data: BookingConfirmedCustomerData): RenderedEmail {
  const subject = `Confirmation de votre réservation Uttily — ${data.productName}`;
  const greeting = data.customerName ? `Bonjour ${escapeHtml(data.customerName)},` : 'Bonjour,';

  const contentHtml = `
    <h1>Votre réservation est confirmée ✓</h1>
    <p>${greeting}</p>
    <p>Votre réservation auprès de <strong>${escapeHtml(data.organizationName)}</strong> est validée. Voici le récapitulatif de votre location :</p>
    
    <div class="card">
      <div class="metric-row">
        <span class="metric-label">Équipement :</span>
        <span class="metric-value">${escapeHtml(data.productName)}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Début :</span>
        <span class="metric-value">${escapeHtml(formatDate(data.customerStartAt, data.timeZone))}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Fin :</span>
        <span class="metric-value">${escapeHtml(formatDate(data.customerEndAt, data.timeZone))}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Lieu de retrait :</span>
        <span class="metric-value">${escapeHtml(data.locationName)}${data.locationAddress ? ` (${escapeHtml(data.locationAddress)})` : ''}</span>
      </div>
      <div class="metric-row" style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #cbd5e1;">
        <span class="metric-label">Montant payé :</span>
        <span class="metric-value" style="color: #059669; font-size: 16px;">${escapeHtml(formatEur(data.totalAmountMinor))}</span>
      </div>
    </div>

    <p>Présentez-vous au point de retrait avec une pièce d'identité à l'heure convenue.</p>
  `;

  const text = `Votre réservation est confirmée ✓

${greeting}

Votre réservation auprès de ${data.organizationName} est validée.

Équipement : ${data.productName}
Début : ${formatDate(data.customerStartAt, data.timeZone)}
Fin : ${formatDate(data.customerEndAt, data.timeZone)}
Lieu de retrait : ${data.locationName}${data.locationAddress ? ` (${data.locationAddress})` : ''}
Montant payé : ${formatEur(data.totalAmountMinor)}

Présentez-vous au point de retrait avec une pièce d'identité à l'heure convenue.

L'équipe Uttily
`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, contentHtml }),
    text,
  };
}
