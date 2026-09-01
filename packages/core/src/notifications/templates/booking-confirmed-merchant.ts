import { escapeHtml, formatDate, formatEur, renderEmailLayout } from './layout';
import type { RenderedEmail } from '../types';

export interface BookingConfirmedMerchantData {
  bookingId: string;
  organizationName: string;
  customerEmail: string;
  productName: string;
  customerStartAt: Date;
  customerEndAt: Date;
  locationName: string;
  timeZone: string;
  merchantBaseAmountMinor: number;
  merchantFeeAmountMinor: number;
  merchantNetAmountMinor: number;
}

export function renderBookingConfirmedMerchant(data: BookingConfirmedMerchantData): RenderedEmail {
  const subject = `Nouvelle réservation confirmée — ${data.productName}`;

  const contentHtml = `
    <h1>🚲 Nouvelle réservation reçue</h1>
    <p>Une nouvelle réservation vient d'être confirmée pour votre établissement <strong>${escapeHtml(data.organizationName)}</strong>.</p>
    
    <div class="card">
      <div class="metric-row">
        <span class="metric-label">Équipement :</span>
        <span class="metric-value">${escapeHtml(data.productName)}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Client :</span>
        <span class="metric-value">${escapeHtml(data.customerEmail)}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Départ :</span>
        <span class="metric-value">${escapeHtml(formatDate(data.customerStartAt, data.timeZone))}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Retour :</span>
        <span class="metric-value">${escapeHtml(formatDate(data.customerEndAt, data.timeZone))}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Lieu :</span>
        <span class="metric-value">${escapeHtml(data.locationName)}</span>
      </div>
      <div class="metric-row" style="margin-top: 12px; padding-top: 12px; border-top: 1px dashed #d1e1e5;">
        <span class="metric-label">Prix location :</span>
        <span class="metric-value">${escapeHtml(formatEur(data.merchantBaseAmountMinor))}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Frais plateforme loueur :</span>
        <span class="metric-value">-${escapeHtml(formatEur(data.merchantFeeAmountMinor))}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Net location :</span>
        <span class="metric-value" style="color: #465b5f; font-size: 16px;">${escapeHtml(formatEur(data.merchantNetAmountMinor))}</span>
      </div>
    </div>

    <p>Le matériel a été bloqué dans votre planning opérationnel. Préparez l'équipement pour le départ du client.</p>
  `;

  const text = `Nouvelle réservation reçue 🚲

Une nouvelle réservation vient d'être confirmée pour votre établissement ${data.organizationName}.

Équipement : ${data.productName}
Client : ${data.customerEmail}
Départ : ${formatDate(data.customerStartAt, data.timeZone)}
Retour : ${formatDate(data.customerEndAt, data.timeZone)}
Lieu : ${data.locationName}
Prix location : ${formatEur(data.merchantBaseAmountMinor)}
Frais plateforme loueur : -${formatEur(data.merchantFeeAmountMinor)}
Net location : ${formatEur(data.merchantNetAmountMinor)}

Le matériel a été bloqué dans votre planning opérationnel. Préparez l'équipement pour le départ du client.

L'équipe Uttily
`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, contentHtml }),
    text,
  };
}
