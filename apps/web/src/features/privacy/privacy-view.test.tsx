import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { PrivacyView } from './privacy-view';

vi.mock('@clerk/nextjs', () => ({
  useClerk: () => ({
    signOut: vi.fn(),
  }),
}));

vi.mock('@/app/actions/privacy', () => ({
  submitPrivacyRequestAction: vi.fn(),
  eraseMyAccountAction: vi.fn(),
}));

describe('PrivacyView (Lot 21-P2 - PRIVACY-ERASURE)', () => {
  it('affiche le formulaire RGPD et la zone de danger d’effacement en français', () => {
    const html = renderToStaticMarkup(<PrivacyView locale="fr" requests={[]} />);

    expect(html).toContain('Confidentialité et données personnelles');
    expect(html).toContain('Zone de danger · Suppression définitive du compte');
    expect(html).toContain('Garanties légales probatoires (DPO-003 / DPO-004)');
    expect(html).toContain('Supprimer définitivement mon compte (Art. 17)');
    expect(html).toContain('Télécharger vos données');
  });

  it('affiche la zone de danger d’effacement en anglais', () => {
    const html = renderToStaticMarkup(<PrivacyView locale="en" requests={[]} />);

    expect(html).toContain('Privacy and personal data');
    expect(html).toContain('Danger Zone · Permanent Account Deletion');
    expect(html).toContain('Statutory evidentiary safeguards (DPO-003 / DPO-004)');
    expect(html).toContain('Permanently delete my account (Art. 17)');
  });
});
