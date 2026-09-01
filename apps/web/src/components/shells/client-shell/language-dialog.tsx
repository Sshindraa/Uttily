'use client';

import { Dialog, Icon, LinkButton } from '@uttily/ui';
import type { AppLocale } from '@/lib/locale';
import styles from './language-dialog.module.css';

export function LanguageDialog({
  open,
  locale,
  onClose,
}: {
  open: boolean;
  locale: AppLocale;
  onClose: () => void;
}): React.JSX.Element {
  const fr = locale === 'fr';
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
      <h3 className={styles.heading}>{fr ? 'Langues disponibles' : 'Available languages'}</h3>
      <div className={styles.languages}>
        {(
          [
            { code: 'fr', label: 'Français' },
            { code: 'en', label: 'English' },
          ] as const
        ).map((language) => (
          <LinkButton
            key={language.code}
            href={language.code === 'fr' ? '/' : '/?lang=en'}
            variant="secondary"
            className={styles.language}
            lang={language.code}
            hrefLang={language.code}
            aria-current={locale === language.code ? 'true' : undefined}
          >
            <span>{language.label}</span>
            {locale === language.code ? <Icon name="check" size={18} /> : null}
          </LinkButton>
        ))}
      </div>
      <p className={styles.note}>
        {fr
          ? 'La langue ne modifie pas les destinations ni les équipements disponibles.'
          : 'Your language does not change the available destinations or equipment.'}
      </p>
    </Dialog>
  );
}
