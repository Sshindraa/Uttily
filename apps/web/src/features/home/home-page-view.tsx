import { Icon } from '@uttily/ui';
import { ScrollReveal } from '@/components/scroll-reveal';
import { FeaturedShowcase } from './featured-showcase';
import { HomeHero } from './home-hero';
import { HowItWorksKeynote } from './how-it-works-keynote';
import { OutdoorBentoGrid } from './outdoor-bento-grid';
import styles from './home-page-view.module.css';

export function HomePageView({ locale }: { locale: 'fr' | 'en' }): React.ReactElement {
  const fr = locale === 'fr';

  return (
    <main className={styles.page} lang={locale}>
      <HomeHero locale={locale} />

      <section
        className={styles.proofSection}
        aria-label={fr ? 'Pourquoi choisir Uttily' : 'Why choose Uttily'}
      >
        <div className={styles.proofGrid}>
          <ScrollReveal as="article" className={styles.proofCard} delay={0} offset={16}>
            <span className={`${styles.proofPill} ${styles.proofPillTeal}`}>
              {fr ? 'Disponibilité réelle' : 'Real availability'}
            </span>
            <span className={styles.proofIcon}>
              <Icon name="check" size={52} />
            </span>
            <h3>
              {fr ? 'Ce que vous réservez vous attend.' : 'What you book is waiting for you.'}
            </h3>
            <p>
              {fr
                ? 'Votre réservation porte sur un exemplaire physique disponible pour vos dates chez le loueur choisi.'
                : 'Your booking is for a physical item available for your dates from the rental partner you choose.'}
            </p>
          </ScrollReveal>

          <ScrollReveal as="article" className={styles.proofCard} delay={90} offset={16}>
            <span className={`${styles.proofPill} ${styles.proofPillMist}`}>
              {fr ? 'Loueurs professionnels' : 'Professional rental partners'}
            </span>
            <span className={styles.proofIcon}>
              <Icon name="users" size={52} />
            </span>
            <h3>{fr ? 'Du matériel préparé par des pros.' : 'Equipment prepared by pros.'}</h3>
            <p>
              {fr
                ? 'Retirez votre équipement auprès d’un loueur professionnel local, prêt à vous accueillir.'
                : 'Pick up your equipment from a local professional rental partner, ready to welcome you.'}
            </p>
          </ScrollReveal>

          <ScrollReveal as="article" className={styles.proofCard} delay={180} offset={16}>
            <span className={`${styles.proofPill} ${styles.proofPillSoft}`}>
              {fr ? 'Location à destination' : 'Rental at your destination'}
            </span>
            <span className={styles.proofIcon}>
              <Icon name="pin" size={52} />
            </span>
            <h3>{fr ? 'Louez là où vous allez pratiquer.' : 'Rent where you’ll practice.'}</h3>
            <p>
              {fr
                ? 'Choisissez votre destination, réservez à proximité et récupérez votre matériel sur place.'
                : 'Choose your destination, book nearby and pick up your equipment on site.'}
            </p>
          </ScrollReveal>

          <ScrollReveal as="article" className={styles.proofCard} delay={270} offset={16}>
            <span className={`${styles.proofPill} ${styles.proofPillMuted}`}>
              {fr ? 'Prix transparents' : 'Transparent pricing'}
            </span>
            <span className={styles.proofIcon}>
              <Icon name="wallet" size={52} />
            </span>
            <h3>{fr ? 'Le prix avant la décision.' : 'The price before you decide.'}</h3>
            <p>
              {fr
                ? 'Durée, tarif et conditions sont présentés avant que vous confirmiez votre location.'
                : 'Duration, price and terms are shown before you confirm your rental.'}
            </p>
          </ScrollReveal>
        </div>
      </section>

      <OutdoorBentoGrid locale={locale} />

      <HowItWorksKeynote locale={locale} />

      <FeaturedShowcase locale={locale} />
    </main>
  );
}
