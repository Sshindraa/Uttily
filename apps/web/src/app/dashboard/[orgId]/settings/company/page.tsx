import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getOrganizationById, getMembership, requireMembership, can } from '@uttily/core';
import { updateCompanySettingsAction } from '@/app/actions/settings';
import { Badge, Button, Card, Field, Input } from '@uttily/ui';

export default async function CompanySettingsPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}): Promise<React.ReactElement> {
  const { orgId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');

  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  const active = requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);

  const org = await getOrganizationById(db, orgId);
  if (!org) redirect('/dashboard');

  const canManage = can(active.role, 'organization.manage');

  async function updateCompany(formData: FormData) {
    'use server';
    const publicDisplayName = String(formData.get('publicDisplayName') ?? '');
    await updateCompanySettingsAction(orgId, {
      publicDisplayName: publicDisplayName.trim().length > 0 ? publicDisplayName : null,
    });
    redirect(`/dashboard/${orgId}/settings/company`);
  }

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
              help={`Ce nom est affiché sur vos fiches d’offres publiques, dans le tunnel de réservation et sur l’espace locataire. Si non renseigné, la raison sociale (${org.legalName}) est utilisée par défaut.`}
            >
              <Input
                id="publicDisplayName"
                name="publicDisplayName"
                type="text"
                defaultValue={org.publicDisplayName ?? ''}
                placeholder={org.legalName}
              />
            </Field>

            <div style={submitRowStyle}>
              <Button type="submit">Enregistrer les modifications</Button>
            </div>
          </form>
        ) : (
          <div>
            <p style={labelStyle}>Nom affiché aux clients :</p>
            <p style={valueStyle}>{org.publicDisplayName || org.legalName}</p>
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
              <strong style={valueStyle}>{org.legalName}</strong>
              <Badge tone="success">🔒 Vérifié</Badge>
            </div>
          </div>

          <div style={readOnlyItemStyle}>
            <span style={labelStyle}>Devise d’opération</span>
            <div style={protectedValueRowStyle}>
              <strong style={valueStyle}>{org.defaultCurrency}</strong>
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
