'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BIKE_SUBTYPE_DEFINITIONS,
  getBikeSubtypeLabel,
  normalizeBikeSubtype,
  type BikeSubtype,
} from '@uttily/contracts';
import Link from 'next/link';
import type { EquipmentEnrichmentProposal } from '@uttily/intelligence';
import { createFirstEquipmentDraftAction } from '@/app/actions/products';
import {
  getCategoryDisplayLabel,
  getCategoryPresentation,
} from '@/features/equipment/category-presentation';
import { ScanAndListZone } from './components/scan-and-list-zone';
import styles from './new-bike.module.css';

interface CategoryOption {
  id: string;
  name: string;
  slug: string;
}

interface NewBikeFormProps {
  organizationId: string;
  categories: CategoryOption[];
}

const STEPS = [
  { num: 1, label: 'Équipement', active: true },
  { num: 2, label: 'Exemplaires & Lieux', active: false },
  { num: 3, label: 'Tarification', active: false },
  { num: 4, label: 'Photos', active: false },
  { num: 5, label: 'Publication', active: false },
];

export function NewBikeForm({ organizationId, categories }: NewBikeFormProps): React.ReactElement {
  const router = useRouter();
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [bikeSubtype, setBikeSubtype] = useState<BikeSubtype | ''>('');
  const [variantName, setVariantName] = useState('');
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedCategory = categories.find((category) => category.id === categoryId);
  const categoryPresentation = getCategoryPresentation(selectedCategory?.slug);

  function handleProposal(proposal: EquipmentEnrichmentProposal): void {
    const brand = proposal.brand.value?.trim() || '';
    const model = proposal.model.value?.trim() || '';
    const fullName = [brand, model].filter(Boolean).join(' ');
    if (fullName) {
      setName(fullName);
    }

    if (proposal.categorySlug.value) {
      const proposedBikeSubtype = normalizeBikeSubtype(proposal.categorySlug.value);
      const bikeCategory = categories.find((category) => category.slug === 'bike');
      if (proposedBikeSubtype && bikeCategory) {
        setCategoryId(bikeCategory.id);
        setBikeSubtype(proposedBikeSubtype);
      }
      const slugLower = proposal.categorySlug.value.toLowerCase();
      const matched = categories.find((c) => c.slug.toLowerCase() === slugLower);
      if (matched) {
        setCategoryId(matched.id);
        if (matched.slug !== 'bike') setBikeSubtype('');
      }
    }

    if (proposal.frameSize.value && (proposal.frameSize.confidence ?? 0) >= 0.5) {
      setVariantName(proposal.frameSize.value.trim());
    }

    if (proposal.marketingDescriptionFr.value) {
      setDescription(proposal.marketingDescriptionFr.value.trim());
    }
  }

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const formData = new FormData();
      formData.set('name', name);
      formData.set('categoryId', categoryId);
      if (selectedCategory?.slug === 'bike' && bikeSubtype) {
        formData.set('bikeSubtype', bikeSubtype);
      }
      if (variantName.trim()) formData.set('variantName', variantName.trim());
      formData.set('description', description);

      const res = await createFirstEquipmentDraftAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );

      if (!res.ok) {
        throw new Error(res.message || 'Erreur lors de la création de l’équipement.');
      }

      router.push(`/dashboard/${organizationId}/bikes/${res.data.equipmentId}/setup`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
      setIsLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      {/* Barre supérieure : navigation et état de sauvegarde */}
      <div className={styles.topBar}>
        <nav aria-label="Fil d’Ariane" className={styles.breadcrumb}>
          <Link href={`/dashboard/${organizationId}/bikes`} className={styles.breadcrumbLink}>
            ← Mes équipements
          </Link>
          <span>/</span>
          <span>Premier équipement</span>
        </nav>

        <div className={styles.autosaveBadge}>
          <span className={styles.autosaveDot} />
          <span>Brouillon automatique actif</span>
        </div>
      </div>

      {/* Stepper de parcours professionnel */}
      <nav aria-label="Étapes de configuration" className={styles.stepper}>
        {STEPS.map((step, index) => (
          <div key={step.num} style={{ display: 'flex', alignItems: 'center', gap: 'inherit' }}>
            <div className={`${styles.stepItem} ${step.active ? styles.stepItemActive : ''}`}>
              <span
                className={`${styles.stepNumber} ${step.active ? styles.stepNumberActive : ''}`}
              >
                {step.num}
              </span>
              <span>{step.label}</span>
            </div>
            {index < STEPS.length - 1 && <div className={styles.stepSeparator} />}
          </div>
        ))}
      </nav>

      <div className={styles.mainGrid}>
        {/* Colonne gauche : Formulaire principal */}
        <div className={styles.card}>
          <div className={styles.stepHeader}>
            <span className={styles.stepBadge}>Étape 1 · Catégorie, produit et variante</span>
            <h1 className={styles.title}>Quel équipement proposez-vous ?</h1>
            <p className={styles.subtitle}>
              Renseignez la famille, le nom commercial et votre première variante. Vous compléterez
              ensuite les exemplaires, le tarif et les photos dans les étapes suivantes.
            </p>
          </div>

          <ScanAndListZone organizationId={organizationId} onProposal={handleProposal} />

          {error && <div className={styles.errorAlert}>{error}</div>}

          <form onSubmit={handleSubmit} className={styles.form}>
            {/* Sélection de catégorie avec puces rapides et sélecteur accessible */}
            <div className={styles.formGroup}>
              <label htmlFor="equipment-category" className={styles.label}>
                <span>Catégorie d’activité</span>
              </label>

              <div className={styles.categoryChipsGrid}>
                {categories.slice(0, 8).map((c) => {
                  const pres = getCategoryPresentation(c.slug);
                  const isSelected = c.id === categoryId;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => {
                        setCategoryId(c.id);
                        if (c.slug !== 'bike') setBikeSubtype('');
                      }}
                      className={`${styles.categoryChip} ${isSelected ? styles.categoryChipActive : ''}`}
                    >
                      <span>{pres.icon}</span>
                      <span>{getCategoryDisplayLabel(c.slug, c.name)}</span>
                    </button>
                  );
                })}
              </div>

              <select
                id="equipment-category"
                value={categoryId}
                onChange={(e) => {
                  const nextCategoryId = e.target.value;
                  setCategoryId(nextCategoryId);
                  if (categories.find((c) => c.id === nextCategoryId)?.slug !== 'bike') {
                    setBikeSubtype('');
                  }
                }}
                className={styles.input}
                style={{ marginTop: '0.5rem' }}
                required
                disabled={isLoading}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {getCategoryDisplayLabel(c.slug, c.name)}
                  </option>
                ))}
              </select>
            </div>

            {selectedCategory?.slug === 'bike' ? (
              <div className={styles.formGroup}>
                <label htmlFor="equipment-bike-subtype" className={styles.label}>
                  <span>Type de vélo</span>
                  <span className={styles.optionalTag}>Optionnel</span>
                </label>
                <select
                  id="equipment-bike-subtype"
                  value={bikeSubtype}
                  onChange={(e) => setBikeSubtype(e.target.value as BikeSubtype | '')}
                  className={styles.input}
                  disabled={isLoading}
                >
                  <option value="">À préciser plus tard</option>
                  {BIKE_SUBTYPE_DEFINITIONS.map((definition) => (
                    <option key={definition.slug} value={definition.slug}>
                      {getBikeSubtypeLabel('fr', definition.slug)}
                    </option>
                  ))}
                </select>
                <span className={styles.helpText}>
                  Ce choix permet aux locataires de retrouver précisément ce vélo dans la recherche.
                </span>
              </div>
            ) : null}

            {/* Nom commercial */}
            <div className={styles.formGroup}>
              <label htmlFor="equipment-name" className={styles.label}>
                <span>Nom commercial de l’équipement</span>
              </label>
              <input
                id="equipment-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="ex : Kayak de randonnée, VTT Tout Suspendu, Tente 2 places..."
                className={styles.input}
                required
                disabled={isLoading}
              />
            </div>

            {/* Variante initiale */}
            <div className={styles.formGroup}>
              <label htmlFor="equipment-variant" className={styles.label}>
                <span>Variante initiale (facultatif)</span>
                <span className={styles.optionalTag}>Optionnel</span>
              </label>
              <input
                id="equipment-variant"
                type="text"
                value={variantName}
                onChange={(e) => setVariantName(e.target.value)}
                placeholder="ex : Standard, Taille M, Modèle Tandem..."
                className={styles.input}
                disabled={isLoading}
              />
              <span className={styles.helpText}>
                Laisser vide crée la variante « Standard ». Utile pour distinguer une taille, une
                puissance ou une déclinaison.
              </span>
            </div>

            {/* Carte informative sur les caractéristiques optionnelles */}
            <div role="status" className={styles.categoryInfoCard}>
              <span className={styles.categoryInfoIcon} aria-hidden="true">
                ℹ️
              </span>
              <div>
                <strong>Spécificités {categoryPresentation.pluralLabel} : </strong>
                {categoryPresentation.characteristics.length > 0
                  ? `Vous pourrez enrichir votre fiche avec : ${categoryPresentation.characteristics
                      .map((c) => c.label)
                      .join(', ')}. Ces caractéristiques restent facultatives.`
                  : `Présentation fluide et optimisée pour ${categoryPresentation.singularLabel}, sans contrainte technique imposée.`}
              </div>
            </div>

            {/* Description pour les locataires */}
            <div className={styles.formGroup}>
              <label htmlFor="bike-desc" className={styles.label}>
                <span>Description pour les locataires</span>
              </label>
              <textarea
                id="bike-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Précisez les points forts : usage recommandé, confort, autonomie, accessoires fournis..."
                className={styles.textarea}
                rows={4}
                required
                disabled={isLoading}
              />
              <span className={styles.helpText}>
                Une description détaillée rassure les clients et réduit les questions avant
                réservation.
              </span>
            </div>

            {/* Pied de formulaire */}
            <div className={styles.footer}>
              <Link href={`/dashboard/${organizationId}/bikes`} className={styles.cancelBtn}>
                Annuler
              </Link>
              <button type="submit" disabled={isLoading} className={styles.primaryBtn}>
                {isLoading ? 'Création du brouillon…' : 'Continuer vers la configuration →'}
              </button>
            </div>
          </form>
        </div>

        {/* Colonne droite : Aperçu en direct & Conseils */}
        <aside className={styles.sideCol} aria-label="Aperçu et conseils">
          <div className={styles.previewCard}>
            <div className={styles.previewHeader}>
              <span className={styles.previewTitle}>Aperçu de votre fiche</span>
              <span className={styles.previewBadgeLive}>En direct</span>
            </div>

            <div className={styles.previewMockCard}>
              <div className={styles.previewPhotoBox}>
                <span className={styles.previewPhotoIcon} aria-hidden="true">
                  📷
                </span>
                <span>Photos ajoutées à l’étape 4</span>
              </div>

              <div className={styles.previewContent}>
                <span className={styles.previewItemCategory}>
                  {categoryPresentation.icon}{' '}
                  {selectedCategory
                    ? getCategoryDisplayLabel(selectedCategory.slug, selectedCategory.name)
                    : 'Équipement'}
                </span>
                <div className={styles.previewItemName}>
                  {name.trim() ? name : 'Nom de votre équipement'}
                </div>
                <div className={styles.previewItemVariant}>
                  Variante : {variantName.trim() ? variantName : 'Standard'}
                </div>
                <p className={styles.previewItemDesc}>
                  {description.trim()
                    ? description
                    : 'La description saisie apparaîtra ici telle que présentée aux locataires lors de leur recherche.'}
                </p>
              </div>
            </div>
          </div>

          <div className={styles.proTipCard}>
            <div className={styles.proTipHeader}>
              <span aria-hidden="true">💡</span>
              <span>Conseil Pro Uttily</span>
            </div>
            <p className={styles.proTipText}>
              Les équipements dont le nom commercial inclut la marque et le modèle précis génèrent{' '}
              <strong>jusqu’à 35 % de réservations supplémentaires</strong> grâce à une meilleure
              visibilité dans les résultats de recherche.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
