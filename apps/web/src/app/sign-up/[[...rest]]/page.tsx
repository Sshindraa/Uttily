import { SignUp } from '@clerk/nextjs';
import { ClientShell } from '@/components/shells/client-shell';
import styles from '../../auth-page.module.css';

export default function SignUpPage(): React.ReactElement {
  return (
    <ClientShell
      alternateHref="/sign-in"
      alternateLabel="Déjà un compte ? Se connecter"
      showAuthAction={false}
    >
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="sign-up-title">
          <h1 id="sign-up-title" className={styles.title}>
            Inscription
          </h1>
          <p className={styles.description}>
            Créez votre compte pour réserver ou gérer vos équipements.
          </p>
          <div className={styles.clerk}>
            <SignUp
              appearance={{
                elements: {
                  rootBox: {
                    width: '100%',
                  },
                  cardBox: {
                    width: '100%',
                    boxShadow: 'none',
                    border: 'none',
                  },
                  card: {
                    width: '100%',
                    padding: 0,
                    border: 'none',
                    boxShadow: 'none',
                    background: 'transparent',
                  },
                  header: {
                    display: 'none',
                  },
                },
              }}
            />
          </div>
        </section>
      </main>
    </ClientShell>
  );
}
