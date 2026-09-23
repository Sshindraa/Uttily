import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HowItWorksKeynote } from './how-it-works-keynote';

describe('HowItWorksKeynote component', () => {
  it('renders the 3 Keynote steps with user requested wording in French', () => {
    const html = renderToStaticMarkup(<HowItWorksKeynote locale="fr" />);

    // Eyebrow and heading
    expect(html).toContain('Comment ça marche');
    expect(html).toContain('Trois étapes clés,');
    expect(html).toContain('votre matériel prêt sur place.');

    // Step 1: Trouvez votre spot
    expect(html).toContain('Trouvez votre spot');
    expect(html).toContain('Retrait directement au pied des pistes ou en station.');

    // Step 2: Bloquez l’exemplaire physique
    expect(html).toContain('Bloquez l’exemplaire physique');
    expect(html).toContain('Hold garanti sans mauvaise surprise.');

    // Step 3: Partez rider
    expect(html).toContain('Partez rider');
    expect(html).toContain('Matériel vérifié et réglé à votre profil.');

    // Numbers
    expect(html).toContain('01');
    expect(html).toContain('02');
    expect(html).toContain('03');

    // Accessibility ARIA roles
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('role="tabpanel"');

    // Negative assertions from brand guidelines
    expect(html).not.toContain('Comment fonctionne Uttily');
    expect(html).not.toContain('Simple et transparent');
    expect(html).not.toContain('Louer sans friction');
  });

  it('translates all steps and badges into English', () => {
    const html = renderToStaticMarkup(<HowItWorksKeynote locale="en" />);

    expect(html).toContain('How it works');
    expect(html).toContain('Three simple steps,');
    expect(html).toContain('your gear ready on site.');

    expect(html).toContain('Find your spot');
    expect(html).toContain('Direct pickup at the foot of the slopes or in-resort.');

    expect(html).toContain('Lock the physical item');
    expect(html).toContain('Guaranteed hold with zero surprises.');

    expect(html).toContain('Hit the trails &amp; slopes');
    expect(html).toContain('Gear inspected and tuned to your rider profile.');

    expect(html).not.toContain('How Uttily works');
  });
});
