import { notFound } from 'next/navigation';
import { ClientShell } from '@/components/client-shell';

export default async function AccountLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}): Promise<React.ReactElement> {
  const { locale: rawLocale } = await params;
  if (rawLocale !== 'fr' && rawLocale !== 'en') notFound();
  const locale = rawLocale;

  return (
    <div lang={locale}>
      <ClientShell localeOverride={locale}>{children}</ClientShell>
    </div>
  );
}
