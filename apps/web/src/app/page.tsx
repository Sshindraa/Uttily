import { ClientShell } from '@/components/shells/client-shell';
import { HomeNavigation } from '@/components/shells/client-shell/home-navigation';
import { HomePageView } from '@/features/home';

export default async function HomePage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
} = {}): Promise<React.ReactElement> {
  const params = await searchParams;
  const locale = params?.lang === 'en' ? 'en' : 'fr';
  return (
    <ClientShell localeOverride={locale} header={<HomeNavigation locale={locale} sticky={false} />}>
      <HomePageView locale={locale} />
    </ClientShell>
  );
}
