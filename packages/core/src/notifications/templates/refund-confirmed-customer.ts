import { escapeHtml, formatEur, renderEmailLayout } from './layout';
import type { RenderedEmail } from '../types';

export interface RefundConfirmedCustomerData {
  refundId: string;
  customerName?: string;
  productName: string;
  organizationName: string;
  amountMinor: number;
}

export function renderRefundConfirmedCustomer(data: RefundConfirmedCustomerData): RenderedEmail {
  const subject = `Votre remboursement de ${formatEur(data.amountMinor)} a été confirmé`;
  const greeting = data.customerName ? `Bonjour ${escapeHtml(data.customerName)},` : 'Bonjour,';

  const contentHtml = `
    <h1>Remboursement confirmé ↩</h1>
    <p>${greeting}</p>
    <p>Le remboursement lié à votre réservation pour <strong>${escapeHtml(data.productName)}</strong> auprès de <strong>${escapeHtml(data.organizationName)}</strong> a été exécuté avec succès.</p>
    
    <div class="card">
      <div class="metric-row">
        <span class="metric-label">Montant remboursé :</span>
        <span class="metric-value" style="color: #059669; font-size: 18px; font-weight: 700;">${escapeHtml(formatEur(data.amountMinor))}</span>
      </div>
      <div class="metric-row" style="margin-top: 8px;">
        <span class="metric-label">Mode :</span>
        <span class="metric-value">Recrédit sur votre moyen de paiement initial</span>
      </div>
    </div>

    <p>Les fonds apparaîtront sur votre relevé bancaire sous 3 à 5 jours ouvrés selon votre banque.</p>
  `;

  const text = `Remboursement confirmé ↩

${greeting}

Le remboursement lié à votre réservation pour ${data.productName} auprès de ${data.organizationName} a été exécuté avec succès.

Montant remboursé : ${formatEur(data.amountMinor)}
Mode : Recrédit sur le moyen de paiement initial

Les fonds apparaîtront sur votre relevé bancaire sous 3 à 5 jours ouvrés.

L'équipe Uttily
`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, contentHtml }),
    text,
  };
}
