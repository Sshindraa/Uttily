import { Card, Icon } from '@uttily/ui';
import { HomeHero } from './home-hero';
import styles from './home-page-view.module.css';

export function HomePageView({ locale }: { locale: 'fr' | 'en' }): React.ReactElement {
  const fr = locale === 'fr';

  return (
    <main className={styles.page} lang={locale}>
      <HomeHero locale={locale} />

      <section className={styles.howItWorks} aria-labelledby="how-it-works-heading">
        <div className={styles.sectionHeader}>
          <p className={styles.eyebrow}>
            {fr ? 'Simple et transparent' : 'Simple and transparent'}
          </p>
          <h2 id="how-it-works-heading">{fr ? 'Comment fonctionne Uttily' : 'How Uttily works'}</h2>
        </div>
        <div className={styles.stepsGrid}>
          <Card className={styles.stepCard}>
            <div className={styles.stepNumber}>1</div>
            <h3>{fr ? 'Choisissez votre équipement' : 'Choose your equipment'}</h3>
            <p>
              {fr
                ? 'Indiquez votre destination et vos dates pour accéder aux équipements réellement disponibles.'
                : 'Enter your destination and dates to find equipment that is actually available.'}
            </p>
          </Card>
          <Card className={styles.stepCard}>
            <div className={styles.stepNumber}>2</div>
            <h3>{fr ? 'Réservez en ligne' : 'Book online'}</h3>
            <p>
              {fr
                ? 'Votre équipement est bloqué lors de votre commande. Le règlement en ligne confirme votre créneau.'
                : 'Your equipment is held while you book. Online payment confirms your rental slot.'}
            </p>
          </Card>
          <Card className={styles.stepCard}>
            <div className={styles.stepNumber}>3</div>
            <h3>{fr ? 'Retirez sur place' : 'Pick up locally'}</h3>
            <p>
              {fr
                ? 'Rendez-vous chez le loueur professionnel partenaire aux horaires choisis pour récupérer votre matériel préparé.'
                : 'Visit your professional rental partner at the agreed time to collect your prepared equipment.'}
            </p>
          </Card>
        </div>
      </section>

      <section
        className={styles.valueGrid}
        aria-label={fr ? 'Pourquoi choisir Uttily' : 'Why choose Uttily'}
      >
        <Card>
          <span className={styles.valueIcon}>
            <Icon name="check" size={19} />
          </span>
          <h2>{fr ? 'Disponibilité confirmée' : 'Confirmed availability'}</h2>
          <p>
            {fr
              ? 'Le matériel sélectionné est alloué à votre réservation pour la période choisie.'
              : 'Your selected equipment is allocated to your booking for the chosen period.'}
          </p>
        </Card>
        <Card>
          <span className={styles.valueIcon}>
            <Icon name="pin" size={19} />
          </span>
          <h2>{fr ? 'Loueurs professionnels' : 'Professional rental partners'}</h2>
          <p>
            {fr
              ? 'Des magasins spécialisés et des ateliers partenaires locaux assurant un accueil et un service de qualité.'
              : 'Specialist shops and local partner workshops providing a warm welcome and quality service.'}
          </p>
        </Card>
        <Card>
          <span className={styles.valueIcon}>
            <Icon name="calendar" size={19} />
          </span>
          <h2>{fr ? 'Tarifs clairs et détaillés' : 'Clear, detailed pricing'}</h2>
          <p>
            {fr
              ? 'Tarifs nets, conditions d’annulation et récapitulatif présentés avant tout règlement.'
              : 'Prices, cancellation terms and a booking summary are shown before you pay.'}
          </p>
        </Card>
      </section>
    </main>
  );
}
