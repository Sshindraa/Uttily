import { redirect } from 'next/navigation';
import { getAuthenticatedUser } from '@/lib/auth';
import { getDb } from '@/lib/db';
import {
  getLocation,
  getMembership,
  listOpeningHours,
  listLocationScheduleExceptions,
  requireMembership,
  LOCATION_MANAGERS,
} from '@uttily/core';
import {
  updateLocationAction,
  upsertLocationScheduleExceptionAction,
  deleteLocationScheduleExceptionAction,
} from '@/app/actions/locations';
import { LocationFormFields } from '../location-form-fields';
import { parseLocationFormData } from '../location-form';

export default async function EditLocationPage({
  params,
}: {
  params: Promise<{ orgId: string; locationId: string }>;
}): Promise<React.ReactElement> {
  const { orgId, locationId } = await params;
  const user = await getAuthenticatedUser();
  if (!user) redirect('/sign-in');

  const db = getDb();
  const membership = await getMembership(db, orgId, user.id);
  const active = requireMembership(membership, ['OWNER', 'ADMIN', 'MANAGER', 'STAFF']);

  const canManage = LOCATION_MANAGERS.includes(active.role);
  const location = await getLocation(db, orgId, locationId);
  if (!location) redirect(`/dashboard/${orgId}/locations`);

  const openingHours = await listOpeningHours(db, locationId);
  const exceptions = await listLocationScheduleExceptions(db, orgId, locationId);

  async function updateLocation(formData: FormData) {
    'use server';
    await updateLocationAction(orgId, locationId, parseLocationFormData(formData));
    redirect(`/dashboard/${orgId}/locations/${locationId}`);
  }

  async function addException(formData: FormData) {
    'use server';
    const localDate = String(formData.get('localDate') ?? '');
    const kind = String(formData.get('kind') ?? 'CLOSED') as 'CLOSED' | 'OPEN_INTERVAL';
    const openTime = kind === 'OPEN_INTERVAL' ? String(formData.get('openTime') ?? '') : null;
    const closeTime = kind === 'OPEN_INTERVAL' ? String(formData.get('closeTime') ?? '') : null;
    const reason = String(formData.get('reason') ?? '');

    await upsertLocationScheduleExceptionAction({
      organizationId: orgId,
      locationId,
      localDate,
      kind,
      openTime: openTime ? `${openTime}:00` : null,
      closeTime: closeTime ? `${closeTime}:00` : null,
      reason: reason.trim().length > 0 ? reason : null,
    });

    redirect(`/dashboard/${orgId}/locations/${locationId}`);
  }

  async function deleteException(formData: FormData) {
    'use server';
    const exceptionId = String(formData.get('exceptionId') ?? '');
    await deleteLocationScheduleExceptionAction(orgId, locationId, exceptionId);
    redirect(`/dashboard/${orgId}/locations/${locationId}`);
  }

  return (
    <div style={containerStyle}>
      <header style={headerStyle}>
        <div>
          <h1 style={titleStyle}>{location.name}</h1>
          <p style={subtitleStyle}>
            Configurez les informations, coordonnées et horaires d’ouverture de cet établissement.
          </p>
        </div>
      </header>

      <div style={gridStyle}>
        {/* Formulaire principal */}
        <section aria-labelledby="general-heading" style={cardStyle}>
          <h2 id="general-heading" style={cardTitleStyle}>
            Informations et horaires habituels
          </h2>
          {canManage ? (
            <form action={updateLocation} style={formStyle}>
              <LocationFormFields location={location} openingHours={openingHours} />
              <div style={submitRowStyle}>
                <button type="submit" style={primaryButtonStyle}>
                  Enregistrer les modifications
                </button>
              </div>
            </form>
          ) : (
            <p style={mutedTextStyle}>
              Lecture seule. Rôle insuffisant pour modifier cet établissement.
            </p>
          )}
        </section>

        {/* Colonne latérale : Fermetures & Horaires exceptionnels */}
        <aside style={sideColumnStyle}>
          <section aria-labelledby="exceptions-heading" style={cardStyle}>
            <h2 id="exceptions-heading" style={cardTitleStyle}>
              Fermetures et horaires exceptionnels
            </h2>
            <p style={helpTextStyle}>
              Ces exceptions remplacent les horaires habituels pour la date indiquée. Elles bloquent
              ou ajustent les nouvelles réservations sans altérer les réservations confirmées
              existantes.
            </p>

            {canManage && (
              <form action={addException} style={exceptionFormStyle}>
                <div style={formGroupStyle}>
                  <label htmlFor="localDate" style={labelStyle}>
                    Date (AAAA-MM-JJ)
                  </label>
                  <input id="localDate" name="localDate" type="date" required style={inputStyle} />
                </div>

                <div style={formGroupStyle}>
                  <label htmlFor="kind" style={labelStyle}>
                    Type d’exception
                  </label>
                  <select id="kind" name="kind" defaultValue="CLOSED" style={inputStyle}>
                    <option value="CLOSED">Fermé toute la journée</option>
                    <option value="OPEN_INTERVAL">Horaires spéciaux</option>
                  </select>
                </div>

                <div style={hoursRowStyle}>
                  <div style={formGroupStyle}>
                    <label htmlFor="openTime" style={labelStyle}>
                      Ouverture
                    </label>
                    <input id="openTime" name="openTime" type="time" style={inputStyle} />
                  </div>
                  <div style={formGroupStyle}>
                    <label htmlFor="closeTime" style={labelStyle}>
                      Fermeture
                    </label>
                    <input id="closeTime" name="closeTime" type="time" style={inputStyle} />
                  </div>
                </div>

                <div style={formGroupStyle}>
                  <label htmlFor="reason" style={labelStyle}>
                    Motif (facultatif)
                  </label>
                  <input
                    id="reason"
                    name="reason"
                    type="text"
                    placeholder="ex : Jour férié, inventaire, fermeture annuelle"
                    style={inputStyle}
                  />
                </div>

                <button type="submit" style={secondaryButtonStyle}>
                  Ajouter l’exception
                </button>
              </form>
            )}

            <div style={exceptionsListContainerStyle}>
              <h3 style={subheadingStyle}>Exceptions enregistrées ({exceptions.length})</h3>
              {exceptions.length === 0 ? (
                <p style={mutedTextStyle}>Aucune exception de calendrier configurée.</p>
              ) : (
                <div style={exceptionsListStyle}>
                  {exceptions.map((ex) => (
                    <div key={ex.id} style={exceptionCardStyle}>
                      <div style={exceptionInfoStyle}>
                        <div style={exceptionHeaderStyle}>
                          <strong style={exceptionDateStyle}>{ex.localDate}</strong>
                          <span style={ex.kind === 'CLOSED' ? closedBadgeStyle : openBadgeStyle}>
                            {ex.kind === 'CLOSED'
                              ? 'Fermé'
                              : `${ex.openTime?.slice(0, 5)} - ${ex.closeTime?.slice(0, 5)}`}
                          </span>
                        </div>
                        {ex.reason && <p style={exceptionReasonStyle}>{ex.reason}</p>}
                      </div>

                      {canManage && (
                        <form action={deleteException}>
                          <input type="hidden" name="exceptionId" value={ex.id} />
                          <button
                            type="submit"
                            style={deleteBtnStyle}
                            aria-label={`Supprimer l'exception du ${ex.localDate}`}
                          >
                            ✕
                          </button>
                        </form>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </aside>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  maxWidth: '1200px',
  margin: '0 auto',
  padding: '1.5rem',
  display: 'flex',
  flexDirection: 'column',
  gap: '1.5rem',
};

const headerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'flex-start',
};

const titleStyle: React.CSSProperties = {
  fontSize: '1.75rem',
  fontWeight: 700,
  color: '#0f172a',
  margin: 0,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: '0.95rem',
  color: '#64748b',
  margin: '0.25rem 0 0',
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 380px',
  gap: '1.5rem',
  alignItems: 'start',
};

const sideColumnStyle: React.CSSProperties = {
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
  fontSize: '1.1rem',
  fontWeight: 600,
  color: '#0f172a',
  margin: '0 0 1rem',
};

const subheadingStyle: React.CSSProperties = {
  fontSize: '0.9rem',
  fontWeight: 600,
  color: '#334155',
  margin: '1rem 0 0.5rem',
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

const exceptionFormStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.75rem',
  padding: '1rem',
  backgroundColor: '#f8fafc',
  borderRadius: '8px',
  border: '1px solid #e2e8f0',
};

const formGroupStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
};

const hoursRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 1fr',
  gap: '0.5rem',
};

const labelStyle: React.CSSProperties = {
  fontSize: '0.8rem',
  fontWeight: 600,
  color: '#334155',
};

const inputStyle: React.CSSProperties = {
  padding: '0.45rem 0.65rem',
  borderRadius: '6px',
  border: '1px solid #cbd5e1',
  fontSize: '0.85rem',
};

const submitRowStyle: React.CSSProperties = {
  marginTop: '1rem',
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

const secondaryButtonStyle: React.CSSProperties = {
  padding: '0.5rem 0.75rem',
  backgroundColor: '#ffffff',
  color: '#334155',
  border: '1px solid #cbd5e1',
  borderRadius: '6px',
  fontSize: '0.85rem',
  fontWeight: 500,
  cursor: 'pointer',
};

const mutedTextStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#64748b',
  margin: 0,
};

const exceptionsListContainerStyle: React.CSSProperties = {
  marginTop: '1.25rem',
};

const exceptionsListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const exceptionCardStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  padding: '0.6rem 0.75rem',
  backgroundColor: '#f8fafc',
  borderRadius: '6px',
  border: '1px solid #f1f5f9',
};

const exceptionInfoStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.2rem',
};

const exceptionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '0.5rem',
};

const exceptionDateStyle: React.CSSProperties = {
  fontSize: '0.85rem',
  color: '#0f172a',
};

const exceptionReasonStyle: React.CSSProperties = {
  fontSize: '0.75rem',
  color: '#64748b',
  margin: 0,
};

const closedBadgeStyle: React.CSSProperties = {
  padding: '0.1rem 0.4rem',
  borderRadius: '9999px',
  fontSize: '0.7rem',
  fontWeight: 600,
  backgroundColor: '#fee2e2',
  color: '#991b1b',
};

const openBadgeStyle: React.CSSProperties = {
  padding: '0.1rem 0.4rem',
  borderRadius: '9999px',
  fontSize: '0.7rem',
  fontWeight: 600,
  backgroundColor: '#e0f2fe',
  color: '#0369a1',
};

const deleteBtnStyle: React.CSSProperties = {
  backgroundColor: 'transparent',
  border: 'none',
  color: '#94a3b8',
  cursor: 'pointer',
  padding: '0.2rem 0.4rem',
  fontSize: '0.9rem',
};
