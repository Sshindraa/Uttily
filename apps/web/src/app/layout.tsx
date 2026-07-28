import { ClerkProvider } from '@clerk/nextjs';
import type { Metadata } from 'next';

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
    <ClerkProvider>
      <html lang="fr">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
