import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SmoothScroll } from './smooth-scroll';

vi.mock('next/navigation', () => ({
  usePathname: () => '/',
}));

describe('SmoothScroll component (Orbix Studio smooth inertial scroll)', () => {
  it('renders children correctly in SSR and static markup', () => {
    const html = renderToStaticMarkup(
      <SmoothScroll>
        <div data-testid="test-content">Contenu de test</div>
      </SmoothScroll>,
    );

    expect(html).toContain('data-testid="test-content"');
    expect(html).toContain('Contenu de test');
  });
});
