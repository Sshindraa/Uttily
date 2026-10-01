import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { HomePageView } from './home-page-view';

vi.mock('@/app/actions/home-search-options', () => ({ loadHomeSearchOptions: vi.fn() }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

describe('Homepage proof grid', () => {
  it('presents four Uttily-specific reasons to rent', () => {
    const html = renderToStaticMarkup(<HomePageView locale="fr" />);

    expect(html).not.toContain('Simple et transparent');
    expect(html).not.toContain('Comment fonctionne Uttily');
    expect(html).not.toContain('Louer sans friction');
    expect(html).not.toContain('Le bon équipement, au bon endroit.');
    expect(html).not.toContain('Uttily relie votre sortie');
    expect(html).toContain('Disponibilité réelle');
    expect(html).toContain('Ce que vous réservez vous attend.');
    expect(html).toContain(
      'Votre réservation porte sur un exemplaire physique disponible pour vos dates chez le loueur choisi.',
    );
    expect(html).toContain('Loueurs professionnels');
    expect(html).toContain('Du matériel préparé par des pros.');
    expect(html).toContain('Location à destination');
    expect(html).toContain('Louez là où vous allez pratiquer.');
    expect(html).toContain('Prix transparents');
    expect(html).toContain('Le prix avant la décision.');
    expect(html.match(/class="[^"]*proofCard/g)).toHaveLength(4);
  });

  it('keeps the proof grid translated in English', () => {
    const html = renderToStaticMarkup(<HomePageView locale="en" />);

    expect(html).not.toContain('Simple and transparent');
    expect(html).not.toContain('How Uttily works');
    expect(html).not.toContain('Rent without friction');
    expect(html).not.toContain('The right equipment, in the right place.');
    expect(html).toContain('Real availability');
    expect(html).toContain('What you book is waiting for you.');
    expect(html).toContain(
      'Your booking is for a physical item available for your dates from the rental partner you choose.',
    );
    expect(html).toContain('Professional rental partners');
    expect(html).toContain('Equipment prepared by pros.');
    expect(html).toContain('Rental at your destination');
    expect(html).toContain('Rent where you’ll practice.');
    expect(html).toContain('Transparent pricing');
    expect(html).toContain('The price before you decide.');
  });

  it('integrates the outdoor bento grid destinations section', () => {
    const html = renderToStaticMarkup(<HomePageView locale="fr" />);
    expect(html).toContain('Destinations &amp; Univers');
    expect(html).toContain('Chamonix &amp; Mont-Blanc');
    expect(html).toContain('Pays Basque &amp; Landes');
    expect(html).toContain('Annecy &amp; Eaux Cristallines');
    expect(html).toContain('14 loueurs pros prêts');
    expect(html).toContain('Dispo aujourd’hui');
  });
});
