import type { Appearance } from '@stripe/stripe-js';

// Embedded providers cannot inherit the host page's CSS variables or font faces.
export const UTTILY_FONT_FAMILY = 'Sora, system-ui, sans-serif';

export const PAYMENT_APPEARANCE: Appearance = {
  theme: 'stripe',
  variables: {
    fontFamily: UTTILY_FONT_FAMILY,
    fontSizeBase: '16px',
    fontSizeSm: '14px',
    fontWeightNormal: '400',
    fontWeightMedium: '500',
    fontWeightBold: '600',
    fontLineHeight: '1.5',
  },
};

/** Embedded frames need resolved colors: CSS custom properties cannot cross an iframe. */
export function getEmbeddedColors(): {
  colorPrimary?: string;
  colorBackground?: string;
  colorText?: string;
  colorDanger?: string;
} {
  if (typeof window === 'undefined') return {};
  const styles = window.getComputedStyle(document.documentElement);
  const colorTokens = {
    colorPrimary: '--ut-color-primary',
    colorBackground: '--ut-color-surface',
    colorText: '--ut-color-ink-strong',
    colorDanger: '--ut-color-danger',
  };
  return Object.fromEntries(
    Object.entries(colorTokens).flatMap(([name, token]) => {
      const value = styles.getPropertyValue(token).trim();
      return value ? [[name, value]] : [];
    }),
  );
}

export function getPaymentAppearance(): Appearance {
  return {
    ...PAYMENT_APPEARANCE,
    variables: { ...PAYMENT_APPEARANCE.variables, ...getEmbeddedColors() },
  };
}

/** Font loading only; no payment request or credential is involved. */
export function getEmbeddedFonts(origin?: string): Array<{ cssSrc: string }> {
  const resolvedOrigin =
    origin ?? (typeof window === 'undefined' ? undefined : window.location.origin);
  return resolvedOrigin ? [{ cssSrc: new URL('/fonts/sora/sora.css', resolvedOrigin).href }] : [];
}
