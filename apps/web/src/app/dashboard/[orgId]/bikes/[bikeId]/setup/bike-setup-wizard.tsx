'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import type { PhotoSlotType } from '@uttily/contracts';
import { MAX_BULK_INVENTORY_ITEMS } from '@uttily/contracts';
import { PhotoCoachModal } from '@/components/photo-coach/PhotoCoachModal';
import { updateProductAction, publishBikeFromSetupAction } from '@/app/actions/products';
import { saveDailyPricingPlanDraftAction } from '@/app/actions/pricing';
import { bulkCreateInventoryItemsAction } from '@/app/actions/inventory';
import {
  formatMoneyAmount,
  getPricingPlanTypeLabel,
  getPricingPlanUnitLabel,
  type PricingPlanType,
} from '@/lib/status-presentation';
import styles from './setup.module.css';

export type SetupStep = 'IDENTITY' | 'PHOTOS' | 'PRICING' | 'INVENTORY' | 'REVIEW';

export interface SetupBikeDTO {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  categoryName: string;
  variantId: string;
  variantName: string;
  photos: Array<{ id: string; publicId: string; sortOrder: number }>;
  isPhotosComplete: boolean;
  currentPriceEuros: number | null;
  pricingPlanType: PricingPlanType | null;
  pricingCurrency: string;
  draftPricingPlanId?: string | null | undefined;
  discountTiers?: Array<{ thresholdDays: number; discountPercent: number }> | undefined;
  inventoryCount: number;
  isPublicationReady: boolean;
  publicationFailures: string[];
}

interface BikeSetupWizardProps {
  organizationId: string;
  bike: SetupBikeDTO;
  initialStep: SetupStep;
  categories: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
}

const STEPS: Array<{ key: SetupStep; num: number; label: string }> = [
  { key: 'IDENTITY', num: 1, label: '1. Mon équipement' },
  { key: 'PHOTOS', num: 2, label: '2. Mes photos' },
  { key: 'PRICING', num: 3, label: '3. Mon tarif' },
  { key: 'INVENTORY', num: 4, label: '4. Mes exemplaires' },
  { key: 'REVIEW', num: 5, label: '5. Mettre en ligne' },
];

export function BikeSetupWizard({
  organizationId,
  bike,
  initialStep,
  categories,
  locations,
}: BikeSetupWizardProps): React.ReactElement {
  const router = useRouter();
  const [currentStep, setCurrentStep] = useState<SetupStep>(initialStep);

  // Étape 1 : Identité
  const [name, setName] = useState(bike.name);
  const [categoryId, setCategoryId] = useState(bike.categoryId);
  const [description, setDescription] = useState(bike.description);

  // Étape 2 : Photos
  const [activePhotoSlot, setActivePhotoSlot] = useState<PhotoSlotType | null>(null);

  // Étape 3 : Tarif
  const [dailyPrice, setDailyPrice] = useState(
    bike.currentPriceEuros !== null ? String(bike.currentPriceEuros) : '',
  );
  const [tier3, setTier3] = useState(
    String(bike.discountTiers?.find((t) => t.thresholdDays === 3)?.discountPercent ?? 10),
  );
  const [tier7, setTier7] = useState(
    String(bike.discountTiers?.find((t) => t.thresholdDays === 7)?.discountPercent ?? 20),
  );
  const [tier14, setTier14] = useState(
    String(bike.discountTiers?.find((t) => t.thresholdDays === 14)?.discountPercent ?? 30),
  );
  const hasNonDailyPricingPlan = bike.pricingPlanType !== null && bike.pricingPlanType !== 'DAILY';
  const displayedPricingPlanType: PricingPlanType = bike.pricingPlanType ?? 'DAILY';
  const displayedPrice = dailyPrice.trim()
    ? formatMoneyAmount(
        Math.round((parseFloat(dailyPrice.replace(',', '.')) || 0) * 100),
        bike.pricingCurrency,
      )
    : '—';

  // Étape 4 : Flotte
  const [fleetCount, setFleetCount] = useState(bike.inventoryCount > 0 ? bike.inventoryCount : 3);
  const [locationId, setLocationId] = useState(locations[0]?.id ?? '');

  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 1. Sauvegarde Étape Identité
  async function handleSaveIdentity(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.set('productId', bike.id);
      formData.set('name', name);
      formData.set('categoryId', categoryId);
      formData.set('description', description);

      const res = await updateProductAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!res.ok) throw new Error(res.message || 'Erreur lors de la sauvegarde.');

      setCurrentStep('PHOTOS');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    } finally {
      setIsLoading(false);
    }
  }

  // 3. Sauvegarde Étape Tarif
  async function handleSavePricing(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    if (hasNonDailyPricingPlan) {
      setError(
        `${getPricingPlanTypeLabel(displayedPricingPlanType)} déjà configuré. Cet assistant ne modifie que les tarifs journaliers.`,
      );
      return;
    }
    setError(null);
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.set('productId', bike.id);
      formData.set('variantId', bike.variantId);
      formData.set('dailyPriceEuros', dailyPrice);
      formData.set('currency', bike.pricingCurrency);
      formData.set(
        'internalLabel',
        `Tarif journalier ${formatMoneyAmount(
          Math.round((parseFloat(dailyPrice.replace(',', '.')) || 0) * 100),
          bike.pricingCurrency,
        )}`,
      );
      if (parseInt(tier3, 10) > 0) formData.set('tier3DiscountPercent', tier3);
      if (parseInt(tier7, 10) > 0) formData.set('tier7DiscountPercent', tier7);
      if (parseInt(tier14, 10) > 0) formData.set('tier14DiscountPercent', tier14);

      const res = await saveDailyPricingPlanDraftAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!res.ok) throw new Error(res.message || 'Erreur lors de la sauvegarde du tarif.');

      setCurrentStep('INVENTORY');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    } finally {
      setIsLoading(false);
    }
  }

  // 4. Sauvegarde Étape Flotte
  async function handleSaveInventory(e: React.FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    setIsLoading(true);
    try {
      // Si des exemplaires n'ont pas encore été créés, on les crée d'un coup
      if (bike.inventoryCount === 0 && fleetCount > 0) {
        const formData = new FormData();
        formData.set('productVariantId', bike.variantId);
        formData.set('currentLocationId', locationId);
        formData.set('count', String(fleetCount));
        formData.set('prefix', name.slice(0, 3).toUpperCase());

        const res = await bulkCreateInventoryItemsAction(
          organizationId,
          { ok: false, code: 'UNKNOWN', message: '' },
          formData,
        );
        if (!res.ok) throw new Error(res.message || 'Erreur lors de la création des exemplaires.');
      }

      setCurrentStep('REVIEW');
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
    } finally {
      setIsLoading(false);
    }
  }

  // 5. Mise en ligne finale
  async function handlePublish(): Promise<void> {
    setError(null);
    setIsLoading(true);
    try {
      const formData = new FormData();
      formData.set('productId', bike.id);
      if (bike.draftPricingPlanId) {
        formData.set('pricingPlanId', bike.draftPricingPlanId);
      }

      const res = await publishBikeFromSetupAction(
        organizationId,
        { ok: false, code: 'UNKNOWN', message: '' },
        formData,
      );
      if (!res.ok) throw new Error(res.message || 'Erreur lors de la mise en ligne.');

      router.push(`/dashboard/${organizationId}/bikes/${bike.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur inconnue.');
      setIsLoading(false);
    }
  }

  const heroPhoto = bike.photos[0];
  const threeQuarterPhoto = bike.photos[1];
  const signaturePhoto = bike.photos[2];
  const selectedLocation = locations.find((l) => l.id === locationId) ?? locations[0];

  return (
    <div className={styles.container}>
      {/* Barre supérieure */}
      <div className={styles.topBar}>
        <nav aria-label="Fil d’Ariane" className={styles.breadcrumb}>
          <Link href={`/dashboard/${organizationId}/bikes`} className={styles.breadcrumbLink}>
            ← Mes équipements
          </Link>
          <span>/</span>
          <span>Configuration : {bike.name}</span>
        </nav>

        <span className={styles.autosaveStatus}>
          <span>✓</span> Enregistré en direct
        </span>
      </div>

      {/* Stepper interactif */}
      <nav aria-label="Étapes de configuration" className={styles.stepper}>
        {STEPS.map((s) => {
          const isActive = currentStep === s.key;
          return (
            <button
              key={s.key}
              type="button"
              onClick={() => setCurrentStep(s.key)}
              className={`${styles.stepTab} ${isActive ? styles.stepTabActive : ''}`}
            >
              <span className={styles.stepNumber}>Étape {s.num}</span>
              <span className={styles.stepLabel}>{s.label}</span>
            </button>
          );
        })}
      </nav>

      {error && (
        <div
          style={{
            padding: '12px 16px',
            background: 'var(--ut-color-danger-soft)',
            border: '1px solid var(--ut-color-danger-soft)',
            color: 'var(--ut-color-danger)',
            borderRadius: '12px',
            fontSize: '0.88rem',
          }}
        >
          {error}
        </div>
      )}

      {/* ÉCRAN 1 : IDENTITÉ */}
      {currentStep === 'IDENTITY' && (
        <div className={styles.card}>
          <div className={styles.stepTitleArea}>
            <span className={styles.stepBadge}>Étape 1 sur 5</span>
            <h2 className={styles.stepTitle}>🧰 Quel équipement proposez-vous ?</h2>
            <p className={styles.stepSubtitle}>
              Précisez le nom de marque, la catégorie et la description commerciale de l’équipement.
            </p>
          </div>

          <form
            onSubmit={handleSaveIdentity}
            style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label
                htmlFor="step-name"
                style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--ut-color-ink)' }}
              >
                Nom du modèle :
              </label>
              <input
                id="step-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                disabled={isLoading}
                style={{
                  padding: '12px 16px',
                  border: '1.5px solid var(--ut-color-border-strong)',
                  borderRadius: '12px',
                  fontSize: '0.95rem',
                }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label
                htmlFor="step-cat"
                style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--ut-color-ink)' }}
              >
                Catégorie :
              </label>
              <select
                id="step-cat"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                required
                disabled={isLoading}
                style={{
                  padding: '12px 16px',
                  border: '1.5px solid var(--ut-color-border-strong)',
                  borderRadius: '12px',
                  fontSize: '0.95rem',
                }}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label
                htmlFor="step-desc"
                style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--ut-color-ink)' }}
              >
                Description pour les locataires :
              </label>
              <textarea
                id="step-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={4}
                required
                disabled={isLoading}
                style={{
                  padding: '12px 16px',
                  border: '1.5px solid var(--ut-color-border-strong)',
                  borderRadius: '12px',
                  fontSize: '0.95rem',
                  resize: 'vertical',
                }}
              />
            </div>

            <div className={styles.stepFooter}>
              <Link href={`/dashboard/${organizationId}/bikes`} className={styles.backBtn}>
                Quitter
              </Link>
              <button type="submit" disabled={isLoading} className={styles.primaryActionBtn}>
                {isLoading ? 'Enregistrement…' : 'Continuer vers les photos →'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ÉCRAN 2 : PHOTOS */}
      {currentStep === 'PHOTOS' && (
        <div className={styles.card}>
          <div className={styles.stepTitleArea}>
            <span className={styles.stepBadge}>Étape 2 sur 5</span>
            <h2 className={styles.stepTitle}>📸 Montrez votre équipement (Standard Photo Coach)</h2>
            <p className={styles.stepSubtitle}>
              Prenez 3 photos normées avec le guide de cadrage interactif pour garantir la confiance
              des locataires.
            </p>
          </div>

          <div className={styles.photosGrid}>
            {/* Slot 1 : Profil */}
            <div
              onClick={() => setActivePhotoSlot('HERO_PROFILE')}
              className={`${styles.photoSlotCard} ${heroPhoto ? styles.photoSlotCardFilled : ''}`}
            >
              {heroPhoto ? (
                <>
                  <img
                    src={`/api/public/product-photos/${heroPhoto.publicId}`}
                    alt="Profil"
                    className={styles.photoSlotThumbnail}
                  />
                  <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>1. Profil latéral Hero</div>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--ut-color-success)',
                      fontWeight: 700,
                    }}
                  >
                    ✓ Conforme
                  </span>
                </>
              ) : (
                <>
                  <div style={{ fontSize: '2.2rem' }}>🚲</div>
                  <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>1. Profil latéral Hero</div>
                  <span style={{ fontSize: '0.8rem', color: 'var(--ut-color-ink-muted)' }}>
                    Vue complète de profil
                  </span>
                  <button
                    type="button"
                    className={styles.primaryActionBtn}
                    style={{ fontSize: '0.82rem', padding: '6px 12px' }}
                  >
                    + Prendre la photo
                  </button>
                </>
              )}
            </div>

            {/* Slot 2 : 3/4 Avant */}
            <div
              onClick={() => setActivePhotoSlot('THREE_QUARTER_FRONT')}
              className={`${styles.photoSlotCard} ${threeQuarterPhoto ? styles.photoSlotCardFilled : ''}`}
            >
              {threeQuarterPhoto ? (
                <>
                  <img
                    src={`/api/public/product-photos/${threeQuarterPhoto.publicId}`}
                    alt="3/4 avant"
                    className={styles.photoSlotThumbnail}
                  />
                  <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>2. 3/4 Avant dynamique</div>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--ut-color-success)',
                      fontWeight: 700,
                    }}
                  >
                    ✓ Conforme
                  </span>
                </>
              ) : (
                <>
                  <div style={{ fontSize: '2.2rem' }}>📐</div>
                  <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>2. 3/4 Avant dynamique</div>
                  <span style={{ fontSize: '0.8rem', color: 'var(--ut-color-ink-muted)' }}>
                    Volume et poste de pilotage
                  </span>
                  <button
                    type="button"
                    className={styles.primaryActionBtn}
                    style={{ fontSize: '0.82rem', padding: '6px 12px' }}
                  >
                    + Prendre la photo
                  </button>
                </>
              )}
            </div>

            {/* Slot 3 : Vue libre */}
            <div
              onClick={() => setActivePhotoSlot('SECONDARY_VIEW')}
              className={`${styles.photoSlotCard} ${signaturePhoto ? styles.photoSlotCardFilled : ''}`}
            >
              {signaturePhoto ? (
                <>
                  <img
                    src={`/api/public/product-photos/${signaturePhoto.publicId}`}
                    alt="Détail"
                    className={styles.photoSlotThumbnail}
                  />
                  <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>
                    3. Vue libre valorisante
                  </div>
                  <span
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--ut-color-success)',
                      fontWeight: 700,
                    }}
                  >
                    ✓ Conforme
                  </span>
                </>
              ) : (
                <>
                  <div style={{ fontSize: '2.2rem' }}>✨</div>
                  <div style={{ fontWeight: 800, fontSize: '0.9rem' }}>
                    3. Vue libre valorisante
                  </div>
                  <span style={{ fontSize: '0.8rem', color: 'var(--ut-color-ink-muted)' }}>
                    Détail, écran ou transmission
                  </span>
                  <button
                    type="button"
                    className={styles.primaryActionBtn}
                    style={{ fontSize: '0.82rem', padding: '6px 12px' }}
                  >
                    + Prendre la photo
                  </button>
                </>
              )}
            </div>
          </div>

          <div className={styles.stepFooter}>
            <button
              type="button"
              onClick={() => setCurrentStep('IDENTITY')}
              className={styles.backBtn}
            >
              ← Retour
            </button>
            <button
              type="button"
              onClick={() => setCurrentStep('PRICING')}
              className={styles.primaryActionBtn}
            >
              Continuer vers le tarif →
            </button>
          </div>

          {activePhotoSlot && (
            <PhotoCoachModal
              orgId={organizationId}
              productId={bike.id}
              slotType={activePhotoSlot}
              isOpen={true}
              onClose={() => setActivePhotoSlot(null)}
              onPhotoUploaded={() => {
                setActivePhotoSlot(null);
                router.refresh();
              }}
            />
          )}
        </div>
      )}

      {/* ÉCRAN 3 : TARIFICATION */}
      {currentStep === 'PRICING' && (
        <div className={styles.card}>
          <div className={styles.stepTitleArea}>
            <span className={styles.stepBadge}>Étape 3 sur 5</span>
            <h2 className={styles.stepTitle}>🏷️ Quel est votre tarif de location ?</h2>
            <p className={styles.stepSubtitle}>
              {hasNonDailyPricingPlan
                ? `${getPricingPlanTypeLabel(displayedPricingPlanType)} déjà configuré. Cet assistant ne modifie que les tarifs journaliers.`
                : 'Fixez votre tarif journalier de base. Les réductions dégressives encouragent les locations longue durée.'}
            </p>
          </div>

          {hasNonDailyPricingPlan && (
            <div
              role="status"
              style={{
                padding: '14px 16px',
                background: 'var(--ut-color-surface)beb',
                border: '1px solid var(--ut-color-warning-soft)',
                color: 'var(--ut-color-warning)',
                borderRadius: '12px',
                fontSize: '0.9rem',
              }}
            >
              Le plan actif reste inchangé. Utilisez l’écran de gestion des plans flexibles pour
              modifier un tarif horaire ou un forfait.
            </div>
          )}

          <form
            onSubmit={handleSavePricing}
            style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label
                htmlFor="step-price"
                style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--ut-color-ink)' }}
              >
                {hasNonDailyPricingPlan
                  ? `${getPricingPlanTypeLabel(displayedPricingPlanType)} (${bike.pricingCurrency}) :`
                  : `Prix de base par jour (${bike.pricingCurrency} TTC) :`}
              </label>
              <input
                id="step-price"
                type="text"
                value={dailyPrice}
                onChange={(e) => setDailyPrice(e.target.value)}
                placeholder="25.00"
                required
                disabled={isLoading || hasNonDailyPricingPlan}
                style={{
                  padding: '12px 16px',
                  border: '1.5px solid var(--ut-color-border-strong)',
                  borderRadius: '12px',
                  fontSize: '1.1rem',
                  fontWeight: 800,
                }}
              />
            </div>

            {/* Paliers */}
            <div
              style={{
                background: 'var(--ut-color-surface-raised)',
                padding: '18px',
                borderRadius: '14px',
                border: '1px solid var(--ut-color-border)',
                display: 'flex',
                flexDirection: 'column',
                gap: '12px',
              }}
            >
              <strong style={{ fontSize: '0.9rem', color: 'var(--ut-color-ink)' }}>
                Réductions longue durée :
              </strong>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '10px',
                  alignItems: 'center',
                }}
              >
                <label
                  htmlFor="step-tier3"
                  style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}
                >
                  Dès 3 jours (% remise) :
                </label>
                <input
                  id="step-tier3"
                  type="number"
                  value={tier3}
                  onChange={(e) => setTier3(e.target.value)}
                  disabled={isLoading || hasNonDailyPricingPlan}
                  style={{
                    padding: '8px 12px',
                    border: '1.5px solid var(--ut-color-border-strong)',
                    borderRadius: '8px',
                  }}
                />
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '10px',
                  alignItems: 'center',
                }}
              >
                <label
                  htmlFor="step-tier7"
                  style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}
                >
                  Dès 7 jours (% remise) :
                </label>
                <input
                  id="step-tier7"
                  type="number"
                  value={tier7}
                  onChange={(e) => setTier7(e.target.value)}
                  disabled={isLoading || hasNonDailyPricingPlan}
                  style={{
                    padding: '8px 12px',
                    border: '1.5px solid var(--ut-color-border-strong)',
                    borderRadius: '8px',
                  }}
                />
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '10px',
                  alignItems: 'center',
                }}
              >
                <label
                  htmlFor="step-tier14"
                  style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}
                >
                  Dès 14 jours (% remise) :
                </label>
                <input
                  id="step-tier14"
                  type="number"
                  value={tier14}
                  onChange={(e) => setTier14(e.target.value)}
                  disabled={isLoading || hasNonDailyPricingPlan}
                  style={{
                    padding: '8px 12px',
                    border: '1.5px solid var(--ut-color-border-strong)',
                    borderRadius: '8px',
                  }}
                />
              </div>
            </div>

            <div className={styles.stepFooter}>
              <button
                type="button"
                onClick={() => setCurrentStep('PHOTOS')}
                className={styles.backBtn}
              >
                ← Retour
              </button>
              <button
                type={hasNonDailyPricingPlan ? 'button' : 'submit'}
                onClick={hasNonDailyPricingPlan ? () => setCurrentStep('INVENTORY') : undefined}
                disabled={isLoading}
                className={styles.primaryActionBtn}
              >
                {isLoading ? 'Enregistrement…' : 'Continuer vers la flotte →'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ÉCRAN 4 : FLOTTE */}
      {currentStep === 'INVENTORY' && (
        <div className={styles.card}>
          <div className={styles.stepTitleArea}>
            <span className={styles.stepBadge}>Étape 4 sur 5</span>
            <h2 className={styles.stepTitle}>🚲 Combien d’exemplaires avez-vous en stock ?</h2>
            <p className={styles.stepSubtitle}>
              Indiquez le nombre d’exemplaires disponibles dans votre boutique. Chaque exemplaire
              sera suivi individuellement.
            </p>
          </div>

          <form
            onSubmit={handleSaveInventory}
            style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}
          >
            <div className={styles.stepperRow}>
              <button
                type="button"
                onClick={() => setFleetCount((c) => Math.max(1, c - 1))}
                disabled={fleetCount <= 1 || isLoading}
                className={styles.counterBtn}
              >
                −
              </button>
              <span className={styles.counterValue}>{fleetCount}</span>
              <button
                type="button"
                onClick={() => setFleetCount((c) => Math.min(MAX_BULK_INVENTORY_ITEMS, c + 1))}
                disabled={fleetCount >= MAX_BULK_INVENTORY_ITEMS || isLoading}
                className={styles.counterBtn}
              >
                +
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label
                htmlFor="step-loc"
                style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--ut-color-ink)' }}
              >
                Boutique / Point de retrait :
              </label>
              <select
                id="step-loc"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
                required
                disabled={isLoading}
                style={{
                  padding: '12px 16px',
                  border: '1.5px solid var(--ut-color-border-strong)',
                  borderRadius: '12px',
                  fontSize: '0.95rem',
                }}
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </select>
            </div>

            <div className={styles.stepFooter}>
              <button
                type="button"
                onClick={() => setCurrentStep('PRICING')}
                className={styles.backBtn}
              >
                ← Retour
              </button>
              <button type="submit" disabled={isLoading} className={styles.primaryActionBtn}>
                {isLoading ? 'Création des exemplaires…' : 'Continuer vers la vérification →'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ÉCRAN 5 : VÉRIFICATION & MISE EN LIGNE */}
      {currentStep === 'REVIEW' && (
        <div className={styles.card}>
          <div className={styles.stepTitleArea}>
            <span className={styles.stepBadge}>Étape 5 sur 5</span>
            <h2 className={styles.stepTitle}>
              🎉 Votre équipement est prêt pour la mise en ligne !
            </h2>
            <p className={styles.stepSubtitle}>
              Vérifiez les informations avant de publier votre annonce sur Uttily.
            </p>
          </div>

          {/* Aperçu de l'offre */}
          <div className={styles.offerPreviewCard}>
            {heroPhoto ? (
              <img
                src={`/api/public/product-photos/${heroPhoto.publicId}`}
                alt={bike.name}
                className={styles.previewHeroImg}
              />
            ) : (
              <div
                style={{
                  height: '180px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--ut-color-surface-raised)',
                  color: 'var(--ut-color-ink-subtle)',
                }}
              >
                Aucune photo principale
              </div>
            )}

            <div className={styles.previewContent}>
              <div
                style={{ fontSize: '0.85rem', fontWeight: 700, color: 'var(--ut-color-primary)' }}
              >
                {bike.categoryName} • Version {bike.variantName}
              </div>
              <h3
                style={{
                  margin: 0,
                  fontSize: '1.3rem',
                  fontWeight: 900,
                  color: 'var(--ut-color-ink-strong)',
                }}
              >
                {bike.name}
              </h3>
              <div className={styles.previewPrice}>
                {displayedPrice}{' '}
                <span
                  style={{
                    fontSize: '0.9rem',
                    color: 'var(--ut-color-ink-muted)',
                    fontWeight: 600,
                  }}
                >
                  {getPricingPlanUnitLabel(displayedPricingPlanType)}
                </span>
              </div>
              <div style={{ fontSize: '0.85rem', color: 'var(--ut-color-ink-muted)' }}>
                📍 Disponible à {selectedLocation?.name ?? 'votre boutique'} ({fleetCount}{' '}
                exemplaires)
              </div>
            </div>
          </div>

          {/* Checklist de validation */}
          <div
            style={{
              background: 'var(--ut-color-surface-raised)',
              border: '1px solid var(--ut-color-border)',
              borderRadius: '16px',
              padding: '18px',
              display: 'flex',
              flexDirection: 'column',
              gap: '8px',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: 'var(--ut-color-success)',
                fontWeight: 700,
                fontSize: '0.9rem',
              }}
            >
              <span>✓</span> Nom et description commerciale complets
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: bike.isPhotosComplete
                  ? 'var(--ut-color-success)'
                  : 'var(--ut-color-warning)',
                fontWeight: 700,
                fontSize: '0.9rem',
              }}
            >
              <span>{bike.isPhotosComplete ? '✓' : '○'}</span> {bike.photos.length}/3 photos
              conformes au Standard Photo Coach
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: 'var(--ut-color-success)',
                fontWeight: 700,
                fontSize: '0.9rem',
              }}
            >
              <span>✓</span> {getPricingPlanTypeLabel(displayedPricingPlanType)} définie (
              {displayedPrice} {getPricingPlanUnitLabel(displayedPricingPlanType)})
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                color: 'var(--ut-color-success)',
                fontWeight: 700,
                fontSize: '0.9rem',
              }}
            >
              <span>✓</span> {fleetCount} exemplaire(s) physique(s) en service
            </div>
          </div>

          <div className={styles.stepFooter}>
            <button
              type="button"
              onClick={() => setCurrentStep('INVENTORY')}
              className={styles.backBtn}
            >
              ← Retour
            </button>
            <button
              type="button"
              onClick={handlePublish}
              disabled={isLoading || !bike.isPublicationReady}
              className={styles.primaryActionBtn}
              style={{
                background: 'var(--ut-color-success)',
                boxShadow: 'var(--ut-shadow-success)',
              }}
            >
              {isLoading ? 'Mise en ligne en cours…' : '🚀 Mettre en ligne mon équipement'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
