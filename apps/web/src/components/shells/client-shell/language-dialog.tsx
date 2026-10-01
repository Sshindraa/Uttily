'use client';

import { Dialog, Icon, LinkButton } from '@uttily/ui';
import type { AppLocale } from '@/lib/locale';
import styles from './language-dialog.module.css';

interface LanguageOption {
  code: 'fr' | 'en';
  label: string;
  region: string;
  flag: string;
}

export function LanguageDialog({
  open,
  locale,
  onClose,
  alternateHref,
}: {
  open: boolean;
  locale: AppLocale;
  onClose: () => void;
  alternateHref?: string | undefined;
}): React.JSX.Element {
  const fr = locale === 'fr';

  const languages: readonly LanguageOption[] = [
    {
      code: 'fr',
      label: 'Français',
      region: fr ? 'France · Métropolitaine' : 'France · Domestic',
      flag: '🇫🇷',
    },
    {
      code: 'en',
      label: 'English',
      region: fr ? 'International · Monde' : 'International · Global',
      flag: '🇬🇧',
    },
  ];

  return (
    <Dialog
      open={open}
      nativeModal
      className={styles.dialog}
      title={fr ? 'Personnalisez votre expérience' : 'Personalize your experience'}
      closeLabel={fr ? 'Fermer' : 'Close'}
      onClose={onClose}
    >
      <p className={styles.description}>
        {fr
          ? 'Choisissez la langue d’affichage d’Uttily.'
          : 'Choose your display language for Uttily.'}
      </p>

      <div className={styles.languagesList} role="list">
        {languages.map((language) => {
          const isCurrent = locale === language.code;
          const targetHref =
            alternateHref && language.code !== locale
              ? alternateHref
              : language.code === 'fr'
                ? '/'
                : '/?lang=en';

          return (
            <LinkButton
              key={language.code}
              href={targetHref}
              variant="secondary"
              className={`${styles.languageCard} ${isCurrent ? styles.languageCardActive : ''}`}
              lang={language.code}
              hrefLang={language.code}
              aria-current={isCurrent ? 'true' : undefined}
            >
              <div className={styles.cardContent}>
                <span className={styles.flagBadge} aria-hidden="true">
                  {language.flag}
                </span>
                <div className={styles.textGroup}>
                  <span className={styles.langName}>{language.label}</span>
                  <span className={styles.langRegion}>{language.region}</span>
                </div>
              </div>

              <div className={styles.statusIndicator} aria-hidden="true">
                {isCurrent ? (
                  <span className={styles.checkCircle}>
                    <Icon name="check" size={13} />
                  </span>
                ) : (
                  <span className={styles.radioCircle} />
                )}
              </div>
            </LinkButton>
          );
        })}
      </div>

      <div className={styles.footnote}>
        <span className={styles.footnoteIcon} aria-hidden="true">
          <Icon name="globe" size={15} />
        </span>
        <p className={styles.footnoteText}>
          {fr
            ? 'La langue ne modifie pas les destinations ni les équipements disponibles.'
            : 'Your language does not change the available destinations or equipment.'}
        </p>
      </div>
    </Dialog>
  );
}

