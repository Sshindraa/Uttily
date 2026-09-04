import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { CompanySettingsView } from './company-settings-view';
import type { OrganizationRecord } from '@uttily/core';

describe('CompanySettingsView (Lot 21-O1)', () => {
  const baseOrg: OrganizationRecord = {
    id: 'org-1',
    legalName: 'Outdoor Rent SAS',
    publicDisplayName: 'Les Vélos du Lac',
    slug: 'outdoor-rent',
    status: 'ACTIVE',
    isProfessional: true,
    defaultCurrency: 'EUR',
    defaultCancellationPolicyCode: 'FLEXIBLE',
    legalForm: 'SAS',
    registrationNumber: '73282932000074',
    vatNumber: 'FR44732829320',
    registryCity: 'Annecy',
    capitalAmount: '10 000 €',
    legalRepresentativeName: 'Camille Martin',
    registeredOfficeAddress: '15 Quai de la Tournette',
    registeredOfficePostalCode: '74000',
    registeredOfficeCity: 'Annecy',
    registeredOfficeCountryCode: 'FR',
  };

  it('affiche le statut complet et les champs pré-remplis en mode édition', () => {
    const html = renderToStaticMarkup(
      <CompanySettingsView organization={baseOrg} canManage={true} updateCompany={vi.fn()} />,
    );

    expect(html).toContain('Identité juridique et fiscale vérifiée');
    expect(html).toContain('Outdoor Rent SAS');
    expect(html).toContain('73282932000074');
    expect(html).toContain('FR44732829320');
    expect(html).toContain('Annecy');
    expect(html).toContain('Camille Martin');
    expect(html).toContain('Enregistrer les informations légales');
  });

  it('affiche un avertissement quand le SIRET ou le siège social est manquant', () => {
    const incompleteOrg: OrganizationRecord = {
      ...baseOrg,
      registrationNumber: null,
      registeredOfficeCity: null,
    };

    const html = renderToStaticMarkup(
      <CompanySettingsView organization={incompleteOrg} canManage={true} updateCompany={vi.fn()} />,
    );

    expect(html).toContain('Informations d’immatriculation à compléter');
  });

  it('affiche la vue en lecture seule si canManage est faux', () => {
    const html = renderToStaticMarkup(
      <CompanySettingsView organization={baseOrg} canManage={false} updateCompany={vi.fn()} />,
    );

    expect(html).toContain('Fiche légale de l’entreprise');
    expect(html).toContain('73282932000074');
    expect(html).not.toContain('Enregistrer les informations légales');
  });
});
