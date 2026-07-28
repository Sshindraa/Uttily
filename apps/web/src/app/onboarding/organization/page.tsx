import { redirect } from 'next/navigation';
import { createOrganizationAction } from '@/app/actions/organizations';

export default function OnboardingOrganizationPage(): React.ReactElement {
  async function createOrganization(formData: FormData) {
    'use server';
    const legalName = String(formData.get('legalName') ?? '');
    const slugRaw = String(formData.get('slug') ?? '');
    const defaultCurrency = String(formData.get('defaultCurrency') ?? 'EUR');
    const payload: Parameters<typeof createOrganizationAction>[0] = { legalName, defaultCurrency };
    if (slugRaw) payload.slug = slugRaw;
    await createOrganizationAction(payload);
    redirect('/dashboard');
  }

  return (
    <main>
      <h1>Créer une organisation</h1>
      <form action={createOrganization}>
        <label htmlFor="legalName">Raison sociale</label>
        <input id="legalName" name="legalName" type="text" required minLength={2} />

        <label htmlFor="slug">Slug (optionnel)</label>
        <input id="slug" name="slug" type="text" pattern="[a-z0-9-]+" />

        <label htmlFor="defaultCurrency">Devise</label>
        <input
          id="defaultCurrency"
          name="defaultCurrency"
          type="text"
          defaultValue="EUR"
          maxLength={3}
        />

        <button type="submit">Créer</button>
      </form>
    </main>
  );
}
