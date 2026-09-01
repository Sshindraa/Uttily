import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const tokens = readFileSync(new URL('./tokens.css', import.meta.url), 'utf8');

describe('@uttily/ui design tokens', () => {
  it('uses locally served Sora variable with shared role-based typography', () => {
    expect(tokens).toContain("font-family: 'Sora'");
    expect(tokens).toContain("url('/fonts/sora/sora-variable.woff2')");
    expect(tokens).toContain('font-weight: 100 800');
    expect(tokens).toContain('font-display: swap');
    expect(tokens).not.toContain('Switzer');
    expect(tokens).not.toContain('@import');
    for (const role of [
      'font-body',
      'font-ui',
      'text-display',
      'text-control',
      'text-label',
      'text-caption',
      'weight-heading',
      'tracking-heading',
      'leading-display',
      'numerals',
    ]) {
      expect(tokens).toContain(`--ut-${role}:`);
    }
    expect(tokens).toContain('--ut-text-control: var(--ut-text-md)');
    expect(tokens).toContain('--ut-weight-black: var(--ut-weight-bold)');
  });

  it('uses the approved blue-grey brand foundation', () => {
    expect(tokens).toContain('--ut-color-brand-teal: #8cb6bf;');
    expect(tokens).toContain('--ut-color-brand-teal-strong: #7ea3ab;');
    expect(tokens).toContain('--ut-color-brand-mist: #dce9eb;');
    expect(tokens).toContain('--ut-color-brand-white: #ffffff;');
    expect(tokens).toContain('--ut-color-brand-charcoal: #1c2426;');
    expect(tokens).toContain('--ut-color-primary: #465b5f;');
    expect(tokens).toContain('--ut-color-primary-soft: #dce9eb;');
  });

  it('preserves readable foreground/background pairs in light and dark interfaces', () => {
    const luminance = (role: string): number => {
      const hex = tokens.match(new RegExp(`--ut-color-${role}: (#\\w{6});`))?.[1];
      if (!hex) throw new Error(`Missing color: ${role}`);
      const channels = hex
        .slice(1)
        .match(/../g)!
        .map((v) => {
          const channel = parseInt(v, 16) / 255;
          return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
        });
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    const pairs: Array<[string, string, number]> = [
      ['ink', 'surface-raised', 4.5],
      ['ink-muted', 'surface-muted', 4.5],
      ['ink-subtle', 'surface-soft', 4.5],
      ['primary', 'primary-soft', 4.5],
      ['ink-on-dark', 'primary', 4.5],
      ['ink-on-dark', 'primary-strong', 4.5],
      ['on-brand', 'brand-teal', 4.5],
      ['on-brand', 'brand-teal-strong', 4.5],
      ['border-strong', 'surface-soft', 3],
      ['focus', 'surface-soft', 3],
      ['support-subtle', 'support-elevated', 4.5],
      ['support-link', 'support-surface', 4.5],
      ['support-primary-ink', 'support-primary-soft', 4.5],
      ['ink-on-dark', 'support-primary', 4.5],
      ['success-strong', 'success-soft', 4.5],
      ['danger', 'danger-soft', 4.5],
      ['warning-strong', 'warning-soft', 4.5],
    ];
    for (const [foreground, background, minimum] of pairs) {
      const a = luminance(foreground);
      const b = luminance(background);
      expect(
        (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05),
        `${foreground} on ${background}`,
      ).toBeGreaterThanOrEqual(minimum);
    }
  });

  it('does not reintroduce the retired teal or orange brand colors', () => {
    const retiredTeal = ['#0f', '766e'].join('');
    const retiredOrange = ['#ea', '580c'].join('');

    expect(tokens.toLowerCase()).not.toContain(retiredTeal);
    expect(tokens.toLowerCase()).not.toContain(retiredOrange);
    expect(tokens).not.toMatch(/--ut-color-accent(?:-strong|-soft)?:/);
  });

  it('keeps state colors separate from the brand palette', () => {
    expect(tokens).toContain('--ut-color-success: #247a4b;');
    expect(tokens).toContain('--ut-color-warning: #a76414;');
    expect(tokens).toContain('--ut-color-danger: #b42318;');
  });
});
