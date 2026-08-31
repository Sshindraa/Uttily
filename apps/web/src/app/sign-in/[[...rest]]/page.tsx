import { SignIn } from '@clerk/nextjs';
import { ClientShell } from '@/components/client-shell';
import styles from '../../auth-page.module.css';

export default function SignInPage(): React.ReactElement {
  return (
    <ClientShell alternateHref="/sign-up" alternateLabel="Créer un compte" showAuthAction={false}>
      <main className={styles.page}>
        <section className={styles.card} aria-labelledby="sign-in-title">
          <h1 id="sign-in-title" className={styles.title}>
            Connexion
          </h1>
          <p className={styles.description}>Accédez à vos réservations et à votre espace loueur.</p>
          <div className={styles.clerk}>
            <SignIn />
          </div>
        </section>
      </main>
    </ClientShell>
  );
}
