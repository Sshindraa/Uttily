import { SignUp } from '@clerk/nextjs';
import { ClientShell } from '@/components/client-shell';
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
            <SignUp />
          </div>
        </section>
      </main>
    </ClientShell>
  );
}
