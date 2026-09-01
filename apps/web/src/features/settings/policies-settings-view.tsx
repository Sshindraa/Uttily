import type { CancellationPolicyCode, CancellationPolicyDescription } from '@uttily/core';
import { Button, Card } from '@uttily/ui';

export interface PoliciesSettingsViewProps {
  canManage: boolean;
  currentPolicyCode: CancellationPolicyCode;
  policyDefinitions: readonly CancellationPolicyDescription[];
  updatePolicy: (formData: FormData) => Promise<void>;
}

export function PoliciesSettingsView({
  canManage,
  currentPolicyCode,
  policyDefinitions,
  updatePolicy,
}: PoliciesSettingsViewProps): React.ReactElement {
  return (
    <div style={containerStyle}>
      <Card
        as="section"
        aria-labelledby="policy-heading"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ut-space-5)' }}
      >
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
              <Button type="submit">Enregistrer la politique d’annulation</Button>
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
  fontSize: '1.15rem',
  fontWeight: 'var(--ut-weight-semibold)',
  color: 'var(--ut-color-ink-strong)',
  margin: '0 0 0.5rem',
};

const helpTextStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: 'var(--ut-color-ink-muted)',
  margin: '0 0 1rem',
  lineHeight: 1.4,
};

const warningBannerStyle: React.CSSProperties = {
  display: 'flex',
  gap: '0.75rem',
  padding: '1rem',
  backgroundColor: 'var(--ut-color-primary-soft)',
  borderRadius: '8px',
  border: '1px solid var(--ut-color-primary-soft)',
  marginBottom: '1.5rem',
};

const warningIconStyle: React.CSSProperties = {
  fontSize: '1.25rem',
};

const warningTextStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: 'var(--ut-color-primary-strong)',
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
  border: '1px solid var(--ut-color-border)',
  backgroundColor: 'var(--ut-color-surface-raised)',
  cursor: 'pointer',
};

const selectedPolicyCardStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  padding: '1.25rem',
  borderRadius: '8px',
  border: '2px solid var(--ut-color-primary)',
  backgroundColor: 'var(--ut-color-primary-soft)',
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
  color: 'var(--ut-color-ink-strong)',
};

const policySummaryStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: 'var(--ut-color-ink-muted)',
  margin: '0.15rem 0 0',
};

const rulesListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: '2.25rem',
  fontSize: '0.8rem',
  color: 'var(--ut-color-ink-muted)',
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

const activeDotStyle: React.CSSProperties = {
  width: '10px',
  height: '10px',
  borderRadius: '50%',
  backgroundColor: 'var(--ut-color-primary)',
  marginTop: '0.4rem',
};

const inactiveDotStyle: React.CSSProperties = {
  width: '10px',
  height: '10px',
  borderRadius: '50%',
  backgroundColor: 'var(--ut-color-border-strong)',
  marginTop: '0.4rem',
};
