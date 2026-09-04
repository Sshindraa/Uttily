import React from 'react';
import { type OrganizationRecord, LEGAL_FORMS, getLegalFormLabel } from '@uttily/core';
import { Badge, Button, Card, Field, Input } from '@uttily/ui';
import styles from './company-settings.module.css';

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
  const isLegalComplete = !!(
    organization.legalName &&
    organization.registrationNumber &&
    organization.registeredOfficeCity &&
    organization.registeredOfficeAddress
  );

  return (
    <div className={styles.container}>
      {/* 1. Bannière de conformité juridique */}
      <div
        className={`${styles.statusCard} ${
          isLegalComplete ? styles.statusComplete : styles.statusIncomplete
        }`}
        role="status"
      >
        <span className={styles.statusIcon} aria-hidden="true">
          {isLegalComplete ? '🛡️' : '⚠️'}
        </span>
        <div className={styles.statusBody}>
          <h3 className={styles.statusTitle}>
            {isLegalComplete
              ? 'Identité juridique et fiscale vérifiée'
              : 'Informations d’immatriculation à compléter'}
          </h3>
          <p className={styles.statusText}>
            {isLegalComplete
              ? 'Votre entreprise dispose d’une immatriculation complète. Ces informations sont opposables sur vos contrats de location, mandats Stripe et factures clients.'
              : 'Pour émettre des contrats de location opposables et des factures en règle en France, renseignez votre numéro SIRET/SIREN et l’adresse de votre siège social.'}
          </p>
        </div>
      </div>

      {canManage ? (
        <form action={updateCompany} className={styles.form}>
          {/* 2. Identité commerciale & Raison sociale */}
          <Card
            as="section"
            aria-labelledby="commercial-heading"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ut-space-5)' }}
          >
            <div className={styles.cardHeader}>
              <h2 id="commercial-heading" className={styles.cardTitle}>
                Identité commerciale & Raison sociale
              </h2>
              <p className={styles.cardSubtitle}>
                Définit l’image de marque vue par les clients et la dénomination sociale légale.
              </p>
            </div>

            <div className={styles.row2}>
              <Field
                label="Nom affiché aux clients (Nom commercial)"
                htmlFor="publicDisplayName"
                help="Nom de votre enseigne sur les offres publiques et dans le tunnel de réservation."
              >
                <Input
                  id="publicDisplayName"
                  name="publicDisplayName"
                  type="text"
                  defaultValue={organization.publicDisplayName ?? ''}
                  placeholder={organization.legalName}
                />
              </Field>

              <Field
                label="Raison sociale officielle"
                htmlFor="legalName"
                help="Dénomination exacte enregistrée au registre du commerce."
              >
                <Input
                  id="legalName"
                  name="legalName"
                  type="text"
                  defaultValue={organization.legalName}
                  required
                  minLength={2}
                />
              </Field>
            </div>

            <div className={styles.row2}>
              <Field
                label="Forme juridique"
                htmlFor="legalForm"
                help="Structure de votre entreprise (SAS, SARL, EI, etc.)."
              >
                <select
                  id="legalForm"
                  name="legalForm"
                  defaultValue={organization.legalForm ?? 'SAS'}
                  className={styles.selectInput}
                >
                  {LEGAL_FORMS.map((form) => (
                    <option key={form} value={form}>
                      {getLegalFormLabel(form)}
                    </option>
                  ))}
                </select>
              </Field>

              <Field
                label="Représentant légal (Gérant / Président)"
                htmlFor="legalRepresentativeName"
                help="Nom et prénom de la personne physique habilitée à engager l’entreprise."
              >
                <Input
                  id="legalRepresentativeName"
                  name="legalRepresentativeName"
                  type="text"
                  defaultValue={organization.legalRepresentativeName ?? ''}
                  placeholder="Ex. Alexandre Dupont"
                />
              </Field>
            </div>
          </Card>

          {/* 3. Immatriculation & Fiscalité */}
          <Card
            as="section"
            aria-labelledby="registry-heading"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ut-space-5)' }}
          >
            <div className={styles.cardHeader}>
              <h2 id="registry-heading" className={styles.cardTitle}>
                Immatriculation & Fiscalité
              </h2>
              <p className={styles.cardSubtitle}>
                Mentions légales requises sur les factures et reçus de location émis en France.
              </p>
            </div>

            <div className={styles.row2}>
              <Field
                label="Numéro SIRET (14 chiffres) ou SIREN (9 chiffres)"
                htmlFor="registrationNumber"
                help="Identifiant officiel INSEE de votre établissement ou siège."
              >
                <Input
                  id="registrationNumber"
                  name="registrationNumber"
                  type="text"
                  defaultValue={organization.registrationNumber ?? ''}
                  placeholder="Ex. 732 829 320 00074"
                  autoComplete="off"
                />
              </Field>

              <Field
                label="Numéro de TVA intracommunautaire"
                htmlFor="vatNumber"
                help="Pour la France : commence par FR suivi de 11 caractères (ou laisser vide si franchise de TVA)."
              >
                <Input
                  id="vatNumber"
                  name="vatNumber"
                  type="text"
                  defaultValue={organization.vatNumber ?? ''}
                  placeholder="Ex. FR44732829320"
                  autoComplete="off"
                />
              </Field>
            </div>

            <div className={styles.row2}>
              <Field
                label="Ville du Greffe d’immatriculation (RCS)"
                htmlFor="registryCity"
                help="Tribunal de commerce d’enregistrement (ex. RCS Annecy, RCS Lyon)."
              >
                <Input
                  id="registryCity"
                  name="registryCity"
                  type="text"
                  defaultValue={organization.registryCity ?? ''}
                  placeholder="Ex. Annecy"
                />
              </Field>

              <Field
                label="Capital social (optionnel)"
                htmlFor="capitalAmount"
                help="Montant du capital pour les sociétés (ex. 10 000 €)."
              >
                <Input
                  id="capitalAmount"
                  name="capitalAmount"
                  type="text"
                  defaultValue={organization.capitalAmount ?? ''}
                  placeholder="Ex. 10 000 €"
                />
              </Field>
            </div>
          </Card>

          {/* 4. Siège social officiel */}
          <Card
            as="section"
            aria-labelledby="hq-heading"
            style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ut-space-5)' }}
          >
            <div className={styles.cardHeader}>
              <h2 id="hq-heading" className={styles.cardTitle}>
                Siège social officiel
              </h2>
              <p className={styles.cardSubtitle}>
                Adresse administrative officielle de l’entreprise (peut différer des boutiques de
                location).
              </p>
            </div>

            <Field
              label="Adresse du siège social"
              htmlFor="registeredOfficeAddress"
              help="Numéro et nom de voie (ex. 12 rue du Lac)."
            >
              <Input
                id="registeredOfficeAddress"
                name="registeredOfficeAddress"
                type="text"
                defaultValue={organization.registeredOfficeAddress ?? ''}
                placeholder="Ex. 10 Quai de la Tournette"
              />
            </Field>

            <div className={styles.row3}>
              <Field label="Code postal" htmlFor="registeredOfficePostalCode" help="5 chiffres.">
                <Input
                  id="registeredOfficePostalCode"
                  name="registeredOfficePostalCode"
                  type="text"
                  maxLength={5}
                  defaultValue={organization.registeredOfficePostalCode ?? ''}
                  placeholder="74000"
                />
              </Field>

              <Field label="Ville" htmlFor="registeredOfficeCity">
                <Input
                  id="registeredOfficeCity"
                  name="registeredOfficeCity"
                  type="text"
                  defaultValue={organization.registeredOfficeCity ?? ''}
                  placeholder="Annecy"
                />
              </Field>

              <Field label="Pays" htmlFor="registeredOfficeCountryCode">
                <Input
                  id="registeredOfficeCountryCode"
                  name="registeredOfficeCountryCode"
                  type="text"
                  maxLength={2}
                  defaultValue={organization.registeredOfficeCountryCode ?? 'FR'}
                  readOnly
                />
              </Field>
            </div>

            <div className={styles.submitRow}>
              <Button type="submit">Enregistrer les informations légales</Button>
            </div>
          </Card>
        </form>
      ) : (
        /* Mode lecture seule (utilisateurs STAFF / non-gestionnaires) */
        <Card
          as="section"
          aria-labelledby="view-heading"
          style={{ display: 'flex', flexDirection: 'column', gap: 'var(--ut-space-4)' }}
        >
          <h2 id="view-heading" className={styles.cardTitle}>
            Fiche légale de l’entreprise
          </h2>
          <div className={styles.readOnlyGrid}>
            <div className={styles.readOnlyItem}>
              <span className={styles.readOnlyLabel}>Raison sociale</span>
              <span className={styles.readOnlyValue}>{organization.legalName}</span>
            </div>
            <div className={styles.readOnlyItem}>
              <span className={styles.readOnlyLabel}>Forme juridique</span>
              <span className={styles.readOnlyValue}>
                {getLegalFormLabel(organization.legalForm)}
              </span>
            </div>
            <div className={styles.readOnlyItem}>
              <span className={styles.readOnlyLabel}>SIRET / SIREN</span>
              <span className={styles.readOnlyValue}>
                {organization.registrationNumber || 'Non renseigné'}
              </span>
            </div>
            <div className={styles.readOnlyItem}>
              <span className={styles.readOnlyLabel}>N° TVA</span>
              <span className={styles.readOnlyValue}>
                {organization.vatNumber || 'Non renseigné'}
              </span>
            </div>
            <div className={styles.readOnlyItem}>
              <span className={styles.readOnlyLabel}>Siège social</span>
              <span className={styles.readOnlyValue}>
                {organization.registeredOfficeCity
                  ? `${organization.registeredOfficeAddress ?? ''}, ${organization.registeredOfficePostalCode ?? ''} ${organization.registeredOfficeCity}`
                  : 'Non renseigné'}
              </span>
            </div>
            <div className={styles.readOnlyItem}>
              <span className={styles.readOnlyLabel}>Devise d’opération</span>
              <span className={styles.readOnlyValue}>
                {organization.defaultCurrency} <Badge tone="neutral">🔒 Fixée</Badge>
              </span>
            </div>
          </div>
        </Card>
      )}
    </div>
  );
}
