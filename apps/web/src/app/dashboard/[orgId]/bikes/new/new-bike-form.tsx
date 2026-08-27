'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { createBikeDraftAction } from '@/app/actions/products';
import styles from './new-bike.module.css';

interface CategoryOption {
  id: string;
  name: string;
}

interface NewBikeFormProps {
  organizationId: string;
  categories: CategoryOption[];
}

export function NewBikeForm({ organizationId, categories }: NewBikeFormProps): React.ReactElement {
  const router = useRouter();
  const [name, setName] = useState('');
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? '');
  const [size, setSize] = useState('M');
  const [description, setDescription] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      const formData = new FormData();
      formData.set('name', name);
      formData.set('categoryId', categoryId);
      formData.set('size', size);
      formData.set('description', description);

      const res = await createBikeDraftAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );

      if (!res.ok) {
        throw new Error(res.message || 'Erreur lors de la création du vélo.');
      }

      // Redirection immédiate vers le setup du vélo avec son bikeId réel
      router.push(`/dashboard/${organizationId}/bikes/${res.data.bikeId}/setup`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
      setIsLoading(false);
    }
  }

  return (
    <div className={styles.container}>
      <nav aria-label="Fil d’Ariane" className={styles.breadcrumb}>
        <Link href={`/dashboard/${organizationId}/bikes`} className={styles.breadcrumbLink}>
          ← Mes vélos
        </Link>
        <span>/</span>
        <span>Nouveau vélo</span>
      </nav>

      <div className={styles.card}>
        <div className={styles.stepHeader}>
          <span className={styles.stepBadge}>Étape 1 sur 5</span>
          <span className={styles.autosaveBadge}>Sauvegarde automatique activée</span>
        </div>

        <h1 className={styles.title}>🚲 Quel vélo proposez-vous ?</h1>
        <p className={styles.subtitle}>
          Renseignez le modèle de votre vélo. Dès cette étape validée, votre brouillon est sécurisé
          et vous pourrez reprendre sa configuration à tout moment.
        </p>

        {error && <div className={styles.errorAlert}>{error}</div>}

        <form onSubmit={handleSubmit} className={styles.form}>
          <div className={styles.formGroup}>
            <label htmlFor="bike-name" className={styles.label}>
              Nom commercial du vélo :
            </label>
            <input
              id="bike-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ex: Canyon Roadlite, Moustache Samedi 28..."
              className={styles.input}
              required
              disabled={isLoading}
            />
          </div>

          <div className={styles.row}>
            <div className={styles.formGroup}>
              <label htmlFor="bike-category" className={styles.label}>
                Catégorie :
              </label>
              <select
                id="bike-category"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                className={styles.input}
                required
                disabled={isLoading}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.formGroup}>
              <label htmlFor="bike-size" className={styles.label}>
                Taille / Version :
              </label>
              <input
                id="bike-size"
                type="text"
                value={size}
                onChange={(e) => setSize(e.target.value)}
                placeholder="ex: M, L, Taille Unique, Cadre Bas..."
                className={styles.input}
                required
                disabled={isLoading}
              />
            </div>
          </div>

          <div className={styles.formGroup}>
            <label htmlFor="bike-desc" className={styles.label}>
              Description pour les locataires :
            </label>
            <textarea
              id="bike-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Précisez les points forts : usage recommandé, confort, autonomie (VAE), antivol ou accessoires fournis..."
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
              {isLoading ? 'Création du brouillon…' : 'Continuer vers les photos →'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
