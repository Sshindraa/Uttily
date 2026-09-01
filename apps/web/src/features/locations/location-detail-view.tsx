import type {
  LocationRecord,
  LocationScheduleExceptionRecord,
  OpeningHourInput,
} from '@uttily/core';
import { Badge, Button, Card, Input, PageHeader, Select } from '@uttily/ui';
import { LocationFormFields } from './location-form-fields';
import styles from './location-detail.module.css';

export interface LocationDetailViewProps {
  location: LocationRecord;
  openingHours: OpeningHourInput[];
  exceptions: LocationScheduleExceptionRecord[];
  canManage: boolean;
  updateLocation: (formData: FormData) => void | Promise<void>;
  addException: (formData: FormData) => void | Promise<void>;
  deleteException: (formData: FormData) => void | Promise<void>;
}

export function LocationDetailView({
  location,
  openingHours,
  exceptions,
  canManage,
  updateLocation,
  addException,
  deleteException,
}: LocationDetailViewProps): React.ReactElement {
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
