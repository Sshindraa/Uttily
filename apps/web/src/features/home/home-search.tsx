import { SearchIntentBar } from '@/features/search-intent/search-intent-bar';

export function HomeSearch({ locale }: { locale: 'fr' | 'en' }): React.ReactElement {
  return <SearchIntentBar locale={locale} stickyOnScroll />;
}
