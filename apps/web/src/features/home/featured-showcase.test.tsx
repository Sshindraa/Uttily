import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeaturedShowcase } from './featured-showcase';

describe('FeaturedShowcase (Orbix Studio style)', () => {
  it('renders all three phone mockups with empty canvas placeholders', () => {
    const html = renderToStaticMarkup(<FeaturedShowcase locale="fr" />);

    // Vérifie la présence des 3 téléphones
    expect(html).toContain('data-testid="phone-mockup-left"');
    expect(html).toContain('data-testid="phone-mockup-center"');
    expect(html).toContain('data-testid="phone-mockup-right"');

    // Vérifie que les 3 téléphones ont bien leur canvas intérieur vide (placeholder)
    expect(html).toContain('data-testid="phone-mockup-left-canvas"');
    expect(html).toContain('data-testid="phone-mockup-center-canvas"');
    expect(html).toContain('data-testid="phone-mockup-right-canvas"');
    expect(html).toContain('Écran disponible');

    // Vérifie les boutons de navigation circulaires (style Orbix)
    expect(html).toContain('data-testid="showcase-prev-btn"');
    expect(html).toContain('data-testid="showcase-next-btn"');
  });

  it('renders signature Orbix header with French translation', () => {
    const html = renderToStaticMarkup(<FeaturedShowcase locale="fr" />);

    expect(html).toContain('Expérience mobile');
    expect(html).toContain('Explorez notre expérience');
    expect(html).toContain('pensée pour le terrain outdoor');
    expect(html).toContain('100%');
    expect(html).toContain('Exemplaires physiques garantis');
    expect(html).toContain('Vélos &amp; VAE · Disponible');
  });

  it('renders signature Orbix header with English translation', () => {
    const html = renderToStaticMarkup(<FeaturedShowcase locale="en" />);

    expect(html).toContain('Featured Experience');
    expect(html).toContain('Explore Our Latest');
    expect(html).toContain('Work Across Industries');
    expect(html).toContain('Guaranteed physical inventory');
    expect(html).toContain('Bikes &amp; e-Bikes · Available');
  });
});
