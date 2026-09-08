import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SmartSearchAssistant, formatNaturalDate } from './smart-search-assistant';

describe('SmartSearchAssistant (Naming & UX)', () => {
  it('affiche le libellé fermé "Décrivez votre sortie" avec badge IA discret', () => {
    const html = renderToStaticMarkup(
      <SmartSearchAssistant locale="fr" onApplyProposal={() => {}} />,
    );

    expect(html).toContain('Décrivez votre sortie');
    expect(html).toContain('>IA<');
    expect(html).not.toContain('langage naturel');
    expect(html).not.toContain('Assistant d’Itinéraire');
    expect(html).not.toContain('Recherche compilée');
    expect(html).not.toContain('personne(s)');
  });

  it('affiche la version anglaise correspondante', () => {
    const html = renderToStaticMarkup(
      <SmartSearchAssistant locale="en" onApplyProposal={() => {}} />,
    );

    expect(html).toContain('Describe your trip');
    expect(html).toContain('>IA<');
    expect(html).not.toContain('natural language');
  });

  it('ne contient aucun terme technique d’ingénierie dans l’ensemble de l’interface', () => {
    const html = renderToStaticMarkup(
      <SmartSearchAssistant locale="fr" onApplyProposal={() => {}} />,
    );

    expect(html).not.toContain('compilation');
    expect(html).not.toContain('Recherche compilée');
    expect(html).not.toContain('personne(s)');
    expect(html).not.toContain('Compiler ✨');
    expect(html).not.toContain('assistant intelligent');
    expect(html).not.toContain('langage naturel');
  });
});

describe('formatNaturalDate (Cohérence & Clamping)', () => {
  it('formate une journée unique avec le jour complet en majuscule (FR)', () => {
    // 2026-09-12 avec endDateExclusive = 2026-09-13 (1 journée)
    const formatted = formatNaturalDate('2026-09-12', '2026-09-13', 'fr');
    expect(formatted).toBe('Samedi 12 septembre');
  });

  it('formate une journée unique en anglais (EN)', () => {
    const formatted = formatNaturalDate('2026-09-12', '2026-09-13', 'en');
    expect(formatted).toBe('Saturday, September 12');
  });

  it('formate une plage multi-jours réelle', () => {
    // 2026-09-12 à 2026-09-15 exclusif (12, 13, 14 sept)
    const formatted = formatNaturalDate('2026-09-12', '2026-09-15', 'fr');
    expect(formatted).toContain('12');
    expect(formatted).toContain('14');
    expect(formatted).toContain('–');
  });

  it('ne produit JAMAIS de plage inversée si endDateExclusive est antérieure à startDate', () => {
    // Bug précédent : startDate = 2026-09-12, endDateExclusive = 2026-09-10
    const formatted = formatNaturalDate('2026-09-12', '2026-09-10', 'fr');
    // Doit être clampé sur la journée unique du 12 septembre
    expect(formatted).toBe('Samedi 12 septembre');
    expect(formatted).not.toContain('–');
  });
});


