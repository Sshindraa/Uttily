import { Button, Card, LinkButton, PageHeader } from '@uttily/ui';
import { LocationFormFields } from './location-form-fields';

export interface NewLocationViewProps {
  organizationId: string;
  createLocation: (formData: FormData) => void | Promise<void>;
}

export function NewLocationView({
  organizationId,
  createLocation,
}: NewLocationViewProps): React.ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--ut-space-8)',
        margin: '0 auto',
        maxWidth: '64rem',
      }}
    >
      <PageHeader
        eyebrow="Points de vente & ateliers"
        title="Nouvel établissement"
        description="Ajoutez un point de retrait avec ses horaires, consignes et coordonnées publiques."
        actions={
          <LinkButton href={`/dashboard/${organizationId}/locations`} variant="secondary">
            Annuler
          </LinkButton>
        }
      />
      <Card as="section" aria-labelledby="location-form-heading">
        <h2 id="location-form-heading" className="sr-only">
          Informations du nouvel établissement
        </h2>
        <form action={createLocation}>
          <LocationFormFields />
          <Button type="submit">Créer l’établissement</Button>
        </form>
      </Card>
    </div>
  );
}
