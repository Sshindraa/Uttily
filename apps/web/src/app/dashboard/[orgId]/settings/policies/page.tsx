import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getOrganizationById,
  getMembership,
  requireMembership,
  can,
  getCancellationPolicyDefinitions,
  type CancellationPolicyCode,
} from '@uttily/core';
import { updateCancellationPolicyAction } from '@/app/actions/settings';

export default async function PoliciesSettingsPage({
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

  const canManage = can(active.role, 'policy.manage');
  const policyDefinitions = getCancellationPolicyDefinitions();
  const currentPolicyCode = (org.defaultCancellationPolicyCode ??
    'FLEXIBLE') as CancellationPolicyCode;

  async function updatePolicy(formData: FormData) {
    'use server';
    const policyCode = String(formData.get('policyCode') ?? 'FLEXIBLE') as CancellationPolicyCode;
    await updateCancellationPolicyAction(orgId, policyCode);
    redirect(`/dashboard/${orgId}/settings/policies`);
  }

  return (
    <div style={containerStyle}>
      <section aria-labelledby="policy-heading" style={cardStyle}>
        <h2 id="policy-heading" style={cardTitleStyle}>
          Politique d’annulation par défaut
        </h2>
        <p style={helpTextStyle}>
          Choisissez les conditions d’annulation appliquées par défaut à vos équipements.
        </p>

        <div style={warningBannerStyle}>
          <span style={warningIconStyle}>ℹ️</span>
          <p style={warningTextStyle}>
            <strong>Règle d’immuabilité :</strong> Toute modification s’applique uniquement aux
            nouvelles réservations. Les réservations existantes conservent strictement les
            conditions acceptées par le client au moment de son paiement.
          </p>
        </div>

        {canManage ? (
          <form action={updatePolicy} style={formStyle}>
            <div style={policiesGridStyle}>
              {policyDefinitions.map((def) => {
                const isSelected = def.code === currentPolicyCode;
                return (
                  <label
                    key={def.code}
                    style={isSelected ? selectedPolicyCardStyle : policyCardStyle}
                  >
                    <div style={policyHeaderStyle}>
                      <input
                        type="radio"
                        name="policyCode"
                        value={def.code}
                        defaultChecked={isSelected}
                        style={radioInputStyle}
                      />
                      <div>
                        <strong style={policyTitleStyle}>{def.title}</strong>
                        <p style={policySummaryStyle}>{def.summary}</p>
                      </div>
                    </div>

                    <ul style={rulesListStyle}>
                      {def.rules.map((rule, idx) => (
                        <li key={idx} style={ruleItemStyle}>
                          {rule}
                        </li>
                      ))}
                    </ul>
                  </label>
                );
              })}
            </div>

            <div style={submitRowStyle}>
              <button type="submit" style={primaryButtonStyle}>
                Enregistrer la politique d’annulation
              </button>
            </div>
          </form>
        ) : (
          <div style={policiesGridStyle}>
            {policyDefinitions.map((def) => {
              const isSelected = def.code === currentPolicyCode;
              return (
                <div key={def.code} style={isSelected ? selectedPolicyCardStyle : policyCardStyle}>
                  <div style={policyHeaderStyle}>
                    <span style={isSelected ? activeDotStyle : inactiveDotStyle} />
                    <div>
                      <strong style={policyTitleStyle}>{def.title}</strong>
                      <p style={policySummaryStyle}>{def.summary}</p>
                    </div>
                  </div>

                  <ul style={rulesListStyle}>
                    {def.rules.map((rule, idx) => (
                      <li key={idx} style={ruleItemStyle}>
                        {rule}
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })}
          </div>
        )}
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

const warningBannerStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  padding: '1rem',
  backgroundColor: '#eff6ff',
  borderRadius: '8px',
  border: '1px solid #bfdbfe',
  marginBottom: '1.5rem',
};

const warningIconStyle: React.CSSProperties = {
  fontSize: '1.25rem',
};

const warningTextStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#1e40af',
  margin: 0,
  lineHeight: 1.4,
};

const formStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const policiesGridStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '1rem',
};

const policyCardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  padding: '1.25rem',
  borderRadius: '8px',
  border: '1px solid #e2e8f0',
  backgroundColor: '#f8fafc',
  cursor: 'pointer',
};

const selectedPolicyCardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  padding: '1.25rem',
  borderRadius: '8px',
  border: '2px solid #2563eb',
  backgroundColor: '#f0f7ff',
  cursor: 'pointer',
};

const policyHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: '0.75rem',
};

const radioInputStyle: React.CSSProperties = {
  marginTop: '0.25rem',
  cursor: 'pointer',
};

const policyTitleStyle: React.CSSProperties = {
  fontSize: '1rem',
  color: '#0f172a',
};

const policySummaryStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#475569',
  margin: '0.15rem 0 0',
};

const rulesListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: '2.25rem',
  fontSize: '0.8rem',
  color: '#64748b',
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const ruleItemStyle: React.CSSProperties = {
  lineHeight: 1.35,
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

const activeDotStyle: React.CSSProperties = {
  width: '10px',
  height: '10px',
  borderRadius: '50%',
  backgroundColor: '#2563eb',
  marginTop: '0.4rem',
};

const inactiveDotStyle: React.CSSProperties = {
  width: '10px',
  height: '10px',
  borderRadius: '50%',
  backgroundColor: '#cbd5e1',
  marginTop: '0.4rem',
};
