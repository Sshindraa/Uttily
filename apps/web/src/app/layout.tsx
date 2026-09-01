import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';
import '@uttily/ui/tokens.css';
import { UTTILY_FONT_FAMILY } from '@/lib/typography';

export const metadata: Metadata = {
  title: 'Uttily',
  description: 'Plateforme B2B2C de location d\u2019équipements.',
};

// Force le rendu dynamique : l'application dépend de Clerk (runtime config)
// et ne peut pas être prerenderée statiquement sans clés valides.
export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <ClerkProvider
      appearance={{
        variables: {
          fontFamily: UTTILY_FONT_FAMILY,
          colorPrimary: 'var(--ut-color-primary)',
          colorText: 'var(--ut-color-ink-strong)',
          colorTextSecondary: 'var(--ut-color-ink-muted)',
          colorBackground: 'var(--ut-color-surface)',
          colorInputBackground: 'var(--ut-color-surface)',
          colorInputText: 'var(--ut-color-ink-strong)',
          colorDanger: 'var(--ut-color-danger)',
          colorNeutral: 'var(--ut-color-ink-strong)',
        },
      }}
    >
      <html lang="fr">
        <head>
          <link
            rel="preload"
            href="/fonts/sora/sora-variable.woff2"
            as="font"
            type="font/woff2"
            crossOrigin="anonymous"
          />
        </head>
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
