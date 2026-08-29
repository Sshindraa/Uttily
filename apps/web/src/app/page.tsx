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
            <p className={styles.eyebrow}>Louer localement, simplement</p>
            <h1 id="home-heading">Le bon équipement, au bon endroit.</h1>
            <p className={styles.heroText}>
              Trouvez du matériel fiable auprès de loueurs professionnels, avec des dates et un lieu
              clairs dès le départ.
            </p>
            <div className={styles.heroActions}>
              <LinkButton href="/fr/search" size="lg">
                Trouver un équipement <Icon name="arrow-right" size={19} />
              </LinkButton>
              <Link href="/sign-in" className={styles.textLink}>
                Je suis loueur <Icon name="arrow-right" size={16} />
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
            <p className={styles.cardEyebrow}>Votre recherche commence ici</p>
            <div className={styles.searchPreview}>
              <div>
                <Icon name="pin" size={19} />
                <span>Destination</span>
                <strong>Près de chez vous</strong>
              </div>
              <div>
                <Icon name="calendar" size={19} />
                <span>Dates</span>
                <strong>Selon votre projet</strong>
              </div>
              <div>
                <Icon name="bike" size={19} />
                <span>Équipement</span>
                <strong>Pour chaque besoin</strong>
              </div>
            </div>
            <LinkButton
              href="/fr/search"
              variant="primary"
              style={{ background: 'var(--ut-color-accent)', width: '100%' }}
            >
              Lancer une recherche <Icon name="arrow-right" size={18} />
            </LinkButton>
          </Card>
        </section>

        <section className={styles.valueGrid} aria-label="Pourquoi Uttily">
          <Card>
            <span className={styles.valueIcon}>
              <Icon name="check" size={19} />
            </span>
            <h2>Disponibilité réelle</h2>
            <p>Réservez un exemplaire physiquement disponible aux dates choisies.</p>
          </Card>
          <Card>
            <span className={styles.valueIcon}>
              <Icon name="pin" size={19} />
            </span>
            <h2>Près de votre destination</h2>
            <p>Des loueurs professionnels et des points de retrait clairement indiqués.</p>
          </Card>
          <Card>
            <span className={styles.valueIcon}>
              <Icon name="calendar" size={19} />
            </span>
            <h2>Des informations claires</h2>
            <p>Prix, durée et conditions présentés avant de confirmer votre location.</p>
          </Card>
        </section>
      </main>
    </ClientShell>
  );
}
