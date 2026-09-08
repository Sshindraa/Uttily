import { SearchIntentBar } from '@/features/search-intent/search-intent-bar';

export function HomeSearch({
  locale,
  middleSlot,
}: {
  locale: 'fr' | 'en';
  middleSlot?: React.ReactNode;
}): React.ReactElement {
  return <SearchIntentBar locale={locale} stickyOnScroll middleSlot={middleSlot} />;
}
