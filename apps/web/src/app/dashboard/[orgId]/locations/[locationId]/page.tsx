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
import { Badge, Button, Card, Input, PageHeader, Select } from '@uttily/ui';
import { LocationFormFields } from '../location-form-fields';
import { parseLocationFormData } from '../location-form';
import styles from './location-detail.module.css';

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
    <div className={styles.page}>
      <PageHeader
        eyebrow="Points de vente & ateliers"
        title={location.name}
        description="Configurez les informations, coordonnées et horaires d’ouverture de cet établissement."
      />

      <div className={styles.grid}>
        {/* Formulaire principal */}
        <Card as="section" aria-labelledby="general-heading" className={styles.card}>
          <h2 id="general-heading" className={styles.sectionTitle}>
            Informations et horaires habituels
          </h2>
          {canManage ? (
            <form action={updateLocation} className={styles.form}>
              <LocationFormFields location={location} openingHours={openingHours} />
              <div className={styles.submitRow}>
                <Button type="submit">Enregistrer les modifications</Button>
              </div>
            </form>
          ) : (
            <p className={styles.mutedText}>
              Lecture seule. Rôle insuffisant pour modifier cet établissement.
            </p>
          )}
        </Card>

        {/* Colonne latérale : Fermetures & Horaires exceptionnels */}
        <aside className={styles.sideColumn}>
          <Card as="section" aria-labelledby="exceptions-heading" className={styles.card}>
            <h2 id="exceptions-heading" className={styles.sectionTitle}>
              Fermetures et horaires exceptionnels
            </h2>
            <p className={styles.helpText}>
              Ces exceptions remplacent les horaires habituels pour la date indiquée. Elles bloquent
              ou ajustent les nouvelles réservations sans altérer les réservations confirmées
              existantes.
            </p>

            {canManage && (
              <form action={addException} className={styles.exceptionForm}>
                <div className={styles.formGroup}>
                  <label htmlFor="localDate">Date (AAAA-MM-JJ)</label>
                  <Input id="localDate" name="localDate" type="date" required />
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="kind">Type d’exception</label>
                  <Select id="kind" name="kind" defaultValue="CLOSED">
                    <option value="CLOSED">Fermé toute la journée</option>
                    <option value="OPEN_INTERVAL">Horaires spéciaux</option>
                  </Select>
                </div>

                <div className={styles.hoursRow}>
                  <div className={styles.formGroup}>
                    <label htmlFor="openTime">Ouverture</label>
                    <Input id="openTime" name="openTime" type="time" />
                  </div>
                  <div className={styles.formGroup}>
                    <label htmlFor="closeTime">Fermeture</label>
                    <Input id="closeTime" name="closeTime" type="time" />
                  </div>
                </div>

                <div className={styles.formGroup}>
                  <label htmlFor="reason">Motif (facultatif)</label>
                  <Input
                    id="reason"
                    name="reason"
                    type="text"
                    placeholder="ex : Jour férié, inventaire, fermeture annuelle"
                  />
                </div>

                <Button type="submit" variant="secondary" size="sm">
                  Ajouter l’exception
                </Button>
              </form>
            )}

            <div className={styles.exceptionListContainer}>
              <h3 className={styles.subheading}>Exceptions enregistrées ({exceptions.length})</h3>
              {exceptions.length === 0 ? (
                <p className={styles.mutedText}>Aucune exception de calendrier configurée.</p>
              ) : (
                <div className={styles.exceptionsList}>
                  {exceptions.map((ex) => (
                    <div key={ex.id} className={styles.exceptionCard}>
                      <div className={styles.exceptionInfo}>
                        <div className={styles.exceptionHeader}>
                          <strong className={styles.exceptionDate}>{ex.localDate}</strong>
                          <Badge tone={ex.kind === 'CLOSED' ? 'danger' : 'info'}>
                            {ex.kind === 'CLOSED'
                              ? 'Fermé'
                              : `${ex.openTime?.slice(0, 5)} - ${ex.closeTime?.slice(0, 5)}`}
                          </Badge>
                        </div>
                        {ex.reason && <p className={styles.exceptionReason}>{ex.reason}</p>}
                      </div>

                      {canManage && (
                        <form action={deleteException}>
                          <input type="hidden" name="exceptionId" value={ex.id} />
                          <Button
                            type="submit"
                            variant="quiet"
                            size="sm"
                            style={{
                              color: 'var(--ut-color-danger)',
                              minHeight: '36px',
                              paddingInline: 'var(--ut-space-2)',
                            }}
                            aria-label={`Supprimer l'exception du ${ex.localDate}`}
                          >
                            ✕
                          </Button>
                        </form>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </Card>
        </aside>
      </div>
    </div>
  );
}
