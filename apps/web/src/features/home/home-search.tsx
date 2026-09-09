import { SearchIntentBar } from '@/features/search-intent/search-intent-bar';

export function HomeSearch({
  locale,
  middleSlot,
  smartAssistantAfterSearch = false,
}: {
  locale: 'fr' | 'en';
  middleSlot?: React.ReactNode;
  smartAssistantAfterSearch?: boolean;
}): React.ReactElement {
  return (
    <SearchIntentBar
      locale={locale}
      stickyOnScroll
      middleSlot={middleSlot}
      smartAssistantAfterSearch={smartAssistantAfterSearch}
    />
  );
}
