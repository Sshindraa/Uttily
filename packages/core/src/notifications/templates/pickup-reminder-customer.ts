import { escapeHtml, formatDate, renderEmailLayout } from './layout';
import type { RenderedEmail } from '../types';

export interface PickupReminderCustomerData {
  bookingId: string;
  customerName?: string | null | undefined;
  organizationName: string;
  productName: string;
  customerStartAt: Date;
  locationName: string;
  locationAddress?: string | null | undefined;
  locationPhone?: string | null | undefined;
  pickupInstructions?: string | null | undefined;
  timeZone: string;
}

export function renderPickupReminderCustomer(data: PickupReminderCustomerData): RenderedEmail {
  const subject = `Rappel : Votre location ${data.productName} débute bientôt`;
  const greeting = data.customerName ? `Bonjour ${escapeHtml(data.customerName)},` : 'Bonjour,';

  const instructionsHtml = data.pickupInstructions
    ? `
      <div class="metric-row">
        <span class="metric-label">Consignes de retrait :</span>
        <span class="metric-value">${escapeHtml(data.pickupInstructions)}</span>
      </div>`
    : '';

  const phoneHtml = data.locationPhone
    ? `
      <div class="metric-row">
        <span class="metric-label">Contact magasin :</span>
        <span class="metric-value">${escapeHtml(data.locationPhone)}</span>
      </div>`
    : '';

  const contentHtml = `
    <h1>⏰ Rappel pour votre départ</h1>
    <p>${greeting}</p>
    <p>Votre location pour <strong>${escapeHtml(data.productName)}</strong> auprès de <strong>${escapeHtml(data.organizationName)}</strong> débute très prochainement :</p>
    
    <div class="card">
      <div class="metric-row">
        <span class="metric-label">Horaire de retrait :</span>
        <span class="metric-value">${escapeHtml(formatDate(data.customerStartAt, data.timeZone))}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Lieu de retrait :</span>
        <span class="metric-value">${escapeHtml(data.locationName)}${data.locationAddress ? ` (${escapeHtml(data.locationAddress)})` : ''}</span>
      </div>
      ${phoneHtml}
      ${instructionsHtml}
    </div>

    <p>N'oubliez pas d'apporter une pièce d'identité en cours de validité.</p>
  `;

  const text = `Rappel pour votre départ ⏰

${greeting}

Votre location pour ${data.productName} auprès de ${data.organizationName} débute très prochainement :

Horaire de retrait : ${formatDate(data.customerStartAt, data.timeZone)}
Lieu de retrait : ${data.locationName}${data.locationAddress ? ` (${data.locationAddress})` : ''}
${data.locationPhone ? `Contact magasin : ${data.locationPhone}\n` : ''}${data.pickupInstructions ? `Consignes de retrait : ${data.pickupInstructions}\n` : ''}
N'oubliez pas d'apporter une pièce d'identité en cours de validité.

L'équipe Uttily
`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, contentHtml }),
    text,
  };
}
