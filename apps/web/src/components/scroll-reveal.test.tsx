import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScrollReveal } from './scroll-reveal';

describe('ScrollReveal', () => {
  it('applies default offset 16px and blur 0px without blur artifacts', () => {
    const html = renderToStaticMarkup(
      <ScrollReveal>
        <p>Default Content</p>
      </ScrollReveal>,
    );

    expect(html).toContain('Default Content');
    expect(html).toContain('--reveal-offset:16px');
    expect(html).toContain('--reveal-blur:0px');
    expect(html).toContain('--reveal-duration:650ms');
  });

  it('renders children with appropriate classes and custom attributes in SSR', () => {
    const html = renderToStaticMarkup(
      <ScrollReveal as="article" className="test-card" delay={120} offset={30} blur={10}>
        <h3>Test Heading</h3>
      </ScrollReveal>,
    );

    expect(html).toContain('test-card');
    expect(html).toContain('Test Heading');
    expect(html).toContain('<article');
    expect(html).toContain('--reveal-delay:120ms');
    expect(html).toContain('--reveal-offset:30px');
    expect(html).toContain('--reveal-blur:10px');
  });
});
