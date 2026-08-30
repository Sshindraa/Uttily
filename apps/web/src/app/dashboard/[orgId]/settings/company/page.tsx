import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import { getOrganizationById, getMembership, requireMembership, can } from '@uttily/core';
import { updateCompanySettingsAction } from '@/app/actions/settings';

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
      <section aria-labelledby="company-heading" style={cardStyle}>
        <h2 id="company-heading" style={cardTitleStyle}>
          Identité commerciale
        </h2>

        {canManage ? (
          <form action={updateCompany} style={formStyle}>
            <div style={formGroupStyle}>
              <label htmlFor="publicDisplayName" style={labelStyle}>
                Nom affiché aux clients (Nom commercial)
              </label>
              <p style={helpTextStyle}>
                Ce nom est affiché sur vos fiches d’offres publiques, dans le tunnel de réservation
                et sur l’espace locataire. Si non renseigné, la raison sociale ({org.legalName}) est
                utilisée par défaut.
              </p>
              <input
                id="publicDisplayName"
                name="publicDisplayName"
                type="text"
                defaultValue={org.publicDisplayName ?? ''}
                placeholder={org.legalName}
                style={inputStyle}
              />
            </div>

            <div style={submitRowStyle}>
              <button type="submit" style={primaryButtonStyle}>
                Enregistrer les modifications
              </button>
            </div>
          </form>
        ) : (
          <div>
            <p style={labelStyle}>Nom affiché aux clients :</p>
            <p style={valueStyle}>{org.publicDisplayName || org.legalName}</p>
          </div>
        )}
      </section>

      <section aria-labelledby="legal-heading" style={cardStyle}>
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
              <span style={lockedBadgeStyle}>🔒 Vérifié</span>
            </div>
          </div>

          <div style={readOnlyItemStyle}>
            <span style={labelStyle}>Devise d’opération</span>
            <div style={protectedValueRowStyle}>
              <strong style={valueStyle}>{org.defaultCurrency}</strong>
              <span style={lockedBadgeStyle}>🔒 Fixée</span>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const cardStyle: React.CSSProperties = {
  backgroundColor: '#ffffff',
  borderRadius: '12px',
  border: '1px solid #e2e8f0',
  padding: '1.5rem',
  boxShadow: '0 1px 3px rgba(0, 0, 0, 0.05)',
};

const cardTitleStyle: React.CSSProperties = {
  fontSize: '1.15rem',
  fontWeight: 600,
  color: '#0f172a',
  margin: '0 0 0.5rem',
};

const helpTextStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#64748b',
  margin: '0 0 1rem',
  lineHeight: 1.4,
};

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.25rem',
};

const formGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  fontWeight: 600,
  color: '#334155',
};

const valueStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  color: '#0f172a',
  margin: 0,
};

const inputStyle: React.CSSProperties = {
  padding: '0.6rem 0.85rem',
  borderRadius: '6px',
  border: '1px solid #cbd5e1',
  fontSize: '0.95rem',
  maxWidth: '500px',
};

const submitRowStyle: React.CSSProperties = {
  marginTop: '0.5rem',
};

const primaryButtonStyle: React.CSSProperties = {
  padding: '0.6rem 1.25rem',
  backgroundColor: '#2563eb',
  color: '#ffffff',
  border: 'none',
  borderRadius: '6px',
  fontSize: '0.9rem',
  fontWeight: 600,
  cursor: 'pointer',
};

const readOnlyGridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))',
  gap: '1.25rem',
  marginTop: '1rem',
};

const readOnlyItemStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.35rem',
  padding: '1rem',
  backgroundColor: '#f8fafc',
  borderRadius: '8px',
  border: '1px solid #f1f5f9',
};

const protectedValueRowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
};

const lockedBadgeStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  padding: '0.15rem 0.45rem',
  borderRadius: '4px',
  backgroundColor: '#e2e8f0',
  color: '#475569',
  fontWeight: 500,
};
