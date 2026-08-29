import Link from 'next/link';
import { Card, Icon, LinkButton } from '@uttily/ui';
import { ClientShell } from '@/components/client-shell';
import styles from './home.module.css';

export default function HomePage(): React.ReactElement {
  return (
    <ClientShell>
      <main className={styles.page}>
        <section className={styles.hero} aria-labelledby="home-heading">
          <div className={styles.heroCopy}>
            <p className={styles.eyebrow}>Location locale · Matériel professionnel</p>
            <h1 id="home-heading">Le bon équipement, au bon endroit.</h1>
            <p className={styles.heroText}>
              Trouvez et réservez du matériel de qualité auprès de loueurs professionnels certifiés.
              Des disponibilités garanties en temps réel et des prix transparents.
            </p>
            <div className={styles.heroActions}>
              <LinkButton href="/fr/search" size="lg">
                Trouver un équipement <Icon name="arrow-right" size={19} />
              </LinkButton>
              <Link href="/sign-in" className={styles.textLink}>
                Vous êtes loueur professionnel ? <Icon name="arrow-right" size={16} />
              </Link>
            </div>
          </div>

          <Card
            as="aside"
            style={{
              background: 'var(--ut-color-ink-strong)',
              border: 0,
              color: 'white',
              padding: 'var(--ut-space-8)',
            }}
          >
            <p className={styles.cardEyebrow}>Votre location commence ici</p>
            <div className={styles.searchPreview}>
              <div>
                <Icon name="pin" size={19} />
                <span>Destination</span>
                <strong>Au plus près de vos besoins</strong>
              </div>
              <div>
                <Icon name="calendar" size={19} />
                <span>Dates</span>
                <strong>À la journée ou à l’heure</strong>
              </div>
              <div>
                <Icon name="bike" size={19} />
                <span>Équipement</span>
                <strong>Vélos électriques, VTT, ville &amp; route</strong>
              </div>
            </div>
            <LinkButton
              href="/fr/search"
              variant="primary"
              style={{ background: 'var(--ut-color-accent)', width: '100%' }}
            >
              Explorer les disponibilités <Icon name="arrow-right" size={18} />
            </LinkButton>
          </Card>
        </section>

        <section className={styles.howItWorks} aria-labelledby="how-it-works-heading">
          <div className={styles.sectionHeader}>
            <p className={styles.eyebrow}>Simple et transparent</p>
            <h2 id="how-it-works-heading">Comment fonctionne Uttily</h2>
          </div>
          <div className={styles.stepsGrid}>
            <Card className={styles.stepCard}>
              <div className={styles.stepNumber}>1</div>
              <h3>Choisissez votre équipement</h3>
              <p>
                Indiquez votre destination et vos dates pour accéder aux vélos et matériels
                réellement disponibles.
              </p>
            </Card>
            <Card className={styles.stepCard}>
              <div className={styles.stepNumber}>2</div>
              <h3>Réservez en ligne</h3>
              <p>
                Votre équipement est immédiatement réservé et bloqué. Le paiement sécurisé confirme
                votre créneau.
              </p>
            </Card>
            <Card className={styles.stepCard}>
              <div className={styles.stepNumber}>3</div>
              <h3>Retirez sur place</h3>
              <p>
                Rendez-vous chez le loueur professionnel partenaire aux horaires choisis pour
                récupérer votre matériel préparé.
              </p>
            </Card>
          </div>
        </section>

        <section className={styles.valueGrid} aria-label="Pourquoi choisir Uttily">
          <Card>
            <span className={styles.valueIcon}>
              <Icon name="check" size={19} />
            </span>
            <h2>Disponibilité réelle garantie</h2>
            <p>
              Chaque réservation est adossée à un exemplaire physique vérifié. Pas de surbooking.
            </p>
          </Card>
          <Card>
            <span className={styles.valueIcon}>
              <Icon name="pin" size={19} />
            </span>
            <h2>Loueurs professionnels</h2>
            <p>
              Des magasins spécialisés et des ateliers partenaires locaux assurant un accueil et un
              service de qualité.
            </p>
          </Card>
          <Card>
            <span className={styles.valueIcon}>
              <Icon name="calendar" size={19} />
            </span>
            <h2>Transparence totale</h2>
            <p>
              Tarifs nets, politique d’annulation claire et récapitulatif détaillé avant tout
              paiement.
            </p>
          </Card>
        </section>
      </main>
    </ClientShell>
  );
}
