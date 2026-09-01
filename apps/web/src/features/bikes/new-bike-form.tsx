'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createFirstEquipmentDraftAction } from '@/app/actions/products';
import {
  getCategoryDisplayLabel,
  getCategoryPresentation,
} from '@/features/equipment/category-presentation';
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

export function NewBikeForm({ organizationId, categories }: NewBikeFormProps): React.ReactElement {
  const router = useRouter();
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [variantName, setVariantName] = useState('');
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedCategory = categories.find((category) => category.id === categoryId);
  const categoryPresentation = getCategoryPresentation(selectedCategory?.slug);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const formData = new FormData();
      formData.set('name', name);
      formData.set('categoryId', categoryId);
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
      <nav aria-label="Fil d’Ariane" className={styles.breadcrumb}>
        <Link href={`/dashboard/${organizationId}/bikes`} className={styles.breadcrumbLink}>
          ← Mes équipements
        </Link>
        <span>/</span>
        <span>Premier équipement</span>
      </nav>

      <div className={styles.card}>
        <div className={styles.stepHeader}>
          <span className={styles.stepBadge}>Étape 1 · Catégorie, produit et variante</span>
          <span className={styles.autosaveBadge}>Sauvegarde automatique activée</span>
        </div>

        <h1 className={styles.title}>🧰 Quel équipement proposez-vous ?</h1>
        <p className={styles.subtitle}>
          Choisissez une famille active, renseignez votre produit et sa variante initiale. Le
          brouillon sera ensuite complété avec un exemplaire, un lieu, un tarif et trois photos.
        </p>

        {error && <div className={styles.errorAlert}>{error}</div>}

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.formGroup}>
            <label htmlFor="equipment-name" className={styles.label}>
              Nom commercial de l’équipement :
            </label>
            <input
              id="equipment-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex : Kayak de randonnée, tente 2 places..."
              className={styles.input}
              required
              disabled={isLoading}
            />
          </div>

          <div className={styles.row}>
            <div className={styles.formGroup}>
              <label htmlFor="equipment-category" className={styles.label}>
                Catégorie :
              </label>
              <select
                id="equipment-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className={styles.input}
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

            <div className={styles.formGroup}>
              <label htmlFor="equipment-variant" className={styles.label}>
                Variante initiale (facultatif) :
              </label>
              <input
                id="equipment-variant"
                type="text"
                value={variantName}
                onChange={(e) => setVariantName(e.target.value)}
                placeholder="ex. Standard, M, Tandem, Version renforcée…"
                className={styles.input}
                disabled={isLoading}
              />
              <span style={{ fontSize: '0.82rem', color: 'var(--ut-color-ink-muted)' }}>
                Laisser vide crée la variante « Standard ». Aucune caractéristique technique n’est
                imposée par ce parcours.
              </span>
            </div>
          </div>

          <div
            role="status"
            style={{
              padding: '12px 14px',
              borderRadius: '10px',
              background: 'var(--ut-color-surface-raised)',
              color: 'var(--ut-color-ink-muted)',
              fontSize: '0.85rem',
            }}
          >
            {categoryPresentation.characteristics.length > 0
              ? `Caractéristiques affichables pour ${categoryPresentation.singularLabel} : ${categoryPresentation.characteristics.map((characteristic) => characteristic.label).join(', ')}. Elles restent facultatives.`
              : `Présentation générique pour ${categoryPresentation.singularLabel}, sans caractéristique obligatoire.`}
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="bike-desc" className={styles.label}>
              Description pour les locataires :
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
          </div>

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
    </div>
  );
}
