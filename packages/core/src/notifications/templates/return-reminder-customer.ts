import { escapeHtml, formatDate, renderEmailLayout } from './layout';
import type { RenderedEmail } from '../types';

export interface ReturnReminderCustomerData {
  bookingId: string;
  customerName?: string;
  organizationName: string;
  productName: string;
  customerEndAt: Date;
  locationName: string;
  locationAddress?: string;
  timeZone: string;
}

export function renderReturnReminderCustomer(data: ReturnReminderCustomerData): RenderedEmail {
  const subject = `Rappel : Retour de votre équipement ${data.productName}`;
  const greeting = data.customerName ? `Bonjour ${escapeHtml(data.customerName)},` : 'Bonjour,';

  const contentHtml = `
    <h1>⏰ Rappel pour votre retour</h1>
    <p>${greeting}</p>
    <p>Votre location pour <strong>${escapeHtml(data.productName)}</strong> auprès de <strong>${escapeHtml(data.organizationName)}</strong> arrive à son terme :</p>
    
    <div class="card">
      <div class="metric-row">
        <span class="metric-label">Horaire limite de restitution :</span>
        <span class="metric-value">${escapeHtml(formatDate(data.customerEndAt, data.timeZone))}</span>
      </div>
      <div class="metric-row">
        <span class="metric-label">Lieu de retour :</span>
        <span class="metric-value">${escapeHtml(data.locationName)}${data.locationAddress ? ` (${escapeHtml(data.locationAddress)})` : ''}</span>
      </div>
    </div>

    <p>Merci de restituer le matériel propre et dans son état initial avec tous ses accessoires.</p>
  `;

  const text = `Rappel pour votre retour ⏰

${greeting}

Votre location pour ${data.productName} auprès de ${data.organizationName} arrive à son terme :

Horaire limite de restitution : ${formatDate(data.customerEndAt, data.timeZone)}
Lieu de retour : ${data.locationName}${data.locationAddress ? ` (${data.locationAddress})` : ''}

Merci de restituer le matériel propre et dans son état initial avec tous ses accessoires.

L'équipe Uttily
`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, contentHtml }),
    text,
  };
}
