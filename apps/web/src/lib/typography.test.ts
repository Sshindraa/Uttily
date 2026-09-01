import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { getEmbeddedFonts, PAYMENT_APPEARANCE, UTTILY_FONT_FAMILY } from './typography';

describe('Sora typography integration', () => {
  it('ships the original local WOFF2 with its redistribution license', () => {
    const font = readFileSync(
      new URL('../../public/fonts/sora/sora-variable.woff2', import.meta.url),
    );
    expect(font.subarray(0, 4).toString()).toBe('wOF2');
    expect(font.length).toBe(55932);
    expect(
      readFileSync(new URL('../../public/fonts/sora/OFL.txt', import.meta.url), 'utf8'),
    ).toContain('SIL OPEN FONT LICENSE');
  });

  it('gives embedded providers an absolute same-origin font stylesheet without secrets', () => {
    expect(getEmbeddedFonts('https://uttily.example')).toEqual([
      { cssSrc: 'https://uttily.example/fonts/sora/sora.css' },
    ]);
    expect(getEmbeddedFonts('http://localhost:3000')).toEqual([
      { cssSrc: 'http://localhost:3000/fonts/sora/sora.css' },
    ]);
    expect(getEmbeddedFonts()).toEqual([]);
    expect(PAYMENT_APPEARANCE.variables?.fontFamily).toBe(UTTILY_FONT_FAMILY);
    expect(PAYMENT_APPEARANCE.variables?.fontSizeBase).toBe('16px');
    const config = readFileSync(new URL('../../next.config.mjs', import.meta.url), 'utf8');
    expect(config).toContain("source: '/fonts/sora/:path*'");
    expect(config).toContain("key: 'Access-Control-Allow-Origin', value: '*'");
  });

  it('wires Sora to Clerk and both payment flows without changing payment options', () => {
    const layout = readFileSync(new URL('../app/layout.tsx', import.meta.url), 'utf8');
    expect(layout).toContain('fontFamily: UTTILY_FONT_FAMILY');
    expect(layout).toContain('rel="preload"');
    for (const file of ['checkout-client.tsx', 'supplement-checkout-client.tsx']) {
      const source = readFileSync(new URL(`../features/checkout/${file}`, import.meta.url), 'utf8');
      expect(source).toContain('appearance: getPaymentAppearance()');
      expect(source).toContain('fonts: getEmbeddedFonts()');
      expect(source).toContain('clientSecret,');
    }
    const connect = readFileSync(
      new URL('../features/finances/finances-hub.tsx', import.meta.url),
      'utf8',
    );
    expect(connect).toContain('fontFamily: UTTILY_FONT_FAMILY');
    expect(connect).toContain('fonts: getEmbeddedFonts()');
  });
});
