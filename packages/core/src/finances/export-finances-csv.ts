import type { MerchantFinanceOverview } from './types';

export function exportFinancesCsv(overview: MerchantFinanceOverview): string {
  const headers = [
    'Date',
    'Reference',
    'Type',
    'Produit / Intitule',
    'Client',
    'Prix location (EUR)',
    'Frais plateforme loueur (EUR)',
    'Net location (EUR)',
    'Statut',
  ];

  const lines = [headers.join(';')];

  for (const item of overview.activity) {
    const dateFormatted = item.date.toISOString().slice(0, 10);
    const grossEur = (item.grossAmountMinor / 100).toFixed(2);
    const commEur = (item.commissionAmountMinor / 100).toFixed(2);
    const netEur = (item.netAmountMinor / 100).toFixed(2);

    const escapeCsv = (val: string) => `"${val.replace(/"/g, '""')}"`;

    const row = [
      dateFormatted,
      escapeCsv(item.bookingReference),
      escapeCsv(item.type),
      escapeCsv(item.productName ?? ''),
      escapeCsv(item.customerEmail ?? ''),
      grossEur,
      commEur,
      netEur,
      escapeCsv(item.statusLabel),
    ];

    lines.push(row.join(';'));
  }

  return lines.join('\n');
}
