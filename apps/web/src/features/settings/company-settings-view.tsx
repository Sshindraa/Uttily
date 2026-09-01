import type { OrganizationRecord } from '@uttily/core';
import { Badge, Button, Card, Field, Input } from '@uttily/ui';

export interface CompanySettingsViewProps {
  organization: OrganizationRecord;
  canManage: boolean;
  updateCompany: (formData: FormData) => Promise<void>;
}

export function CompanySettingsView({
  organization,
  canManage,
  updateCompany,
}: CompanySettingsViewProps): React.ReactElement {
  return (
    <div style={containerStyle}>
      <Card
        as="section"
        aria-labelledby="company-heading"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ut-space-5)' }}
      >
        <h2 id="company-heading" style={cardTitleStyle}>
          Identité commerciale
        </h2>

        {canManage ? (
          <form action={updateCompany} style={formStyle}>
            <Field
              label="Nom affiché aux clients (Nom commercial)"
              htmlFor="publicDisplayName"
              help={`Ce nom est affiché sur vos fiches d’offres publiques, dans le tunnel de réservation et sur l’espace locataire. Si non renseigné, la raison sociale (${organization.legalName}) est utilisée par défaut.`}
            >
              <Input
                id="publicDisplayName"
                name="publicDisplayName"
                type="text"
                defaultValue={organization.publicDisplayName ?? ''}
                placeholder={organization.legalName}
              />
            </Field>

            <div style={submitRowStyle}>
              <Button type="submit">Enregistrer les modifications</Button>
            </div>
          </form>
        ) : (
          <div>
            <p style={labelStyle}>Nom affiché aux clients :</p>
            <p style={valueStyle}>{organization.publicDisplayName || organization.legalName}</p>
          </div>
        )}
      </Card>

      <Card
        as="section"
        aria-labelledby="legal-heading"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ut-space-3)' }}
      >
        <h2 id="legal-heading" style={cardTitleStyle}>
          Informations légales et financières
        </h2>
        <p style={helpTextStyle}>
          Ces données sont liées à votre compte de versement bancaire et ne peuvent pas être
          modifiées directement depuis cette interface pour garantir la conformité financière.
        </p>

        <div style={readOnlyGridStyle}>
          <div style={readOnlyItemStyle}>
            <span style={labelStyle}>Raison sociale</span>
            <div style={protectedValueRowStyle}>
              <strong style={valueStyle}>{organization.legalName}</strong>
              <Badge tone="success">🔒 Vérifié</Badge>
            </div>
          </div>

          <div style={readOnlyItemStyle}>
            <span style={labelStyle}>Devise d’opération</span>
            <div style={protectedValueRowStyle}>
              <strong style={valueStyle}>{organization.defaultCurrency}</strong>
              <Badge tone="neutral">🔒 Fixée</Badge>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ut-space-6)',
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: 'var(--ut-text-lg)',
  fontWeight: 'var(--ut-weight-semibold)',
  color: 'var(--ut-color-ink-strong)',
  margin: 0,
};

const helpTextStyle: React.CSSProperties = {
  fontSize: 'var(--ut-text-sm)',
  color: 'var(--ut-color-ink-muted)',
  margin: 0,
  lineHeight: 'var(--ut-leading-relaxed)',
};

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ut-space-5)',
};

const labelStyle: React.CSSProperties = {
  fontSize: 'var(--ut-text-sm)',
  fontWeight: 'var(--ut-weight-semibold)',
  color: 'var(--ut-color-ink-strong)',
};

const valueStyle: React.CSSProperties = {
  fontSize: 'var(--ut-text-md)',
  color: 'var(--ut-color-ink-strong)',
  margin: 0,
};

const submitRowStyle: React.CSSProperties = {
  marginTop: 'var(--ut-space-2)',
};

const readOnlyGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
  gap: 'var(--ut-space-5)',
  marginTop: 'var(--ut-space-2)',
};

const readOnlyItemStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--ut-space-2)',
  padding: 'var(--ut-space-4)',
  backgroundColor: 'var(--ut-color-surface-raised)',
  borderRadius: 'var(--ut-radius-md)',
  border: 'var(--ut-border-thin)',
};

const protectedValueRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--ut-space-3)',
  flexWrap: 'wrap',
};
