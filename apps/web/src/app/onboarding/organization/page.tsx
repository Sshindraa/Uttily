import { redirect } from 'next/navigation';
import { createOrganizationAction } from '@/app/actions/organizations';
import { getAuthenticatedUser } from '@/lib/auth';
import { MVP_ORGANIZATION_CURRENCY } from '@uttily/core';
import Link from 'next/link';
import styles from './page.module.css';

export default async function OnboardingOrganizationPage(): Promise<React.ReactElement> {
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in?redirect_url=%2Fonboarding%2Forganization');

  async function createOrganization(formData: FormData) {
    'use server';
    const legalName = String(formData.get('legalName') ?? '');
    const slugRaw = String(formData.get('slug') ?? '');
    const defaultCurrency = String(formData.get('defaultCurrency') ?? MVP_ORGANIZATION_CURRENCY);
    const payload: Parameters<typeof createOrganizationAction>[0] = { legalName, defaultCurrency };
    if (slugRaw) payload.slug = slugRaw;
    const { organization } = await createOrganizationAction(payload);
    redirect(`/dashboard/${organization.id}`);
  }

  return (
    <main className={styles.page}>
      <section className={styles.card} aria-labelledby="onboarding-heading">
        <div className={styles.eyebrow}>Uttily Pro</div>
        <h1 id="onboarding-heading">Créez votre espace loueur</h1>
        <p className={styles.intro}>
          Vous êtes connecté en tant que <strong>{user.email}</strong>. Commencez par renseigner
          votre entreprise pour accéder à votre tableau de bord.
        </p>

        <ol className={styles.steps} aria-label="Étapes de démarrage">
          <li className={styles.stepActive}>
            <span>1</span>
            <div>
              <strong>Créer votre organisation</strong>
              <small>Quelques informations suffisent pour commencer.</small>
            </div>
          </li>
          <li>
            <span>2</span>
            <div>
              <strong>Configurer votre activité</strong>
              <small>Ajoutez ensuite vos établissements et vos équipements.</small>
            </div>
          </li>
        </ol>

        <form action={createOrganization} className={styles.form}>
          <div className={styles.fieldGroup}>
            <label htmlFor="legalName">Raison sociale</label>
            <input
              id="legalName"
              name="legalName"
              type="text"
              placeholder="Ex. Les vélos du lac"
              autoComplete="organization"
              required
              minLength={2}
            />
          </div>

          <div className={styles.fieldGroup}>
            <label htmlFor="slug">Identifiant public (optionnel)</label>
            <input
              id="slug"
              name="slug"
              type="text"
              placeholder="ex-les-velos-du-lac"
              pattern="[a-z0-9-]+"
              autoComplete="off"
              aria-describedby="slug-help"
            />
            <p id="slug-help">Utilisez uniquement des lettres minuscules, chiffres et tirets.</p>
          </div>

          <div className={styles.fieldGroup}>
            <label htmlFor="defaultCurrency">Devise</label>
            <input
              id="defaultCurrency"
              name="defaultCurrency"
              type="text"
              defaultValue={MVP_ORGANIZATION_CURRENCY}
              maxLength={3}
              readOnly
              aria-describedby="currency-help"
            />
            <p id="currency-help">
              Le pilote Uttily utilise l’EUR uniquement. La multi-devise sera ajoutée
              ultérieurement.
            </p>
          </div>

          <button type="submit" className={styles.submitButton}>
            Créer mon espace loueur
          </button>
        </form>

        <Link href="/" className={styles.homeLink}>
          Retour à l’accueil
        </Link>
      </section>
    </main>
  );
}
