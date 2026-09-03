import type { MerchantFinanceOverview } from './types';

export interface PartnerLegalIdentity {
  readonly legalName: string;
  readonly legalForm?: string | null;
  readonly registrationNumber?: string | null;
  readonly vatNumber?: string | null;
  readonly registryCity?: string | null;
  readonly registeredOfficeAddress?: string | null;
  readonly registeredOfficePostalCode?: string | null;
  readonly registeredOfficeCity?: string | null;
}

export interface CommissionStatementOptions {
  readonly organization: PartnerLegalIdentity;
  readonly overview: MerchantFinanceOverview;
}

/**
 * Génère un décompte officiel de commissions et reversements (format CSV comptable avec BOM UTF-8).
 * Ce document est opposable pour la comptabilité du partenaire loueur et détaille :
 * - Les mentions légales d'Uttily SAS (opérateur technique d'intermédiation)
 * - Les mentions légales du partenaire loueur (SIRET, TVA, RCS, siège social)
 * - Les totaux consolidés (brut, commission 13%, remboursements, net reversé)
 * - La ventilation détaillée ligne par ligne
 */
export function generateCommissionStatementCsv(options: CommissionStatementOptions): string {
  const { organization, overview } = options;

  const escapeCsv = (val: string) => `"${val.replace(/"/g, '""')}"`;
  const formatAmount = (minor: number) => (minor / 100).toFixed(2);

  const lines: string[] = [];

  // En-tête légal émetteur de la plateforme
  lines.push(escapeCsv('DÉCOMPTE OFFICIEL DE COMMISSIONS ET REVERSEMENTS'));
  lines.push(
    escapeCsv(
      'Opérateur technique : Uttily SAS · Capital 10 000 € · SIREN 987 654 321 · RCS Paris · TVA FR12987654321',
    ),
  );
  lines.push(escapeCsv('Plateforme : Uttily (https://uttily.com) · contact@uttily.com'));
  lines.push('');

  // En-tête légal du partenaire loueur
  const orgTitle = organization.legalForm
    ? `${organization.legalName} (${organization.legalForm})`
    : organization.legalName;
  lines.push(escapeCsv(`Bénéficiaire : ${orgTitle}`));

  const siretRcs = [
    organization.registrationNumber ? `SIRET/SIREN : ${organization.registrationNumber}` : null,
    organization.registryCity ? `RCS : ${organization.registryCity}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (siretRcs) lines.push(escapeCsv(siretRcs));

  const tvaLine = organization.vatNumber
    ? `N° TVA Intracommunautaire : ${organization.vatNumber}`
    : organization.registrationNumber
      ? 'Régime TVA : Franchise en base de TVA (art. 293 B du CGI)'
      : null;
  if (tvaLine) lines.push(escapeCsv(tvaLine));

  const address = [
    organization.registeredOfficeAddress,
    organization.registeredOfficePostalCode,
    organization.registeredOfficeCity,
  ]
    .filter(Boolean)
    .join(' ');
  if (address) lines.push(escapeCsv(`Siège social : ${address}`));
  lines.push('');

  // Synthèse financière de la période
  lines.push(escapeCsv(`Période comptable : ${overview.period.label}`));
  lines.push(escapeCsv(`Devise : ${overview.currency.toUpperCase()}`));
  lines.push(escapeCsv('SYNTHÈSE FINANCIÈRE CONSOLIDÉE'));
  lines.push(
    `${escapeCsv('Chiffre d affaires brut (TTC)')};${formatAmount(overview.sales.grossAmountMinor)}`,
  );
  lines.push(
    `${escapeCsv('Commissions plateforme Uttily')};${formatAmount(overview.commissions.platformAmountMinor)}`,
  );
  lines.push(
    `${escapeCsv('Remboursements & Annulations')};${formatAmount(overview.payments.refundedAmountMinor)}`,
  );
  lines.push(
    `${escapeCsv('Net reversé sur compte bancaire')};${formatAmount(overview.merchant.netAfterCommissionMinor)}`,
  );
  lines.push('');

  // Détail des opérations
  lines.push(escapeCsv('DÉTAIL DES OPÉRATIONS'));
  const headers = [
    'Date',
    'Référence réservation',
    'Type opération',
    'Produit / Équipement',
    'Client',
    'Montant brut (EUR)',
    'Commission Uttily (EUR)',
    'Net reversé (EUR)',
    'Statut',
  ];
  lines.push(headers.join(';'));

  for (const item of overview.activity) {
    const dateFormatted = item.date.toISOString().slice(0, 10);
    const grossEur = formatAmount(item.grossAmountMinor);
    const commEur = formatAmount(item.commissionAmountMinor);
    const netEur = formatAmount(item.netAmountMinor);

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

  // Ajout du BOM UTF-8 (\uFEFF) pour compatibilité automatique Excel
  return '\uFEFF' + lines.join('\r\n');
}
