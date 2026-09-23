import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { OutdoorBentoGrid } from './outdoor-bento-grid';

describe('OutdoorBentoGrid component', () => {
  it('renders all three major outdoor destinations in French with live badges', () => {
    const html = renderToStaticMarkup(<OutdoorBentoGrid locale="fr" />);

    // Destinations and titles
    expect(html).toContain('Chamonix &amp; Mont-Blanc');
    expect(html).toContain('Pays Basque &amp; Landes');
    expect(html).toContain('Annecy &amp; Eaux Cristallines');

    // Live badges specified by the user
    expect(html).toContain('14 loueurs pros prêts');
    expect(html).toContain('Dispo aujourd’hui');
    expect(html).toContain('Retrait sur ponton');
    expect(html).toContain('Hold 15 min garanti');

    // Outdoor universes
    expect(html).toContain('Alpinisme &amp; VTT');
    expect(html).toContain('Surf &amp; Route');
    expect(html).toContain('Paddle &amp; Wingfoil');

    // Search URLs
    expect(html).toContain('href="/fr/search?destination=Chamonix-Mont-Blanc"');
    expect(html).toContain('href="/fr/search?destination=Biarritz"');
    expect(html).toContain('href="/fr/search?destination=Annecy"');

    // Image sources
    expect(html).toContain('%2Fimages%2Fhome%2Fchamonix-mont-blanc.jpg');
    expect(html).toContain('%2Fimages%2Fhome%2Fpays-basque-surf.jpg');
    expect(html).toContain('%2Fimages%2Fhome%2Fannecy-lake.jpg');
  });

  it('translates all content and search links for English locale', () => {
    const html = renderToStaticMarkup(<OutdoorBentoGrid locale="en" />);

    expect(html).toContain('Destinations &amp; Playgrounds');
    expect(html).toContain('The greatest playgrounds,');
    expect(html).toContain('Chamonix &amp; Mont-Blanc');
    expect(html).toContain('Basque Coast &amp; Landes');
    expect(html).toContain('Annecy &amp; Crystal Waters');

    expect(html).toContain('14 pro shops ready');
    expect(html).toContain('Available today');
    expect(html).toContain('Dockside pickup');
    expect(html).toContain('Guaranteed 15 min hold');

    expect(html).toContain('href="/en/search?destination=Chamonix-Mont-Blanc"');
    expect(html).toContain('href="/en/search?destination=Biarritz"');
    expect(html).toContain('href="/en/search?destination=Annecy"');
  });
});
